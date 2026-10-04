/**
 * #谁在打游戏 —— 列出本群谁正在对局、谁在线。
 *
 * 数据来自观测快照（GameRecordPush.yaml 里每个订阅项的几个 lastXxx 字段）：
 *   lastGaming      最近一次观测到在不在**对局**中（'1' / ''）—— 只认战绩列表的 isGaming
 *   lastGamingHero  在对局时用的英雄 heroId
 *   lastOnlineState 营地的 gameOnline 三态（0 离线 / 1 在线 / 2 游戏中）
 *   lastSeenAt      这份快照的观测时刻，用来判数据够不够新
 *
 * 注意 lastGaming 与 lastOnlineState=2 是**两件事**：后者只表示游戏客户端开着
 * （大厅、匹配中、翻战绩都算 2），不等于在对局。图上因此分「正在对局」和
 * 「客户端在线」两组，后者的人没有英雄可显示。
 *
 * 快照有两个来源：
 * - 开过战绩推送 / 上下线提醒的人 → 常驻轮询每轮顺手写（apps/gameRecordPush.js），
 *   但那一路有离线退避（判成离线就跳几轮），刚上线的人最坏能滞后十分钟
 * - 名单里的其他人（绑了营地号、但什么推送都没开）→ **不常驻查**，由这条指令触发时现刷
 *
 * ⚠️ **2026-09-20 起这条指令对名单里的人一律现刷**（原先只刷其中一部分，发起人自己
 * 另开小灶）。理由是账号池已经到 8 个（`utils/api.js` 按账号分队列并发，实际速率
 * 约 6~7 个请求/秒），一个群几十个请求几秒就跑完；而「发指令看的却还是十分钟前的
 * 状态」比多打几个请求难受得多。常驻轮询那边**不变**，退避照旧 —— 省配额靠的是
 * 「没人看就不查」，不是「有人看也只给旧数据」。
 *
 * 刷不到就退回旧快照，超过 STALE_MS 的那条在文案里标「数据较旧」。
 * ⚠️ 但现刷的结果**只在内存里给本次出图用、不落盘** —— 订阅项里那几个 lastXxx
 * 同时是推送那条链的状态机，见 refreshSnapshots 的注释。
 *
 * 英雄名走官网 herolist.json（getHeroNameMap，6 小时内存缓存），不碰营地接口。
 *
 * 出图走 WhoIsPlaying.html（视觉与战报同源），渲染失败时回落到纯文字名单。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { loadPushList, subGroups, getHeroNameMap, normalizeName, ONLINE_LABEL, collectSnapshot } from '../utils/pushStore.js'
import { membersOfGroup, isIndexReady, refreshGroupIndex } from '../utils/groupIndex.js'
import { mapConcurrent } from '../utils/parallel.js'
import { getImgType, Button, shouldQuote, getUserAvatar, getGroupAvatar, isBlackUser, isProfileHidden, getCurrentId, ApiService } from '#utils'
import { heroIconUrl } from '../utils/reportStore.js'

/** 快照超过这个时长就在文案里标「数据较旧」，单位毫秒。对着常驻轮询那档封顶（十分钟一轮）定的 */
const STALE_MS = 15 * 60 * 1000

/**
 * 现刷的门限：快照比这新就直接用，不再重新查。
 *
 * 60 秒是**唯一的防刷闸门**（名单里的人现在一律现刷，见文件头），
 * 作用是挡住「连点这条指令」——同一分钟内连发几次只有第一次真的打请求。
 *
 * 原先写的是 10 分钟（那会儿只刷影子订阅、还怕烧配额），现在账号池够宽，
 * 门限再开那么大就等于「发了指令还是看十分钟前的状态」，白瞎了现刷。
 */
const REFRESH_COOLDOWN_MS = 60 * 1000

/**
 * 单次最多现刷几个人。每人一次 profile（在打的人再加一次战绩列表）。
 * 采集是**多路并发**的，路数取决于池里有几个可用账号（见 refreshSnapshots）：
 * 8 个账号约 6~7 个请求/秒，40 人 6 秒左右就能刷完。
 * 超出的按「快照最旧」优先刷，剩下的用旧数据出图（会带「数据较旧」标记）。
 */
const MAX_REFRESH = 40

/**
 * 名单里「没有订阅记录」的人用的默认订阅项。
 *
 * ⚠️ `battle` / `online` 必须**显式写 false**，不能给个空对象：
 * `collectSnapshot` 里 `battleOn = sub?.battle !== false` 对 `{}` 会算成 true，
 * 于是每个人都白多拉一次战绩列表（名单里大多数人根本没订阅推送）。
 * 显式 false 之后 `needBattleList` 只在「游戏中 / 刚下线」时才补拉，
 * 与改动前影子订阅的行为一致。
 */
const NO_SUB = Object.freeze({ battle: false, online: false })

/** 现刷并发锁：一次只允许一条指令在刷，避免几个人同时发把请求量翻倍 */
let refreshing = false

/**
 * 「上次现刷时刻」，qq → 毫秒。
 *
 * 现刷**不落盘**（理由见 refreshSnapshots），所以 REFRESH_COOLDOWN_MS 这个门限
 * 没法靠订阅项里的 lastSeenAt 记（那是常驻轮询写的），得自己在内存里记一份。
 * 进程重启后丢失，等于放行一次全量刷，无所谓。
 */
const lastRefreshAt = new Map()

/**
 * 「上次现刷到的字段」，qq → patch。门限内复用同一份，避免「第二个人发指令反而
 * 看到更旧的状态」（现刷不落盘，盘上那份只有常驻轮询写过）。
 * 和 lastRefreshAt 一起清、一起涨，上限见 refreshSnapshots 收尾那几行。
 */
const lastRefreshPatch = new Map()

/**
 * 「刚打完」的展示窗口：对局结束后这么久之内还单独列一组。
 *
 * 别看太久——一轮轮询最多间隔十分钟（退避封顶），窗口开太大就会出现
 * 「明明已经打下一局了，上一条还挂在刚打完里」。
 */
const ENDED_WINDOW = 30 * 60 * 1000

export class WhoIsPlaying extends plugin {
  constructor () {
    super({
      name: '王者谁在打游戏',
      dsc: '看本群谁在对局、谁在线（查看时现刷）',
      event: 'message',
      // 同 gameRecordPush：完整锚定的短指令要抢在 queryGameStats 的宽匹配前面
      priority: 0,
      rule: [
        {
          reg: '^#(谁在(打游戏|打王者|玩王者|上号|排位)|王者在线(列表|状态)?|在线列表)$',
          fnc: 'list'
        }
      ]
    })
  }

  async list (e) {
    // 谁属于本群：**以群成员索引为准**（群成员表 ∩ 已绑定营地ID，见 utils/groupIndex.js）。
    //
    // 这是这份名单唯一的归属判据，早先那套「订阅项的 group 字段 + onlineStatus 兜底」
    // 有两个致命问题，都实测发生过：
    //   ① 一个人只有单个 `group` 字段，在 A 群开的在线状态会漏到 B 群（R 群里曾列出
    //      19 个压根不在 R 群的号）；
    //   ② 退群的人绑着营地ID 就一直赖在名单里，谁也弄不出去。
    // 换成索引后，退群的人不在成员表里 → 自然出表，不需要任何额外清理逻辑。
    //
    // ⚠️ 名单**不再读订阅表决定「谁在里面」**（2026-09-26 改）。早先名单 = 订阅表记录
    //    ∩ 本群成员，而「绑了营地号但没开任何推送」的人靠定时任务每轮自动补建的
    //    「影子订阅」垫进来 —— 那段补建要遍历每个群 × 每个群成员，是定时任务卡死的
    //    头号根因，已整套废除。名单本来就能从索引现算，不需要任何记录垫底。
    //    订阅表现在只提供两件事：快照字段、以及「这个人隐身了吗」。
    //
    // 索引拿不到时（冷启动适配器还没连上）回落到旧判据，宁可多列几个也不能把
    // 本群的人判成不在群 —— 那种「名单突然空了」比多列更误导人。
    //
    // 先刷一次索引：它反映适配器当前的群成员表，有人刚进群/刚退群都要算数。
    // 刷新失败时保留上一次的，所以不会把整群的人判成退群。
    refreshGroupIndex()

    const here = String(e.group_id || '')
    const self = String(e.user_id)
    const list = loadPushList()
    const ready = isIndexReady()

    let subs
    if (!here) {
      // 私聊：只有自己。判据是「自己绑了营地号」而不是「订阅表里有记录」——
      // 早先绑了号、但还没被补建成影子订阅的人私聊发这条指令会被回
      // 「你还没绑定营地ID」，那是个 bug（补建机制已废除，现在也不会再有这个窗口）
      subs = getCurrentId(self) ? [[self, list[self] || NO_SUB]] : []
    } else if (ready) {
      // 群里：索引里的成员本身就是「群成员 ∩ 已绑定营地号」，直接拿来当名单
      subs = membersOfGroup(here).map(qq => [qq, list[qq] || NO_SUB])
    } else {
      // 索引不可用时的兜底：仍按推送目标群判（拿不到成员表就无从知道谁在群里）
      subs = Object.entries(list).filter(([, sub]) => subGroups(sub).includes(here))
    }

    // 被拉黑的人不列出来：他那份快照已经不再更新了（推送轮询会跳过他），
    // 留在名单里只会永远显示「数据较旧」。
    // 主动隐身的人（#关闭在线状态，写的是 optedOut 标记）同样摘掉。
    subs = subs.filter(([qq]) => !isBlackUser(qq) && list[qq]?.optedOut !== true)

    if (!subs.length) {
      await e.reply([
        here
          ? `本群还没有人能显示在线状态\n发送 #绑定营地 [营地ID] 就会被列进来`
          : '你还没有绑定营地ID\n发送 #绑定营地 [营地ID] 后就能看到自己的在线状态',
        Button.push(false)
      ], shouldQuote())
      return
    }

    // 现刷快照：名单里的人一律现刷一遍（含发起人自己），刷不到才退回旧快照。
    // ⚠️ 刷到的结果**只在内存里给本次出图用，不落盘**（理由见 refreshSnapshots）。
    const freshPatches = await this.refreshSnapshots(e, subs)

    // 盘上那份是常驻轮询写的，拿它当底，再把现刷的新鲜字段盖上去
    const fresh = loadPushList()
    for (const [qq, patch] of freshPatches) fresh[qq] = { ...(fresh[qq] || {}), ...patch }

    const heroMap = await getHeroNameMap()
    const now = Date.now()

    const playing = []
    const justEnded = []
    // 游戏客户端开着但没在对局（大厅/匹配中）：既不是真在打，也不是单纯在线，单独一组
    const inGameIdle = []
    const online = []
    const offline = []
    // 只开了战绩推送、还没攒到过快照的订阅：既不算在线也不算离线，单独说一句
    const unknown = []

    // 头像是各适配器本地拼地址（官方机器人才会真去问 pickMember），并发取不会卡。
    // 注意读的是**现刷之后**重读的那份，否则用的还是刷新前的旧快照。
    const rows = await Promise.all(subs.map(async ([qq]) => {
      const row = buildRow(qq, fresh[qq] || {}, heroMap, now)
      row.avatar = await this.avatarOf(e, qq)
      return row
    }))

    for (const row of rows) {
      if (!row.seenAt) unknown.push(row)
      else if (row.gaming) playing.push(row)
      // 刚打完的排在在线前面：它比「只是在线」更能说明刚才在干嘛
      else if (row.justEnded) justEnded.push(row)
      // 客户端开着但没在打，比「只是在线」更明确一点，排在在线前面
      else if (row.idleInGame) inGameIdle.push(row)
      else if (row.state !== 0) online.push(row)
      // 营地不给这个号的在线状态（快照里 lastOnlineState 是空串，不是 '0'）：
      // 报「离线」是假的，归到「还没采集到状态」里
      else if (!row.hasState) unknown.push(row)
      else offline.push(row)
    }

    // 最近观测到的排前面：同一组里时间戳越新越可信
    for (const list of [playing, justEnded, inGameIdle, online, offline, unknown]) list.sort((a, b) => b.seenAt - a.seenAt)

    // 同名去重：两个 QQ 绑了同一个营地号时，营地昵称是同一个，图上会出现两格
    // 一模一样的名字（实测有 groupIndex 里 3220564986 / 3667259455 都绑 1807995411）。
    // 这不是两个人重名，是**同一个营地身份被两个 QQ 共用** —— 图上就该只出现一次。
    //
    // 在分组之后、出图之前做：各组的条数就是去重后的条数，图上「离线（13）」和
    // 实际格子数不会对不上。保留观测最新的那条（上面刚按 seenAt 降序排过，
    // 所以每组取第一个即可），后出现的同名片整条丢掉。
    //
    // ⚠️ 跨组不去重：一个人若同时出现在「正在对局」和「离线」里，那是数据的错，
    // 不是重名，这里只在一组内部去重，别把跨组的情况也吞掉。
    for (const list of [playing, justEnded, inGameIdle, online, offline, unknown]) dedupeByName(list)

    const groups = { playing, justEnded, inGameIdle, online, offline, unknown }
    const img = await this.shot(e, groups, here)

    await e.reply([
      img || renderText({ ...groups, now }),
      Button.online()
    ], shouldQuote())
  }

  /**
   * 现刷名单里所有人的在线快照 —— **名单里的人一律刷**，跟他有没有订阅推送无关
   * （名单来自群成员索引，见 list 方法）。
   *
   * ⚠️⚠️ **刷到的结果不落盘**，只作为返回值交给本次出图。这一条是硬约束，别改回
   * `mergeSubState`：订阅项里的 `lastOnlineState` / `lastGamingStart` / `lastGameSeq`
   * **不只是展示字段，还是推送那条链的状态机**——
   *   · `lastOnlineState`：checkOnline 判「0 ↔ 非0 跨越」的基准、needBattleList 判
   *     「是不是刚下线那一轮」的依据
   *   · `lastGamingStart`：开局提醒的去重键（`needGaming` 比的就是它）
   *   · `lastGameSeq`：战绩推送游标（pickNewBattles 见到相等直接短路）
   * 现刷只观测、**不播报**，一旦把这些字段写新，下一轮轮询就看不到跨越/新局，
   * 结果就是**上下线播报、开局提醒、战绩推送一起静默漏掉**。
   * 常驻轮询那条路没这个问题：它是先 checkBattle / checkOnline 用旧值判完，最后才 merge。
   *
   * 两道闸门：
   *  ① REFRESH_COOLDOWN_MS 门限：刚刷过的直接复用，连点不会重复打请求。
   *     ⚠️ 门限内的人**也要给出数据** —— 现刷不落盘，盘上那份是常驻轮询写的旧快照，
   *     只认门限不给缓存的话，同一个群第二个人发指令反而看到更旧的状态。
   *     所以刷到的结果同时留一份在内存里（`lastRefreshPatch`），门限内直接复用。
   *  ② MAX_REFRESH 上限 + 按快照最旧优先：人特别多的群先刷最不准的那批，
   *     剩下的用旧数据出图（图上会带「数据较旧」标记）。⚠️ **发起人必须排进来**：
   *     排序是「快照最旧优先」，他刚被轮询过（快照不旧）就会被截断挤掉，
   *     而他看的多半就是自己。
   *
   * 单个号失败（频控、登录态问题、隐藏主页）不中断整轮：留旧快照就好。
   * 上一条指令还在刷时直接返回已缓存的那些，两条指令并发刷会把请求量翻倍。
   *
   * @param {object} e 消息事件，只用来发等待提示、认出发起人
   * @param {Array<[string, object]>} subs 本群名单里的订阅项
   * @returns {Promise<Map<string, object>>} qq → 本轮观测到的字段（没刷到的为空表）
   */
  async refreshSnapshots (e, subs) {
    const now = Date.now()
    const self = String(e.user_id || '')
    const out = new Map()

    const lastAt = (qq, sub) => Math.max(Number(sub.lastSeenAt) || 0, lastRefreshAt.get(qq) || 0)

    // 门限内 + 内存里有上次刷到的结果 → 直接复用；其余排队去刷
    const due = []
    for (const [qq, sub] of subs) {
      if (now - lastAt(qq, sub) <= REFRESH_COOLDOWN_MS) {
        const hit = lastRefreshPatch.get(qq)
        if (hit) out.set(qq, hit)
        continue
      }
      due.push([qq, sub])
    }
    due.sort((a, b) => lastAt(a[0], a[1]) - lastAt(b[0], b[1]))

    // 发起人必须刷到：上面按「快照最旧优先」排完还要按 MAX_REFRESH 截断，
    // 他自己要是不在最旧那批就会被挤掉 —— 那正是最容易让人以为「这指令坏了」的场景。
    const selfEntry = due.find(([qq]) => qq === self)
    const picked = due.slice(0, MAX_REFRESH)
    if (selfEntry && !picked.includes(selfEntry)) picked[picked.length - 1] = selfEntry

    if (!picked.length || refreshing) return out

    refreshing = true
    try {
      // 一个人一秒多，串行拉完要好一会儿，不先说一声群里会以为机器人卡死了。
      // 注意请求是**按账号并发**的（N 个号 N 路并行），秒数要按账号数折算，
      // 不然多账号的部署会被自己的提示吓到（明明 5 秒能刷完，写着 20 秒）。
      // 只有发起人一个人时不报秒数：他多半就是私聊发了条指令，几秒内就出图，
      // 「正在刷新 1 人的在线状态，约需 1 秒」纯属噪音。
      const workers = Math.max(1, Math.min(ApiService.usableAccountCount(), picked.length))
      const eta = Math.max(1, Math.ceil(picked.length * 1.5 / workers))
      await e.reply(
        picked.length === 1 && selfEntry
          ? '正在读取你的最新状态'
          : `正在刷新 ${picked.length} 人的在线状态，约需 ${eta} 秒`,
        shouldQuote()
      )

      await mapConcurrent(picked, async ([qq, sub]) => {
        const campId = getCurrentId(qq)
        if (!campId || isProfileHidden(campId)) return

        try {
          // snapshot: true —— 名单里的人一律采一份在线状态，跟「他有没有开推送」无关。
          // 名单现在来自群成员索引，绝大多数人压根没有订阅记录（sub 是 NO_SUB）
          const { patch } = await collectSnapshot(qq, campId, sub, Date.now(), { snapshot: true })
          if (Object.keys(patch).length) out.set(qq, patch)
        } catch (error) {
          // 单个人失败不该毁掉整张图：留旧快照（图上会标「数据较旧」）
          logger.debug(`[王者谁在打游戏] 现刷 ${qq} 失败: ${error.message}`)
        }
      })

      // 留一份在内存里当门限内的复用源，并记下刷过的时刻。
      // 只记真刷到东西的：失败的下次还得重试。
      // ⚠️ 上限纯粹是防内存单调增长：绑定营地号的人再多也就几百，正常永远碰不到。
      if (lastRefreshPatch.size > 500) {
        lastRefreshPatch.clear()
        lastRefreshAt.clear()
      }
      for (const [qq, patch] of out) {
        lastRefreshAt.set(qq, Date.now())
        lastRefreshPatch.set(qq, patch)
      }
    } finally {
      refreshing = false
    }

    return out
  }

  /** 出图。失败返回 null，由调用方回落到文字名单 */
  async shot (e, { playing, justEnded, inGameIdle, online, offline, unknown }, here) {
    try {
      return await puppeteer.screenshot('WhoIsPlaying', {
        imgType: getImgType(),
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/WhoIsPlaying.html',
        // 模板的 CSS / 字体都靠 {{_res_path}} 拼相对路径，漏了这项样式表 404，出的是纯文字图
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        title: '谁在打游戏',
        subText: here ? '本群在线名单' : '仅你自己',
        scopeName: here ? (e.group_name || e.group?.name || `群 ${here}`) : '我的在线状态',
        avatar: here ? await getGroupAvatar(here, e.group, 100) : await this.avatarOf(e, e.user_id),
        playing,
        justEnded,
        inGameIdle,
        online,
        offline,
        unknown
      })
    } catch (error) {
      logger.error(`[王者谁在打游戏] 渲染失败: ${error.message}`)
      return null
    }
  }

  async avatarOf (e, userId) {
    try {
      return await getUserAvatar(e, String(userId), 100)
    } catch {
      return ''
    }
  }
}

/**
 * 把一组展示行按游戏昵称去重，**原地**改数组。
 *
 * 场景：两个 QQ 绑了同一个营地号，营地昵称自然一样，图上会出现两格完全相同的名字。
 * 那是同一个营地身份被两个 QQ 共用，图上只该出现一次。
 *
 * 调用前该组已按 seenAt 降序排过，所以保留遇到的第一条（观测最新的那份快照）。
 * 名字为「召唤师」占位的不参与去重 —— 那是好几个拿不到昵称的人共用的占位名，
 * 去重会把不同的人吞成一个。
 *
 * @param {Array<{name: string}>} list 已排序的展示行数组，原地修改
 */
function dedupeByName (list) {
  const seen = new Set()
  const kept = []
  for (const row of list) {
    const name = String(row?.name || '')
    // 占位名不参与去重：那是「拿不到昵称」的多人共用值，去重会把不同的人吞成一个
    if (!name || name === '召唤师') {
      kept.push(row)
      continue
    }
    if (seen.has(name)) continue
    seen.add(name)
    kept.push(row)
  }
  list.length = 0
  list.push(...kept)
}

/** 把一条订阅整成展示用的行 */
function buildRow (qq, sub, heroMap, now) {
  const seenAt = Number(sub?.lastSeenAt) || 0
  const heroId = String(sub?.lastGamingHero || '')
  const state = Number(sub?.lastOnlineState) || 0
  // 空串 = 这轮没有在线信号（只开战绩推送，或营地关了在线状态授权），跟真的 '0' 要分开
  const hasState = String(sub?.lastOnlineState ?? '') !== ''
  const gaming = String(sub?.lastGaming || '') === '1'

  // 对局时长：dtEventTime 是一局的开始时刻，一局内恒定。用它算「已经打了多久」。
  // 服务端时间戳，跟本地时间可能有偏差，负值/离谱值就不显示（见 durationText）
  const gamingFor = gaming ? durationText(Number(sub?.lastGamingStart) || 0, now) : ''

  // 在线时长：onlineSince 是观察到的上线时刻（订阅时已在线会回退到营地 onlineTime）
  const onlineFor = state !== 0 ? durationText(Number(sub?.onlineSince) || 0, now) : ''

  // 段位：推送轮询从战绩列表顺手记的（只开在线状态的号没有，保留上一轮的值）
  const rankJobName = String(sub?.roleJobName || '')
  const stars = String(sub?.stars ?? '')
  const rankText = rankJobName ? (stars !== '' ? `${rankJobName} ${stars}星` : rankJobName) : ''

  // 刚打完：1 -> 0 的那一轮记的结束时刻，超过 ENDED_WINDOW 就不再算「刚打完」
  const endedAt = Number(sub?.lastGameEndAt) || 0
  const justEnded = !gaming && endedAt > 0 && now - endedAt <= ENDED_WINDOW

  // 「客户端在线」：营地显示在游戏里（gameOnline=2）但没在对局 —— 大厅、匹配中、翻战绩。
  //
  // lastGaming 现在只信战绩列表的 isGaming，跟 gameOnline=2 不再是同一件事，
  // 所以这一类要单独拎出来：别混进「正在对局」（会显示成对局却没有英雄），
  // 也别混进「在线」（那是 gameOnline=1，"游戏没开"）。
  const idleInGame = !gaming && hasState && state === 2

  return {
    qq: String(qq),
    // 游戏昵称（营地 roleName）：图上必须有名字，不允许退回画 QQ 号。
    //
    // 拿不到时用一个中性的占位名，而不是 String(qq) —— 主人的要求是这张图上
    // 「必须有昵称」，一串数字既不像昵称，又把 QQ 号公示到群里。
    // 名字的实际来源见 gameRecordPush 的 observeSnapshot：profile 每轮都返回 roleName，
    // 早先那一版把它扔掉了，才会出现成片空名字。
    name: sub?.roleName ? normalizeName(sub.roleName) : '召唤师',
    gaming,
    hero: heroId ? (heroMap[heroId] || `英雄${heroId}`) : '',
    // 模板用的三个字段：英雄头像 / 状态文字 / 相对时间
    heroName: heroId ? (heroMap[heroId] || `英雄${heroId}`) : '',
    heroIcon: heroIconUrl(heroId),
    // 「游戏中」这个词留给「正在对局」，客户端开着但没打就用「客户端在线」，
    // 免得两组文案撞词、看图上分不清谁真在打
    stateText: idleInGame ? '客户端在线' : (ONLINE_LABEL[state] || '在线'),
    state,
    hasState,
    idleInGame,
    seenAt,
    stale: seenAt > 0 && now - seenAt > STALE_MS,
    // 新增展示字段：对局/在线时长、段位、刚打完
    gamingFor,
    onlineFor,
    rankText,
    justEnded,
    endedAgoText: endedAt > 0 ? agoText(endedAt, now) : ''
  }
}

/**
 * 时长文案，「打了 12 分钟」这种。
 *
 * 起点是服务端时间戳，和本地时钟可能有偏差；算出来是负数（时钟不同步）或者超过一天
 * （异常大的值，多半是脏数据）就返回空串，宁可不显示也不能给出离谱的时长。
 *
 * @param {number} since 起点时间戳（毫秒），0 表示没有
 * @param {number} now 当前时间戳（毫秒）
 * @returns {string} 空串表示算不出来
 */
function durationText (since, now) {
  if (!since) return ''
  const ms = now - since
  if (ms < 0 || ms > 24 * 3600 * 1000) return ''
  const min = Math.floor(ms / 60000)
  if (min < 1) return '刚开始'
  if (min < 60) return `${min} 分钟`
  const hour = Math.floor(min / 60)
  const rest = min % 60
  return rest ? `${hour} 小时 ${rest} 分` : `${hour} 小时`
}

/** 相对时间，「3 分钟前」这种 */
function agoText (seenAt, now) {
  const sec = Math.max(0, Math.floor((now - seenAt) / 1000))
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/** 拼最终文案 */
function renderText ({ playing, justEnded, inGameIdle, online, offline, unknown, now }) {
  const lines = ['🎮 谁在打游戏']

  if (playing.length) {
    lines.push('', `⚔️ 正在对局（${playing.length}）`)
    for (const row of playing) {
      // 时长 / 段位挂在名字后面，缺就不显示（拿不到时间戳、或者只开了在线状态）
      const extra = [row.gamingFor ? `打了 ${row.gamingFor}` : '', row.rankText].filter(Boolean).join(' · ')
      lines.push(`· ${row.name}${row.hero ? ` —— ${row.hero}` : ''}${extra ? `（${extra}）` : ''}${row.stale ? `（${agoText(row.seenAt, now)}的数据）` : ''}`)
    }
  }

  if (justEnded.length) {
    lines.push('', `✅ 刚打完（${justEnded.length}）`)
    for (const row of justEnded) {
      const extra = [row.hero ? `${row.hero}` : '', row.rankText].filter(Boolean).join(' · ')
      lines.push(`· ${row.name}${extra ? ` —— ${extra}` : ''}（${row.endedAgoText}结束）`)
    }
  }

  if (inGameIdle.length) {
    lines.push('', `🎯 客户端在线（${inGameIdle.length}）`)
    for (const row of inGameIdle) {
      const extra = [row.rankText].filter(Boolean).join(' · ')
      lines.push(`· ${row.name}${extra ? ` —— ${extra}` : ''}${row.stale ? `（${agoText(row.seenAt, now)}）` : ''}`)
    }
    lines.push('（游戏开着但没在对局，可能在大厅或匹配中）')
  }

  if (online.length) {
    lines.push('', `🟢 在线（${online.length}）`)
    for (const row of online) {
      const extra = [row.onlineFor ? `在线 ${row.onlineFor}` : '', row.rankText].filter(Boolean).join(' · ')
      lines.push(`· ${row.name} —— ${row.stateText}${extra ? `（${extra}）` : ''}${row.stale ? `（${agoText(row.seenAt, now)}）` : ''}`)
    }
  }

  // 「有人」指上面任何一组活人，别只看 playing/online —— 只有人客户端在线时
  // 报「没人在线」会和上面那组自相矛盾
  if (!playing.length && !justEnded.length && !inGameIdle.length && !online.length) {
    lines.push('', '暂时没人在线，都在摸鱼呢')
  }

  if (offline.length) {
    // 离线的人不逐个列状态：他们的快照因为自适应退避普遍偏旧，逐行写时间戳只是噪音
    lines.push('', `⚫ 离线（${offline.length}）：${offline.map(row => row.name).join('、')}`)
  }

  if (unknown.length) {
    lines.push('', `❔ 还没采集到状态（${unknown.length}）：${unknown.map(row => row.name).join('、')}`)
    lines.push('（刚轮询到、还没攒到快照，或者营地没给这个号的在线状态）')
  }

  lines.push('', '数据有延迟，刚开局的稍后再发一次')

  return lines.join('\n')
}
