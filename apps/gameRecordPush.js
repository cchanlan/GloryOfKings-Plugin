/**
 * 王者战绩推送 / 开局提醒。
 *
 * 这个功能的配置项（锅巴面板开关 + cron、config.yaml 的 onlineReminder/battleResultCron、
 * index.js 里注册的 GameRecordPush.yaml）在插件里一直存在，但从来没有实现过——
 * 没有任何定时任务，pushList 也没被读过。本文件就是补上那个缺口。
 *
 * 设计要点：
 * - 个人订阅制。用户在群里 #开启战绩推送，只轮询订阅过的人，推到他订阅时所在的那个群。
 *   不做全群自动推送：UserData.yaml 里有 20+ 个绑定用户，全量轮询按 800ms 串行要 20 秒一轮，
 *   而且大部分人并不想被推送。
 * - 三条播报（打完 / 开局 / 上下线）都不 @ 本人，一律把玩家名写进文案：订阅者自己刚打完
 *   那局最清楚，@ 只是给他多刷一条红点，真正需要认人的是群里其他人。
 * - 开局提醒和战绩推送共用同一次请求。实测 isGaming 翻转与新场次进 list 是同一时刻发生的，
 *   拆成两个 task 只会让请求量翻倍、频控风险翻倍。详见 utils/pushStore.js 文件头的实测记录。
 * - 打完一局发的是和 #查询战绩N 同一张详情图（utils/battleDetailImage.js），这需要额外拉一次
 *   battledetail 并走 puppeteer，所以只给最新那局出图；出图失败一律回退纯文字，不能吞掉推送。
 * - 上下线提醒是独立开关，走的是主页接口（另一个端点）。开了它反而更省：profile 的返回体比
 *   战绩列表小一个量级，先查它拿到 gameOnline，就能判断这一轮值不值得再拉战绩列表。
 * - 请求量是自适应的，不是恒定按 cron。这个 task 是插件里唯一的常驻定时任务，营地对总量敏感
 *   （频控 -30107），而离线的号既不会开局也不会出新战绩。两层节流：
 *   ① 该不该拉战绩列表 —— pushStore.needBattleList，零代价，不影响任何提醒；
 *   ② 这一轮该不该查 —— pushStore.resolveNextCheck 按不活跃时长退避，跳过若干轮，
 *      代价是上线播报最坏晚「封顶倍数 × cron」，配置项 idleBackoffMax 填 1 可关掉。
 * - 轮询名单只收**真会播报的两路**（战绩推送 / 上下线提醒）。#谁在打游戏 那份名单
 *   （群成员 ∩ 已绑定营地号，可能几十上百人）**不进这个轮询**，改由那条指令触发时现刷
 *   （见 apps/whoIsPlaying.js）—— 常驻查他们纯属白烧配额，而离线的号也从来不产生播报。
 *
 * 数据层与全部纯计算逻辑在 utils/pushStore.js，这里只管指令交互和消息发送。
 */
import {
  loadPushList,
  savePushList,
  mergeSubState,
  mergeSubStates,
  beginSubBatch,
  endSubBatch,
  disableSubFlag,
  isFlagOn,
  hasAnyFlag,
  subGroups,
  withSubGroup,
  withoutSubGroup,
  streakMilestone,
  fetchLatest,
  fetchOnlineState,
  collectSnapshot,
  hasOnlineSignal,
  getHeroNameMap,
  calcStreak,
  pickNewBattles,
  diffOnlineState,
  summarizeSession,
  resolveOnlineSince,
  formatBattleText,
  formatGamingText,
  formatOnlineText,
  needBattleList,
  isSubActive,
  resolveNextCheck,
  normalizeName,
  ONLINE_LABEL,
  FETCH_HIDDEN,
  MAX_DETAIL_BATTLES,
  REQUEST_INTERVAL,
  DEFAULT_IDLE_BACKOFF_MAX,
  decideHint,
  sleep
} from '../utils/pushStore.js'
import { fetchBattleDetail, renderBattleDetail } from '../utils/battleDetailImage.js'
import { fetchRoleNames } from '../utils/roleName.js'
import { getAllBindings } from '../utils/rankStore.js'
import { getCurrentId, getLocalImage, Button, shouldQuote, pickGroupSafe, resolveMemberName, isBlackUser, ApiService, isProfileHidden } from '#utils'
import { Config } from '#components'

/**
 * 轮询并发锁。订阅多时一轮要几十秒，cron 设得短就会出现上一轮没跑完下一轮又启动，
 * 同一场战绩被两轮同时读到、各推一次。模块级变量足够——一个进程里只有一个 task 实例。
 */
let running = false

/**
 * 一轮最多真发几次请求。
 *
 * 退避是**每个订阅各自计时**的，所以安静一阵子之后常常好几个订阅在同一轮里一起归零
 * （2026-09-13 实测某轮 8 个订阅同时要查）。营地看的是短时间内的请求量，
 * 这种齐发比「总量大」更容易把阈值打爆：一发命中、冷却 600s 过去，下一轮又是齐发，
 * 于是每 10 分钟稳定吃一发 -30107，连续十几次下不来。
 * 超出预算的订阅本轮不发请求，下一轮从停下的位置接着查（cursor）。
 */
const MAX_REQUESTS_PER_ROUND = 6

/**
 * 命中频控后先按「每轮只放一个请求」探几轮，确认真恢复了再放开。
 *
 * 冷却一过就全军出击，实测就是下一个 600s 冷却的开始：营地对「刚被限流又立刻回来」
 * 是有惩罚续期的。探路的请求再命中就继续探，所以探测期会自己延长，
 * 直到营地真的放行。代价是恢复后头几轮查得慢，但那时候本来也查不动。
 */
const RECOVER_PROBE_ROUNDS = 3

/**
 * 命中频控后的安静期：这段时间内轮询整轮不发请求（连探测都不探）。
 *
 * 实测（2026-09-13）：营地对「刚被限流又立刻回来」有惩罚续期——冷却一过就打，
 * 每 10 分钟必中一发 -30107，连续十几轮下不来。api 层的首次冷却只有 60 秒，
 * 单靠它挡不住这种「掐着秒表回去试」，所以在轮询这侧再加一段更长的整体闭嘴，
 * 让惩罚期真正过去。
 *
 * 安静期结束后不直接恢复满速，先按 RECOVER_PROBE_ROUNDS 每轮只探一个。
 */
const RATE_LIMIT_QUIET_MS = 15 * 60 * 1000

/**
 * 轮询游标：上一轮被预算挡下的位置。没有它的话每轮都从头遍历，
 * 排在后面的订阅永远轮不到（前面的每次都用光预算）。
 */
let cursor = 0

/** 频控恢复期还剩几轮，> 0 时每轮只放一个请求探路 */
let recoverRounds = 0

/** 命中频控后的安静期截止时刻（ms），0 = 不在安静期 */
let quietUntil = 0

/**
 * 盯梢轮询的重入闸。
 *
 * ⚠️ 盯梢是插件里**唯一的 setInterval**（间隔见配置 `watchHintPollMs`，默认 15 秒），
 *    一轮要打营地接口、可能慢到几秒；没有这道闸的话下一轮会叠上来，
 *    请求量翻倍往上叠，而营地频控命中要静默 12 小时。
 *    和 server/watch-server.js 的 `tickRunning` 是同一个套路。
 */
let hintRunning = false

/** 「查不到好友关系」日志的上次打印时刻（ms）。服务真挂了时这个分支每 15 秒走一次，不节流会刷屏 */
let lastFriendNullLogAt = 0

/** 「盯梢等待」日志的上次打印时刻（ms）。同理，盯梢 15 秒一轮，不节流会刷屏 */
let lastWaitLogAt = 0

/** 「本轮挑到 N 个」日志的上次打印时刻（ms）。同上 */
let lastTargetsLogAt = 0

/**
 * 盯梢最长盯多久。上线后一直不进对局（在大厅挂着、开着客户端没打）的，
 * 超过这个时长就放弃 —— 否则每条盯梢都会挂到天荒地老、每 15 秒白打一次接口。
 *
 * ⚠️ 这个超时同时兜住**隐私号**：关了战绩隐私的号查出来和「还没进对局」一模一样
 *    （都是 rc=0 + isGaming=false + gaming=null，见 pushStore.decideHint 的注释），
 *    分不出来，只能靠超时收手。所以别调太长 —— 隐私号会一直白打请求到超时为止。
 *    15 分钟 ≈ 60 次请求，是可接受的上限；正常上线后几分钟内就开局了。
 */
const HINT_WATCH_MAX_MS = 15 * 60 * 1000

export class GameRecordPush extends plugin {
  constructor () {
    super({
      name: '王者战绩推送',
      dsc: '打完自动推战绩，开局提醒',
      event: 'message',
      // 必须比 queryGameStats（priority 1）更优先。它的 `#?(查询|王者)战绩\s*(.*)$` 是宽匹配，
      // 会把 #王者战绩推送 当成「查战绩 推送」吞掉；两者同为 1 时谁先命中取决于模块加载顺序。
      // 这里三条 reg 都是 ^…$ 完整锚定，抢先匹配不会误吞其它指令。
      priority: 0,
      rule: [
        { reg: '^#(开启|关闭)(王者)?战绩推送$', fnc: 'toggle' },
        { reg: '^#(开启|关闭)(王者)?上下线提醒$', fnc: 'toggleOnline' },
        { reg: '^#(开启|关闭)(王者)?在线状态(展示)?$', fnc: 'toggleStatus' },
        { reg: '^#(王者)?战绩推送(状态|列表)?$', fnc: 'status' },
        { reg: '^#清空王者战绩推送$', fnc: 'clearAll', permission: 'master' }
      ]
    })

    // 总开关关闭时给空 task，Yunzai 的 loader 只收集 cron 和 fnc 都有值的项
    const cfg = readConfig()
    this.task = cfg.onlineReminder !== false && cfg.battleResultCron
      ? {
          name: '王者战绩推送',
          cron: cfg.battleResultCron,
          fnc: () => this.checkAll(),
          log: false
        }
      : { name: '', fnc: '', cron: '' }
  }

  /**
   * 两个开关的公共校验：必须在群里发（推送要群号）、总开关开着、绑过营地ID。
   * @returns {Promise<string>} 通过时返回营地ID，未通过时已经回复过了，返回空串
   */
  async prepareToggle (e, label) {
    if (!e.isGroup) {
      await e.reply(`${label}需要在群里开启，提醒会发到你开启时所在的群`, shouldQuote())
      return ''
    }

    if (readConfig().onlineReminder === false) {
      await e.reply(`推送总开关当前是关闭状态，请让主人在 #王者设置 里打开`, shouldQuote())
      return ''
    }

    // 订阅入口刻意**不**去问营地ID共享库：这里解析出来的 campId 会被写进
    // GameRecordPush.yaml 固化成本地订阅的一部分，共享库那边后来改了值它也跟不上。
    // 共享只服务「当场发的查询指令」，详见 utils/shareStore.js 顶部
    const campId = getCurrentId(e.user_id)
    if (!campId) {
      await e.reply(['你还没有绑定营地ID，先发送 #绑定营地 [营地ID]', Button.bind()], shouldQuote())
      return ''
    }

    return String(campId)
  }

  /** #开启战绩推送 / #关闭战绩推送 */
  async toggle (e) {
    const enable = e.msg.includes('开启')
    const qq = String(e.user_id)

    if (!enable) {
      await this.disableIn(e, qq, 'battle', '战绩推送')
      return
    }

    const campId = await this.prepareToggle(e, '战绩推送')
    if (!campId) return

    const list = loadPushList()
    const existed = list[qq] || {}
    // 已经订阅过、只是换个群再开一次：只往推送群列表里追加，游标一概不动。
    // 重新拉一次把游标挪到当前最新，会把这期间打的局吞掉（原来只有单群时无所谓，
    // 因为那就是「重新订阅」；多群下这是很常见的「再加一个群」）
    const { groups, group, added } = withSubGroup(existed, e.group_id)
    const wasOn = isFlagOn(existed, 'battle') && subGroups(existed).length > 0

    if (wasOn) {
      list[qq] = { ...existed, battle: true, groups, group, campId: String(campId) }
      savePushList(list)
      await e.reply([
        added
          ? `✅ 本群已加入战绩推送，现在会推到 ${groups.length} 个群`
          : '战绩推送本来就在本群开着，无需重复开启',
        Button.push(true)
      ], shouldQuote())
      return
    }

    // 立刻拉一次把游标初始化到当前最新一场。
    // 不做这一步，第一轮轮询会把最近打的那局当成新战绩推出来。
    const data = await fetchLatest(campId, qq)

    if (data === FETCH_HIDDEN) {
      await e.reply('你的营地隐藏了战绩，推送拿不到数据，请先在营地里关闭战绩隐藏', shouldQuote())
      return
    }

    if (!data) {
      await e.reply('拉取战绩失败，可能是营地接口频控或登录态失效，请稍后再试', shouldQuote())
      return
    }

    const latest = (data.list || [])[0] || {}
    list[qq] = {
      ...existed,
      battle: true,
      groups,
      group,
      campId: String(campId),
      lastGameSeq: String(latest.gameSeq || ''),
      lastGameTime: String(latest.dtEventTime || ''),
      // 订阅时正在打的那局不提醒，否则一开启就收到一条「开打了」
      lastGamingStart: String(data.gaming?.dtEventTime || ''),
      // 连胜里程碑也从零开始，别拿上次订阅期间攒下的键把第一个里程碑吞掉
      lastStreakKey: '',
      // 清掉可能残留的退避档位：这里是就地合并，上次关订阅前攒下的 skipTicks
      // 会被继承，刚开启就要干等十分钟才第一次检查
      skipTicks: 0,
      idleSince: '',
      enabledAt: Date.now()
    }
    savePushList(list)

    const cron = readConfig().battleResultCron || ''
    // 营地ID旁边带上昵称，用户才认得出推的是哪个号
    const roleName = (await fetchRoleNames([campId], qq))[campId] || ''
    await e.reply([
      [
        `✅ 已开启战绩推送（营地ID ${campId}${roleName ? ` ${roleName}` : ''}）`,
        '打完一局会在本群播报（不 @ 你），开局也提醒一次',
        cron ? `检查间隔：最快 ${cron}` : '',
        '别的群也要收，去那个群再发一次',
        '连上下线一起提醒发 #开启上下线提醒'
      ].filter(Boolean).join('\n'),
      Button.push(true)
    ], shouldQuote())
  }

  /**
   * 关掉一路推送。
   *
   * 多群订阅下「在哪个群关」是有意义的：只摘掉当前这个群，别的群照推。
   * 摘完一个群都不剩、或本来就不是在推送群里发的（私聊 / 别的群），才把开关整个关掉。
   *
   * @param {'battle'|'online'} key 开关名
   * @param {string} label 展示名，用于文案
   */
  async disableIn (e, qq, key, label) {
    const list = loadPushList()
    const sub = list[qq]

    if (!sub || !isFlagOn(sub, key)) {
      await e.reply(`你还没有开启${label}`, shouldQuote())
      return
    }

    const groups = subGroups(sub)
    const here = String(e.group_id || '')

    // 多群里关掉当前这一个：其它群的推送保持不动
    if (e.isGroup && groups.length > 1 && groups.includes(here)) {
      const { groups: rest, group } = withoutSubGroup(sub, here)
      list[qq] = { ...sub, groups: rest, group }
      savePushList(list)
      await e.reply(
        `已停止在本群推送${label}，其余 ${rest.length} 个群不变（想全关就在那些群里也发一次）`,
        shouldQuote()
      )
      return
    }

    disableSubFlag(qq, key)
    await e.reply(
      key === 'battle'
        ? [`已关闭${label}`, Button.push(false)]
        : `已关闭${label}`,
      shouldQuote()
    )
  }

  /** #开启上下线提醒 / #关闭上下线提醒 */
  async toggleOnline (e) {
    const enable = e.msg.includes('开启')
    const qq = String(e.user_id)

    if (!enable) {
      await this.disableIn(e, qq, 'online', '上下线提醒')
      return
    }

    const campId = await this.prepareToggle(e, '上下线提醒')
    if (!campId) return

    const list = loadPushList()
    const existed = list[qq] || {}
    const { groups, group, added } = withSubGroup(existed, e.group_id)

    // 已经开着、只是再加个群：不重新拉基准（那会把状态机的 lastOnlineState 抹掉重来）
    if (isFlagOn(existed, 'online') && subGroups(existed).length > 0) {
      list[qq] = { ...existed, online: true, groups, group, campId: String(campId) }
      savePushList(list)
      await e.reply(
        added
          ? `✅ 本群已加入上下线提醒，现在会推到 ${groups.length} 个群`
          : '上下线提醒本来就在本群开着，无需重复开启',
        shouldQuote()
      )
      return
    }

    // 立刻拉一次当前状态做基准。没有基准的话第一轮会把「当前在线」当成刚上线推一条
    const state = await fetchOnlineState(campId, qq)

    if (state === FETCH_HIDDEN) {
      await e.reply('你的营地隐藏了主页，拿不到在线状态，请先在营地里关闭主页隐藏', shouldQuote())
      return
    }

    if (!state) {
      await e.reply('拉取在线状态失败，可能是营地接口频控或登录态失效，请稍后再试', shouldQuote())
      return
    }

    // 营地把在线状态和战绩做成两个独立的隐私开关：只关前者的号，profile 里
    // gameOnline / onlineTime / offlineTime 三个字段全给 0（不是「离线」，是「不告诉你」），
    // 这时开上下线提醒等于永远推不出东西，直接拦下来说清楚要去开哪个开关。
    if (!hasOnlineSignal(state)) {
      await e.reply(
        '❌ 营地没返回你的在线状态，开了也推不出来。\n' +
        '去王者营地 →「我的」→ 设置 → 隐私设置，打开在线状态（对外展示），再重新开启',
        shouldQuote()
      )
      return
    }

    const nowSec = Math.floor(Date.now() / 1000)
    list[qq] = {
      ...existed,
      online: true,
      // 只开上下线提醒时也要有 group/campId，且不能顺手把战绩推送打开
      battle: existed.battle === true,
      groups,
      group,
      campId: String(campId),
      lastOnlineState: String(state.gameOnline),
      // 主页接口是玩家名的来源之一，缓存给不 @ 的那几条文案用
      ...(state.roleName ? { roleName: String(state.roleName) } : {}),
      // 订阅时已经在线：没观察到上线瞬间，只能回退到营地的 onlineTime（会做陈旧值检查）
      onlineSince: state.gameOnline !== 0 ? String(resolveOnlineSince(state.onlineTime, nowSec)) : '',
      // 同 toggle：就地合并会继承上次的退避档位，刚开启不该还在退避里
      skipTicks: 0,
      idleSince: '',
      enabledAt: existed.enabledAt || Date.now()
    }
    savePushList(list)

    const cron = readConfig().battleResultCron || ''
    await e.reply([
      `✅ 已开启上下线提醒（营地ID ${campId}${state.roleName ? ` ${state.roleName}` : ''}）`,
      `当前状态：${ONLINE_LABEL[state.gameOnline] || '未知'}`,
      '上下线会在本群播报（不 @ 你），下线时附本次战绩总结',
      cron ? `检查间隔：最快 ${cron}` : '',
      '关闭发 #关闭上下线提醒'
    ].filter(Boolean).join('\n'), shouldQuote())
  }

  /**
   * #开启在线状态 / #关闭在线状态（别名带「展示」二字）
   *
   * 只控制「要不要出现在 #谁在打游戏 名单里」，**和营地的「在线状态」隐私设置无关**：
   * 那个管的是营地自己的数据给不给看，这个管的是本插件要不要把采集到的快照展示给群友。
   *
   * ⚠️ 默认是**开着**的：绑了营地号、人又在群里，就默认出现在那份名单里（名单由
   * 群成员索引现算，见 apps/whoIsPlaying.js）。所以这条指令实际管的是**隐身**：
   * 关闭 = 写一个 `optedOut` 标记把自己摘出去，开启 = 把标记清掉。
   * 早先那套「自动补建影子订阅 + `onlineStatus` 字段」已在 2026-09-26 废除，
   * 记录里不再写那个字段了，判据一律看 `optedOut`。
   *
   * 也不做任何播报——上下线播报是 #开启上下线提醒（online）的事，两者独立：
   * 只想被看到、不想被播报的号就只开这一个。
   */
  async toggleStatus (e) {
    const enable = e.msg.includes('开启')
    const qq = String(e.user_id)
    const list = loadPushList()
    const sub = list[qq]

    if (!enable) {
      // 判据是 optedOut 而不是某个开关字段：默认就在名单里，只有主动关过的人才有这个标记
      if (sub?.optedOut === true) {
        await e.reply('你本来就没开在线状态展示', shouldQuote())
        return
      }
      // 关掉时**留一条记录**而不是把整条订阅删掉。
      //
      // 删掉是不行的：没有记录就代表「没隐身」，下一轮名单又把他列回来 —— 关不掉。
      // 所以关的时候写 optedOut:true，#谁在打游戏 组装名单时看到它就跳过。
      // 其余开关（battle/online/日报…）原样保留，不能因为隐身就把人家的推送删了。
      list[qq] = { ...(sub || {}), optedOut: true }
      savePushList(list)
      await e.reply('已关闭在线状态展示，之后 #谁在打游戏 不会再列出你', shouldQuote())
      return
    }

    // 绑了营地号才谈得上「出现在名单里」——名单就是「群成员 ∩ 已绑定营地号」，
    // 没绑的号根本不在那份名单上，开了也没有意义。
    // 同 :120，订阅入口不去问共享库（值会被固化进订阅文件）
    const campId = getCurrentId(qq)
    if (!campId) {
      await e.reply(['你还没有绑定营地ID，先发送 #绑定营地 [营地ID]', Button.bind()], shouldQuote())
      return
    }

    // 默认就是开着的，只有主动关过（带 optedOut 标记）的人才是关着的
    const alreadyShown = sub?.optedOut !== true

    if (!alreadyShown) {
      // 只清掉隐身标记：其余字段（battle/online/日报…）和快照字段都原样保留，
      // 已经攒着的在线状态立刻可用，不必等下一轮重新采集
      const next = { ...sub }
      delete next.optedOut
      list[qq] = next
      savePushList(list)
    }

    await e.reply(
      alreadyShown
        ? '在线状态展示本来就在开着，无需重复开启'
        : '✅ 已开启在线状态展示\n本群会出现在 #谁在打游戏 里（上下线不播报，要播报发 #开启上下线提醒）\n关闭发 #关闭在线状态展示',
      shouldQuote()
    )
  }

  /** #战绩推送状态 */
  async status (e) {
    const qq = String(e.user_id)
    const sub = loadPushList()[qq]
    const cfg = readConfig()

    if (!sub) {
      await e.reply([
        [
          '你还没开启推送',
          '推每局战绩：#开启战绩推送',
          '推上下线：#开启上下线提醒',
          cfg.onlineReminder === false ? '⚠️ 插件推送总开关关着，开了也不会推' : ''
        ].filter(Boolean).join('\n'),
        Button.push(false)
      ], shouldQuote())
      return
    }

    const battleOn = sub.battle !== false
    const onlineOn = sub.online === true
    // 名单默认包含所有「在本群 + 绑了营地号」的人，所以这里看的是**隐身标记**，
    // 不是某个开关字段（onlineStatus 已废弃，见 toggleStatus 的注释）
    const hidden = sub.optedOut === true
    const groups = subGroups(sub)
    // 自适应节流的现状。不显示的话用户没法判断「怎么半天没动静」是退避还是坏了
    const cap = Math.max(1, Number(cfg.idleBackoffMax) || DEFAULT_IDLE_BACKOFF_MAX)
    const skip = Number(sub.skipTicks) || 0

    await e.reply([
      [
        '📢 推送订阅',
        `战绩推送：${battleOn ? '已开启' : '未开启'}`,
        `上下线提醒：${onlineOn ? '已开启' : '未开启'}`,
        `群内展示：${hidden ? '已隐身' : '正常'}`,
        `营地ID：${sub.campId || '—'}`,
        `推送群：${groups.length ? groups.join('、') : '—'}${groups.length > 1 ? `（共 ${groups.length} 个）` : ''}`,
        `检查间隔：最快 ${cfg.battleResultCron || '—'}`,
        `离线退避：${cap === 1 ? '关闭（按上面间隔）' : `最长拉到 ${cap} 倍间隔`}${skip > 0 ? `｜退避中，还要跳 ${skip} 轮` : ''}`,
        cfg.onlineReminder === false ? '⚠️ 插件推送总开关关着，暂时不会推' : '',
        battleOn ? '关闭：#关闭战绩推送' : '开启：#开启战绩推送',
        onlineOn ? '关闭：#关闭上下线提醒' : '开启：#开启上下线提醒',
        hidden ? '取消隐身：#开启在线状态' : '隐身：#关闭在线状态'
      ].filter(Boolean).join('\n'),
      Button.push(battleOn)
    ], shouldQuote())
  }

  /** #清空王者战绩推送（主人） */
  async clearAll (e) {
    const count = Object.keys(loadPushList()).length
    savePushList({})
    await e.reply(`已清空全部战绩推送订阅（${count} 个）`, shouldQuote())
  }

  /**
   * 定时轮询。一次请求同时判两件事：正在打的局（开局提醒）和新结算的局（战绩推送）。
   *
   * cron 只是「最快多久看一次」，实际每个订阅还要过一道自适应节流：玩家离线时
   * 按 skipTicks 跳过若干轮（详见 pushStore.resolveNextCheck）。营地对请求总量敏感，
   * 而离线的号既不会开局也不会出新战绩，那些轮次纯属白查。
   */
  async checkAll () {
    if (readConfig().onlineReminder === false) return

    // 名单只收「开了 battle 或 online 一路的人」。日报/周报共用同一张 pushList，
    // 但它们有自己的 cron、读的是归档库，不需要这个轮询——只开了日报的订阅进来会
    // 白发一次请求再干等 800ms，订阅多了就是纯浪费。
    // 被拉黑的人整条跳过（订阅不删，移出黑名单就自动恢复）——推送是插件主动发的，
    // 不经过指令那条闸门，得在这里挡
    //
    // ⚠️ 从 `loadPushList()` 到下面清影子记录那次 `savePushList(list)` 是一整块**同步**的
    // read-modify-write：中间一个 await 都没有，对事件循环而言是原子的，所以两次重叠的
    // checkAll 不会互相覆盖写盘。**不要往这段里加任何 await**
    // （包括把 getCurrentId 换成共享库那个异步版）——一旦让出 microtask，
    // 而重入保护（下面的 `running`）又在这段之后才生效，整表覆盖丢写就成现实了。
    //
    // ⚠️ 名单**只来自订阅表，不再扫群成员**。早先这里还有一段「把群里绑了营地号、
    //    但没开任何推送的人补成影子订阅」，每轮对「每个群 × 每个群成员」调一次
    //    `getCurrentId`（每次都读整份 UserData.yaml），用户规模下是几千次 × 每次
    //    十几毫秒的**同步**阻塞，整段无 await —— 那正是「定时任务一跑机器人就整个僵住」
    //    的头号根因，已删。#谁在打游戏 的名单改由群成员索引现算
    //    （apps/whoIsPlaying.js 的 list），不再需要这些记录垫底。
    const list = loadPushList()
    const entries = Object.entries(list)
      .filter(([qq, sub]) => !isBlackUser(qq) &&
        (isFlagOn(sub, 'battle') || isFlagOn(sub, 'online')))

    // 清掉历史遗留的纯影子记录（`onlineStatus` 这个字段已经废弃，见 pushStore 的 SUB_FLAGS）。
    //
    // 它们不进 entries、不发请求、也不占配额，唯一的后果是让整表写盘变慢：用户规模下
    // 这张表被塞进几百条僵尸记录，单次 stringify 从毫秒级涨到近百毫秒，而轮询每轮要
    // 写它好几次。名单既然改由索引现算，这些记录就没有存在的理由了，一次清干净。
    //
    // ⚠️ 判据必须带 `!hasAnyFlag(sub)`：开了 battle / online / 日报周报的订阅是用户明确
    //    要的推送，一条都不能碰（他们的记录里也可能残留着历史写下的 onlineStatus）。
    //    用户主动隐身的（optedOut）写的是 `onlineStatus: false`，天然不满足这个判据，
    //    那个标记不会被误删。
    const stale = Object.keys(list)
      .filter(qq => list[qq]?.onlineStatus === true && !hasAnyFlag(list[qq]))
    if (stale.length) {
      for (const qq of stale) delete list[qq]
      savePushList(list)
      logger.info(`[王者推送] 清理 ${stale.length} 条历史影子订阅（名单已改由群成员索引现算）`)
    }

    if (!entries.length) return

    if (running) {
      logger.warn(`[王者推送] 上一轮还在跑，本轮跳过（${entries.length} 个订阅，间隔可能设得太短）`)
      return
    }

    // 频控期间整轮跳过。池里账号全在冷却时，每个订阅都会被 api 层挡回来，
    // 一个真请求都发不出去，却要挨个抛错、挨个写一遍订阅表（20 个订阅就是 20 次 YAML 读改写）。
    // 命中过一次之后再叠一段安静期，理由见 RATE_LIMIT_QUIET_MS。
    if (ApiService.hasNoAvailableAccount()) {
      logger.debug(`[王者推送] 账号池全在频控冷却里，本轮 ${entries.length} 个订阅都不查`)
      return
    }

    if (Date.now() < quietUntil) {
      logger.debug(`[王者推送] 频控安静期内（还剩 ${Math.ceil((quietUntil - Date.now()) / 1000)} 秒），本轮 ${entries.length} 个订阅都不查`)
      return
    }

    running = true
    const roundStart = Date.now()
    const heroMap = await getHeroNameMap()
    // 恢复期每轮只放一个请求：冷却刚过时营地多半还在惩罚期内，发满预算等于立刻再吃一发
    const budget = recoverRounds > 0 ? 1 : MAX_REQUESTS_PER_ROUND
    const total = entries.length
    const from = cursor % total
    let sent = 0
    // 下一轮从哪个下标接着查，空串 = 本轮所有人都轮过了、下轮从头开始
    let next = ''
    // 退避递减攒在这里、循环结束一次落盘。逐个 mergeSubState 的话，用户规模下是几百次
    // 「整表 parse + 整表 stringify + 写盘」（155KB 的订阅表单次约 287ms），而这段一个
    // await 都没有 —— 就是一分多钟的同步阻塞。它们各自只改自己的 skipTicks，
    // 没有任何一处需要读到前一处刚写的值，攒起来一次写完全等价
    const skipPatches = []

    try {
      for (let i = 0; i < total; i += 1) {
        const idx = (from + i) % total
        const [qq, sub] = entries[idx]

        // 退避中：递减计数就走，注意**不能 sleep**——跳过的订阅没发请求，没必要错峰
        const skip = Number(sub?.skipTicks) || 0
        if (skip > 0) {
          skipPatches.push([qq, { skipTicks: skip - 1 }])
          continue
        }

        // 预算用完：记住停在哪，下一轮从这里接着查（否则排在后面的永远轮不到）
        if (sent >= budget) {
          next = idx
          break
        }

        try {
          await this.checkOne(qq, sub, heroMap)
        } catch (error) {
          logger.error(`[王者推送] 检查 ${qq} 出错: ${error.message}`)
        }
        sent += 1

        // 这一发已经撞上频控：剩下的订阅一个都别试了，留到下一轮
        if (ApiService.lastRateLimitAt() > roundStart) {
          logger.warn(`[王者推送] 本轮命中营地频控，还剩 ${total - i - 1} 个订阅留到下一轮`)
          next = (idx + 1) % total
          break
        }

        await sleep(REQUEST_INTERVAL)
      }
    } finally {
      // 退避计数先落盘，异常路径也不能漏：漏了的话退避中的订阅永远停在原地，
      // 等于把自适应节流整个关掉（每个离线号每轮都真查一次，正是 -30107 的来源）
      if (skipPatches.length) {
        try {
          mergeSubStates(skipPatches)
        } catch (error) {
          logger.error(`[王者推送] 写退避计数失败: ${error.message}`)
        }
      }
      running = false
      cursor = next === '' ? 0 : next
      // 命中就闭嘴一段时间再探（探测期会自己延长到营地真放行为止）；没命中才把恢复期倒数掉
      if (ApiService.lastRateLimitAt() > roundStart) {
        quietUntil = Date.now() + RATE_LIMIT_QUIET_MS
        recoverRounds = RECOVER_PROBE_ROUNDS
        logger.warn(`[王者推送] 命中营地频控：安静 ${Math.round(RATE_LIMIT_QUIET_MS / 60000)} 分钟，之后 ${RECOVER_PROBE_ROUNDS} 轮每轮只探一个订阅`)
      } else if (recoverRounds > 0) {
        recoverRounds -= 1
      }
    }
  }

  /**
   * 检查单个订阅。
   *
   * 请求顺序是**先 profile 后战绩列表**，不是反过来：profile 的返回体比 morebattlelist
   * 小一个量级，先拿到 gameOnline 就能判断这一轮值不值得再花一次战绩列表请求。
   * 离线的号既不会开局也不会出新战绩，省下的那次请求不影响任何提醒的及时性。
   * @param {string} qq 订阅者
   * @param {object} sub 订阅项
   * @param {Record<string,string>} heroMap heroId -> 英雄名
   */
  async checkOne (qq, sub, heroMap) {
    // 这一轮对这条订阅的所有写入攒成一批，结束（含异常和提前 return）时一次落盘。
    //
    // 一次检查会分好几处写同一条记录：战绩游标（checkBattle）、上下线基准
    // （checkOnline）、开播提示的几个字段（checkHint）、收尾的退避计数。
    // 每处都是「整表 parse + 整表 stringify + 写盘」，用户规模下那是几百毫秒一次的
    // **同步**阻塞，一轮要撞好几次。它们改的是互不重叠的字段，没有任何一处需要读到
    // 前一处刚写的值，攒起来最后写一次完全等价。
    //
    // ⚠️ 批内 `mergeSubState` 恒返回 true（此刻还不知道订阅在不在），
    //    所以批内不要靠返回值判断订阅是否存在。
    beginSubBatch()
    try {
      return await this.checkOneInner(qq, sub, heroMap)
    } finally {
      try {
        endSubBatch()
      } catch (error) {
        logger.error(`[王者推送] 落盘 ${qq} 的订阅状态失败: ${error.message}`)
      }
    }
  }

  /** checkOne 的实际逻辑。外面那层只管把这一轮的写入攒成一批落盘 */
  async checkOneInner (qq, sub, heroMap) {
    // 没有推送目标群就不用轮询。能进到这里的人至少开了 battle / online 一路
    // （entries 已经过滤过），而两路播报都得有群可推才谈得上「轮询」——
    // 没设推送群的订阅查了也没处发
    if (!subGroups(sub).length) return

    // 营地ID 动态取，不锁死在订阅时那个：用户 #切换营地 后应该跟着换。
    const campId = getCurrentId(qq)
    if (!campId) {
      logger.debug(`[王者推送] ${qq} 已解绑营地ID，跳过`)
      return
    }

    // 这个号的玩家隐藏了主页：24 小时内主动取数一律跳过（见 utils/hiddenProfiles.js）。
    // 不发请求，state/data 保持 null，效果等同于「这轮什么都没拿到」，
    // 但省掉一个注定返回 -10107 的请求。
    if (isProfileHidden(campId)) {
      logger.debug(`[王者推送] ${qq} 的营地 ${campId} 已标注隐藏主页，本轮跳过`)
      return
    }

    // 老订阅没有 battle 字段，按开着算（向后兼容首个版本写下的订阅）
    const battleOn = sub.battle !== false
    const onlineOn = sub.online === true

    // 采快照：先拉 profile，needBattleList 判为值得时再补一次战绩列表。
    // 这一步的口径与 #谁在打游戏 的现刷**同源**（都在 pushStore.collectSnapshot），
    // 这儿只管拿结果去决定播报什么。
    const { state, data, patch } = await collectSnapshot(qq, campId, sub)

    if (battleOn && data) {
      const handled = await this.checkBattle(qq, sub, campId, data, heroMap)
      // 换号时 checkBattle 已经重置过游标，本轮不再往下做上下线判断，等下一轮拿新号的基准
      if (handled === 'switched') return
    }

    // 播报只在真的开了上下线提醒时做：只开了战绩推送的号不播上下线，
    // 拉 profile 只是为了填快照，不能顺手把他的上下线播出来（那是另一件事，得用户自己开）
    if (onlineOn) {
      await this.checkOnline(qq, sub, data, state)
      // 开播提示和上下线播报同源：都用本轮这一份 data，**不额外查询**
      //（2026-09-20 从独立的 15 秒轮询挪回来，见 checkHint 的注释）
      if (data) await this.checkHint(qq, sub, data)
    }

    // 收尾：按这一轮的活跃度定接下来跳过几轮，顺带把本轮观测写进快照字段
    //（#谁在打游戏 直接读那几个字段，它自己不请求营地）
    const nowMs = Date.now()
    mergeSubState(qq, {
      ...resolveNextCheck(sub, {
        active: isSubActive(state, data, Math.floor(nowMs / 1000)),
        nowMs,
        maxMultiplier: readConfig().idleBackoffMax
      }),
      ...patch
    })
  }

  /**
   * 战绩推送 + 开局提醒。
   * @returns {Promise<'switched'|void>} 检测到换号时返回 'switched'
   */
  async checkBattle (qq, sub, campId, data, heroMap) {
    const latest = (data.list || [])[0] || {}

    // 换号了：两个号的战绩时间线互不相干，直接把游标挪到新号的最新一场，本轮不推。
    // 不重置的话，新号的历史战绩会因为「时间比旧号游标新」被整批当成新战绩推出来。
    if (String(sub.campId || '') !== String(campId)) {
      logger.mark(`[王者推送] ${qq} 营地ID 变更 ${sub.campId} -> ${campId}，重置推送游标`)
      mergeSubState(qq, {
        campId: String(campId),
        lastGameSeq: String(latest.gameSeq || ''),
        lastGameTime: String(latest.dtEventTime || ''),
        lastGamingStart: String(data.gaming?.dtEventTime || ''),
        // 在线状态也一起重置，新号的在线状态和旧号无关
        lastOnlineState: '',
        onlineSince: '',
        // 退避档位也归零：换号等于一条全新的时间线，别让旧号攒下的退避拖着新号
        skipTicks: 0,
        idleSince: ''
      })
      return 'switched'
    }

    // 开局提醒。用 gaming.dtEventTime（开局时间戳，一局之内恒定）做去重键，
    // 比 isGaming 布尔值可靠：连着开两局时布尔值可能一直是 true，时间戳会变。
    const gamingStart = String(data.gaming?.dtEventTime || '')
    const needGaming = data.isGaming && gamingStart && gamingStart !== String(sub.lastGamingStart || '')

    // 新结算的战绩
    const fresh = pickNewBattles(data.list, sub)

    if (!needGaming && !fresh.length) return

    const newest = fresh[fresh.length - 1]

    // 最新那局出详情图。要多拉一次 battledetail 并走 puppeteer，所以只给最新一局出图：
    // 一轮补推多局是异常情况（重启 / 频控 / cron 被调长），不该在异常时把成本放大到 N 倍。
    let detailImage = null
    if (newest) {
      detailImage = await this.renderDetail(qq, campId, newest, sub)
    }

    // 三条播报（打完、开局、上下线）现在都不 @ 本人，一律把玩家名写进文案。
    // @ 会给订阅者刷一条红点提醒，而他自己刚打完那局最清楚，真正需要认人的是群里其他人。
    const name = await this.resolveDisplayName(qq, sub)

    // 两件事凑在同一轮时合并成一条消息发。
    // 连着打排位时「上一局结算」和「下一局开局」几乎总是同一轮被读到，
    // 分两条发就是一轮刷两条，合并后阅读顺序也更顺（先说打完什么，再说又开了一局）。
    // 合并后名字已经写在战绩那段的开头，开局那段就不再重复。
    const blocks = []
    if (fresh.length) {
      // 出了图就用精简文案：KDA / 评分 / 时长图里都有，文字只留图上没有的巅峰分与段位变化
      blocks.push(this.buildBattleMessage(fresh, data.list, heroMap, !!detailImage, name))
    }
    if (needGaming) {
      blocks.push(`${fresh.length ? '—— 又开了一局 ——\n' : ''}${formatGamingText(data.gaming, heroMap, fresh.length ? '' : name)}`)
    }

    // 连胜/连败里程碑。只有真出了新战绩才算——纯开局那轮的连胜数和上一轮完全一样，
    // 在那里播一次就是同一件事说两遍。算出的 key 无论播不播都要写回订阅项（见下面的 patch）
    const milestone = fresh.length
      ? streakMilestone(calcStreak(data.list), sub.lastStreakKey, name)
      : null
    if (milestone?.text) blocks.push(milestone.text)

    // 有详情图时就不再附英雄头像了，两张图挤在一条消息里没必要。
    // 开局提醒（纯开局那轮没有 fresh，newest 为 undefined）也因此不带头像——
    // 群友反馈开局连头像图太多，只发文字；详情图没出来的战绩推送仍回退到头像。
    const iconUrl = detailImage
      ? ''
      : (newest?.heroIcon || '')

    const sent = await this.send(qq, sub, blocks.join('\n'), { iconUrl, image: detailImage })
    if (!sent) return

    // 发送失败时一个游标都不动，下一轮整条消息重试
    const patch = {}
    if (needGaming) patch.lastGamingStart = gamingStart
    if (newest) {
      patch.lastGameSeq = String(newest.gameSeq || '')
      patch.lastGameTime = String(newest.dtEventTime || '')
    }
    // 里程碑去重键：3 连起每场都是新键（win:4、win:5……），连胜断了会写空串，
    // 下次重新从 3 连开始播
    if (milestone) patch.lastStreakKey = milestone.key
    mergeSubState(qq, patch)
  }

  /**
   * 上下线提醒。
   *
   * 只在「离线 <-> 非离线」跨越时发，1(在线) <-> 2(游戏中) 的抖动不发 —— 实测账号
   * 1832804263 就在两轮之间从 1 跳到 2（打开了游戏但还没开局），这种每次都提醒就是刷屏。
   *
   * @param {string} qq 订阅者
   * @param {object} sub 订阅项
   * @param {object|null} data 战绩列表数据，有的话用来做下线时的战绩总结（不额外请求）
   * @param {object|null} state 本轮的在线状态。由 checkOne 查好传进来——它要先拿 gameOnline
   *   才能决定战绩列表拉不拉，这里再查一次就是同一轮打两次 profile
   */
  async checkOnline (qq, sub, data, state) {
    if (!state) return

    const kind = diffOnlineState(state.gameOnline, sub.lastOnlineState)
    const nowSec = Math.floor(Date.now() / 1000)
    // 主页接口每轮都给玩家名，顺手缓存下来：战绩列表和 gaming 里没有这个字段，
    // 而「进入比赛」那条也不 @ 本人、同样要靠名字认人
    const roleName = state.roleName ? String(state.roleName) : ''

    if (!kind) {
      // 状态没跨越，只把当前值记下来。
      // 首轮（lastOnlineState 为空）也走这里，等于「只登记不提醒」。
      const patch = { lastOnlineState: String(state.gameOnline) }
      if (roleName && roleName !== sub.roleName) patch.roleName = roleName
      // 已经在线但没有上线时刻（比如订阅时就在线、或换号后重置过），补一个基准
      if (state.gameOnline !== 0 && !sub.onlineSince) {
        patch.onlineSince = String(resolveOnlineSince(state.onlineTime, nowSec))
      }
      mergeSubState(qq, patch)
      return
    }

    // 上下线都是给群友看的，不 @ 本人，名字写进文案
    const name = roleName || await this.resolveDisplayName(qq, sub)

    let text
    if (kind === 'online') {
      text = formatOnlineText('online', { name, gameOnline: state.gameOnline })
    } else {
      // 本次在线时长用自己记的上线时刻算：营地的 offlineTime 刚下线时不会立刻更新，
      // 拿它相减会得负数（实测 1557825900：gameOnline 已是 0，offlineTime 仍早于 onlineTime）
      const since = Number(sub.onlineSince) || 0
      text = formatOnlineText('offline', {
        name,
        durationSec: since > 0 ? nowSec - since : 0,
        // 收工总结复用本轮已经拉到的战绩列表，没拉到（只开了上下线提醒且列表请求失败）就不带
        session: since > 0 && data ? summarizeSession(data.list, since) : null
      })
    }

    const sent = await this.send(qq, sub, text)
    if (!sent) return

    mergeSubState(qq, {
      lastOnlineState: String(state.gameOnline),
      ...(roleName ? { roleName } : {}),
      // 上线时记下时刻供下次下线算时长；下线时清空。
      // observed=true：这是我们亲眼看到的 0 -> 非0 跨越，此刻就是上线时刻，
      // 比营地的 onlineTime 可靠（那个字段实测会是几个月前的陈旧值）
      onlineSince: kind === 'online' ? String(resolveOnlineSince(state.onlineTime, nowSec, true)) : ''
    })

    // ⚠️ 盯梢**不在这里**启动 —— 见 hintTick 的注释：
    //    一开始把「开始盯梢」挂在「上线」这个跨越上，结果主人一直在打游戏
    //    （gameOnline 恒为 2、没有 0→非0 的跨越）时盯梢永远不启动，
    //    「开局 5 分钟了也不问开播」（2026-09-17 主人反馈）。
    //    现在改成由 hintTick 每轮按「在打 + 这一局还没提示过」自己挑人。
    if (kind === 'offline' && sub.hintWatching === '1') {
      // 下线了就别再盯了
      mergeSubState(qq, { hintWatching: '', hintSince: '' })
    }
  }

  /**
   * 开播提示：这一局满 N 分钟且模式能看时，往群里问一句「要不要开一路观战」。
   *
   * ⚠️⚠️ **必须用 checkAll 本轮已经拉到的 `data`，不要自己再查一次**（2026-09-20 改回来）：
   *    这个提示本来就是挂在上下线播报那段里的（主人原话：「以前就在上下线推送的代码里」），
   *    `6dfbc5b` 把它拆成了独立的 15 秒轮询 `hintTick`，每轮**额外打一次 morebattlelist**。
   *    拆出去之后它和「战绩推送 / 上下线」不再同源 —— 那条独立查询一旦拿不到数据
   *    （请求太密 / 账号轮换 / 接口抖动），它就整天发不出来，**而战绩推送照常播报**，
   *    表现成「只有开播提示没了」（主人反馈的周五整天没提示正是这个形态）。
   *    挪回来用的是同一份 data：它们能播，这条就能播。
   *
   * 去重键 `hintGamingStart` 记「已经问过的那一局」（`gaming.dtEventTime` 一局之内恒定）。
   */
  async checkHint (qq, sub, data) {
    if (readConfig().watchHintEnabled === false) return

    const afterMin = Math.max(1, Number(readConfig().watchHintAfterMin) || 3)
    const { action, minutes } = decideHint(data, afterMin)
    // `wait`（还没进对局 / 时长不够 / 接口没给数据）什么都不做，下一轮再判
    if (action === 'wait') return

    const gameKey = String(data?.gaming?.dtEventTime || '')

    // 放弃（模式不支持 / 对方藏了战绩）：记下这一局，别每轮重判
    if (action === 'drop') {
      if (gameKey) mergeSubState(qq, { hintGamingStart: gameKey })
      return
    }

    // 这一局已经问过了
    if (!gameKey || gameKey === String(sub.hintGamingStart || '')) return

    // 好友判定只拦「**明确不是好友**」—— 那种情况提示了群友也开不了。
    // 查不到（观战服务没起 / 抽风）**照发**：宁可发一条可能开不了的，
    // 也不能让用户完全不知道有人在打（2026-09-20 改，原先这里卡死了整整两天）。
    const friend = await this.isFriendCampId(sub.campId)
    if (friend === false) {
      logger.mark(`[王者推送] ${qq} 的营地 ${sub.campId} 不是任何全局账号的好友，不发开播提示`)
      mergeSubState(qq, { hintGamingStart: gameKey })
      return
    }

    const ok = await this.sendHint(qq, sub, data.gaming, minutes)
    // 只有真发出去了才记「这局问过」—— 发送失败留着下轮重试，否则这条提示就永远丢了
    if (ok) mergeSubState(qq, { hintGamingStart: gameKey })
  }

  /**
   * 盯梢轮询：挑出「在打且这一局还没提示过」的订阅，查一次对局状态，到点就发开播提示。
   *
   * ⚠️⚠️ **这是插件里唯一的 setInterval**（其余定时都是 cron task）。所以：
   *    · 整个函数包在 try/catch 里 —— 定时器里抛出的异常会掀掉整个云崽进程；
   *    · 自建 `hintRunning` 闸防重入（一轮没跑完下一轮又进来会打双份请求）；
   *    · 只遍历 `hintWatching === '1'` 的订阅，不是全部订阅 —— 请求量才可控。
   *
   * 频控：查的是 `getMoreBattleList`（走 `#makeAuthRequest`，有账号轮询 + 冷却 + 换号），
   * 命中 -30107 会抛到这里，跳过本轮即可（api.js 已经做了账号级冷却）。
   */
  async hintTick () {
    if (hintRunning) return
    hintRunning = true
    try {
      if (readConfig().watchHintEnabled === false) return

      const cfg = readConfig()
      const afterMin = Math.max(1, Number(cfg.watchHintAfterMin) || 3)
      const now = Date.now()

      // ⭐ 挑「该盯的人」。判据**只有两个**，而且**不依赖「上线」这个瞬间**：
      //    ① 开了上下线提醒（主人的意思：只服务订阅了上下线的人）
      //    ② 快照里 `lastGaming === '1'`（在打），且这一局的 `lastGamingStart`
      //       还没提示过（`hintGamingStart` 记的是已提示过的那一局）
      //
      //    ⚠️⚠️ 为什么不能用「上线」当启动条件（原先的写法，踩过）：
      //       主人一直在打游戏时 `gameOnline` 恒为 2、**没有 0→非0 的跨越**，
      //       `checkOnline` 里的 `kind === 'online'` 永远不成立 → 盯梢永远不启动 →
      //       「开局 5 分钟了也不问开播」（2026-09-17 主人反馈）。
      //       改成按「在打 + 没提示过这局」挑，连打十局也每局都会问。
      //
      //    ⚠️ 这一轮**只读快照、不发请求**（loadPushList 读本地 YAML），
      //       真正要查的只有下面挑出来的那几个 —— 请求量才控得住。
      const list = loadPushList()
      const targets = []
      for (const [qq, sub] of Object.entries(list)) {
        if (isBlackUser(qq) || !isFlagOn(sub, 'online')) continue
        // 一个群都没有的（退群了）：`send` 会直接返回 false，留着就是每轮白查一次
        if (!subGroups(sub).length) continue
        const gamingStart = String(sub.lastGamingStart || '')
        const inGame = String(sub.lastGaming || '') === '1'
        const watching = sub.hintWatching === '1'
        // 既没在盯、又没在打 → 没事
        if (!watching && !inGame) continue
        // 这一局已经处理过了（问过了 / 明确看不了 / 盯超时了）→ 不盯
        // ⚠️ 判据是 `hintGamingStart`，**所有「放弃」路径都必须写它** ——
        //    只清 `hintWatching` 的话下一轮 `inGame` 还是 true、`gamingStart` 还是对不上，
        //    又被挑中 → 又盯/又放弃 → 无限循环（实测踩过，见下面两处注释）
        if (gamingStart && gamingStart === String(sub.hintGamingStart || '')) continue

        // 盯太久了就放弃：上线后一直没开局、或隐私号永远拿不到 gaming，都靠它收手
        if (watching) {
          const since = Number(sub.hintSince) || 0
          if (since > 0 && now - since > HINT_WATCH_MAX_MS) {
            logger.mark(`[王者推送] ${qq} 盯梢超时（${Math.round(HINT_WATCH_MAX_MS / 60000)} 分钟），放弃`)
            // ⚠️ 必须连 `hintGamingStart` 一起写，否则下一轮又被挑中 → 再盯 15 分钟（死循环）
            mergeSubState(qq, { hintWatching: '', hintSince: '', hintGamingStart: gamingStart })
            continue
          }
        } else {
          // 第一次发现他在打 → 记下开始盯的时刻（超时计时用）
          mergeSubState(qq, { hintWatching: '1', hintSince: String(now) })
          sub.hintSince = String(now)
        }
        targets.push([qq, sub])
      }

      // ⭐ 这一轮挑到了谁 —— 盯梢「到底有没有在挑人」的唯一直接证据。
      // 挑人判据只看本地快照（lastGaming / hintGamingStart），一条日志就能分清
      // 「没挑到人（快照没更新）」和「挑到了但发不出去（后面几环卡住）」。
      if (targets.length && now - lastTargetsLogAt > 5 * 60 * 1000) {
        lastTargetsLogAt = now
        logger.mark(`[王者推送] 盯梢本轮挑到 ${targets.length} 个：${targets.map(([q]) => q).join('、')}`)
      }

      for (const [qq, sub] of targets) {
        let data
        try {
          data = await fetchLatest(String(sub.campId || ''), qq)
        } catch (error) {
          // 频控 / 网络问题：这轮跳过，下轮再试（别清 hintWatching，否则一次抖动就放弃盯梢）
          logger.debug(`[王者推送] ${qq} 盯梢查询失败：${error.message}`)
          continue
        }

        const { action, minutes, reason } = decideHint(data, afterMin)
        // `wait` 有两种：真没进对局（继续盯），或**接口失败**（下轮重试）—— 都什么都不动。
        // 但这条路径原先一声不吭，盯满 15 分钟超时后用户只看到「没提示」、日志里也查不到原因
        // （2026-09-20 主人反馈周五一整天没提示，就是靠这条查出来的）。按 3 分钟节流打一条。
        if (action === 'wait') {
          if (now - lastWaitLogAt > 3 * 60 * 1000) {
            lastWaitLogAt = now
            logger.mark(`[王者推送] ${qq} 盯梢等待：${reason}（isGaming=${data ? Boolean(data.isGaming) : '接口没返回'} gaming=${data?.gaming ? '有' : '无'}）`)
          }
          continue
        }

        // 这一局的去重键：优先用**实时值**（比快照准）；隐私号拿不到 gaming，退回快照值
        const gameKey = String(data?.gaming?.dtEventTime || sub.lastGamingStart || '')

        if (action === 'drop') {
          logger.mark(`[王者推送] ${qq} 盯梢放弃：${reason}`)
          // ⚠️ 放弃也要记下这一局，否则下一轮又被挑中白查（同上的死循环）
          mergeSubState(qq, { hintWatching: '', hintSince: '', hintGamingStart: gameKey })
          continue
        }

        // ⚠️⚠️ **同一局只推一次**（主人定的，2026-09-17）。
        //    上面挑人时比的是**快照**里的 `lastGamingStart`，而快照由 checkAll 每 2 分钟才刷一次 ——
        //    滞后那两分钟里它跟实时值对不上，会让同一局被反复挑中、反复推（实测重复推送）。
        //    所以拿到**实时数据**后再比一次：`gaming.dtEventTime` 一局之内恒定，
        //    它等于已推过的那个值就说明这局问过了，直接收手。
        const liveStart = String(data.gaming?.dtEventTime || '')
        if (liveStart && liveStart === String(sub.hintGamingStart || '')) {
          logger.debug(`[王者推送] ${qq} 这一局已经问过了（${liveStart}），收手`)
          mergeSubState(qq, { hintWatching: '', hintSince: '' })
          continue
        }

        // 好友判定只拦「**明确不是好友**」这一种 —— 那种情况提示了群友也开不了。
        //
        // ⚠️⚠️ 「查不到」（观战服务没起 / 抽风 / 超时）**必须照发**（2026-09-20 改）：
        //    原先 `null` 也 `continue`，结果服务一挂，盯梢就整天静默空转到 15 分钟超时、
        //    什么都不发、日志里也一片空白。主人反馈的「周五一整天没提示」就是这个 ——
        //    当天 20:18 上线时观战服务还没部署（22:24 才创建），闸门从头到尾查不到。
        //    宁可发一条「可能开不了」的提示，也不能让用户完全不知道他在打。
        const friend = await this.isFriendCampId(sub.campId)
        if (friend === null) {
          if (now - lastFriendNullLogAt > 5 * 60 * 1000) {
            lastFriendNullLogAt = now
            logger.mark(`[王者推送] 查不到 ${qq} 的好友关系（观战服务没起？），仍照发提示`)
          }
        } else if (friend === false) {
          logger.mark(`[王者推送] ${qq} 的营地 ${sub.campId} 不是任何全局账号的好友，不发提示`)
          mergeSubState(qq, { hintWatching: '', hintSince: '', hintGamingStart: gameKey })
          continue
        }

        const ok = await this.sendHint(qq, sub, data.gaming, minutes)
        // ⚠️ 只有真发出去了才记「这局提示过」—— 发送失败（群取不到）时留着下轮重试，
        //    否则这条提示就永远丢了
        if (ok) {
          mergeSubState(qq, { hintWatching: '', hintSince: '', hintGamingStart: gameKey })
        }
      }
    } catch (error) {
      // 定时器里绝不能把异常抛出去
      logger.error(`[王者推送] 盯梢轮询出错：${error.message}`)
    } finally {
      hintRunning = false
    }
  }

  /**
   * 这个营地号是不是「某个全局账号的好友」。
   *
   * 问服务端 `/api/friends`（它的 `friendCampIds` 是**所有全局账号好友的并集**）——
   * 插件端没有 getcampfriends，好友关系只有服务端拿得到。
   * 服务没起 / 没配观战地址时返回 false（不提示）—— 观战服务不在线时提示也没用。
   */
  /**
   * 这个营地号是不是「某个全局账号的好友」。
   *
   * 问服务端 `/api/friends`（它的 `friendCampIds` 是**所有全局账号好友的并集**）——
   * 插件端没有 getcampfriends，好友关系只有服务端拿得到。
   *
   * @returns {Promise<boolean|null>} `true`/`false` = 明确结论；
   *   **`null` = 查不到**（观战服务没起、返回异常、网络不通）。
   *   ⚠️ 调用方**必须**把 null 和 false 分开处理：把「查不到」当成「不是好友」的话，
   *      一次服务抖动就会把这一局标记成已处理、再也不问（实测踩过）。
   */
  async isFriendCampId (campId) {
    const id = String(campId || '')
    if (!id) return false
    try {
      const data = await callWatchApi('/api/friends')
      if (!data?.ok) return null
      return (data.friendCampIds || []).includes(id)
    } catch (error) {
      logger.debug(`[王者推送] 查好友失败（观战服务没起？）：${error.message}`)
      return null
    }
  }

  /**
   * 发开播提示，并把这一场的坐标记到服务端（供群友发 `#营地开播` 时开播）。
   *
   * ⚠️ 坐标必须存**服务端**：`watcher`/`owners`（这个好友能被哪些账号看到）只有服务端知道，
   *    而取流必须用「加了这个好友的那个账号」（换号一律 -1003）。
   */
  async sendHint (qq, sub, gaming, minutes) {
    const name = sub.roleName || await this.resolveDisplayName(qq, sub)
    const text = `${name} 已经开局 ${minutes} 分钟了\n要不要开一路观战？发 #营地开播`
    const ok = await this.send(qq, sub, text)
    if (!ok) return false

    // 记坐标给「#营地开播」用。服务端会自己去 /api/friends 里查 watcher/owners，
    // 这里只需要给 battleID + campId 就够定位
    const groups = subGroups(sub)
    for (const gid of groups) {
      try {
        await callWatchApi('/api/hint/remember', {
          method: 'POST',
          body: {
            groupId: gid,
            battleID: String(gaming?.battleId || ''),
            campId: String(sub.campId || ''),
            nick: name
          }
        })
      } catch (error) {
        logger.debug(`[王者推送] 记开播坐标失败（群 ${gid}）：${error.message}`)
      }
    }
    logger.mark(`[王者推送] ${qq} 开局满 ${minutes} 分钟，已发开播提示（${sub.campId}）`)
    return true
  }

  /**
   * 出单场详情图。全过程失败都只记日志、返回 null，让调用方回退到纯文字——
   * 定时任务里不能因为出图失败就把整条推送吞掉。
   * @returns {Promise<object|null>} puppeteer 的图片消息段
   */
  async renderDetail (qq, campId, battle, sub) {
    try {
      // waitComplete：推送是在对局刚结束时触发的，此时详情里的 roles 常常还没落全，
      // 出图就缺一两个玩家的卡片。给它两次机会等数据齐（判据见 isRolesComplete），
      // 等不到就按现有数据出图 —— 宁可图上少个人，也不能把整条推送拖死或吞掉
      const detail = await fetchBattleDetail(campId, battle, qq, { waitComplete: 2 })
      if (!detail) {
        logger.debug(`[王者推送] ${qq} 取不到 ${battle.gameSeq} 的战绩详情，回退纯文字`)
        return null
      }

      // 详情里带玩家名，顺手缓存给「不 @ 的那几条」文案用（战绩列表和 gaming 里都没有）
      const roleName = detail.head?.roleName
      if (roleName && roleName !== sub?.roleName) {
        mergeSubState(qq, { roleName: String(roleName) })
      }

      return await renderBattleDetail(detail)
    } catch (error) {
      logger.error(`[王者推送] ${qq} 生成战绩详情图失败，回退纯文字: ${error.message}`)
      return null
    }
  }

  /**
   * 拼多场战绩的消息体。
   * @param {Array<object>} fresh 新场次，从旧到新
   * @param {Array<object>} fullList 完整列表（倒序），用来取「更早一场」比段位星数、算连胜
   * @param {Record<string,string>} heroMap
   * @param {boolean} [hasImage=false] 最新一局是否已经出了详情图，决定最后一条用不用精简文案
   * @param {string} [name] 玩家名。这条也不 @ 本人了，名字得写进文案里，
   *   否则群里看不出是谁打完的（详情图上有名字，但纯文字回退时就没有了）
   */
  buildBattleMessage (fresh, fullList, heroMap, hasImage = false, name = '') {
    // 只详细展示最近几场，更早的漏推场次折叠成一行，避免刷屏
    const shown = fresh.slice(-MAX_DETAIL_BATTLES)
    const omitted = fresh.length - shown.length

    const blocks = shown.map((item, idx) => {
      // 段位星数要和时间上更早的那场比，列表是倒序的，所以是 index + 1
      const index = fullList.findIndex(x => String(x.gameSeq || '') === String(item.gameSeq || ''))
      const prev = index >= 0 ? fullList[index + 1] : undefined
      // 只有最新那局（数组最后一项）配了详情图，它才用精简文案；补推的旧局仍是完整文字
      const brief = hasImage && idx === shown.length - 1
      return formatBattleText(item, prev, heroMap, { brief })
    })

    // 昵称里的私有区图标和不可见字符要洗掉，否则群里显示成豆腐块（和开局/上下线同一套规则）
    const who = name ? `${normalizeName(name)} · ` : ''
    const head = fresh.length > 1
      ? `${who}打完 ${fresh.length} 局${omitted > 0 ? `（较早 ${omitted} 局略过）` : ''}`
      : `${who}打完一局${shown[0]?.mapName ? ` · ${shown[0].mapName}` : ''}`

    const lines = [head, ...blocks]

    const streak = calcStreak(fullList)
    if (streak.count >= 2) {
      lines.push(`${streak.type === 'win' ? '🔥' : '🧊'} 当前 ${streak.count} 连${streak.type === 'win' ? '胜' : '败'}`)
    }

    return lines.join('\n')
  }

  /**
   * 往订阅的每个群发一条推送。
   *
   * 一条都不 @ 本人：打完、开局、上下线全是群里看的播报，而订阅者自己刚打完那局最清楚，
   * @ 只是给他多刷一条红点。要认人靠文案里的玩家名，每条都带。
   *
   * 多群时**只要有一个群发成功就算成功**：游标由调用方按返回值推进，
   * 一个群发失败（被踢、群解散）不该让整条消息在其它群反复重推。
   * 图片只下载一次，多个群复用同一个消息段。
   *
   * @param {string} qq 订阅者，只用于日志
   * @param {string|string[]|object} target 群号、群号数组，或订阅项本身
   * @param {string} text 文案
   * @param {object} [opts]
   * @param {string} [opts.iconUrl] 英雄头像 URL，没有详情图时才用
   * @param {object} [opts.image] 已渲染好的图片消息段（战绩详情图）
   * @returns {Promise<boolean>} 是否至少发成功一个群。全失败时不推进游标，下一轮会重试
   */
  async send (qq, target, text, { iconUrl = '', image = null } = {}) {
    const groups = Array.isArray(target)
      ? target.map(String)
      : (typeof target === 'object' && target !== null ? subGroups(target) : subGroups({ group: target }))

    if (!groups.length) {
      logger.debug(`[王者推送] ${qq} 没有推送群，跳过`)
      return false
    }

    const message = [text]

    if (image) {
      message.push(image)
    } else if (iconUrl) {
      // getLocalImage 带 md5 缓存与占位图识别，同一个英雄头像只会真正下载一次
      const icon = await getLocalImage(iconUrl)
      if (icon) message.push(segment.image(icon))
    }

    let ok = 0
    for (const groupId of groups) {
      try {
        const group = pickGroupSafe(groupId)
        if (!group?.sendMsg) {
          logger.warn(`[王者推送] 取不到群 ${groupId}，跳过 ${qq}`)
          continue
        }

        await group.sendMsg(message)
        ok += 1
        logger.mark(`[王者推送] 已推送给 ${qq}@群${groupId}${image ? '（含详情图）' : ''}`)
      } catch (error) {
        logger.error(`[王者推送] 发送失败 ${qq}@群${groupId}: ${error.message}`)
      }
    }

    return ok > 0
  }

  /**
   * 拿玩家名写进文案。每条播报都不 @ 本人，所以名字是群里认人的唯一线索。
   *
   * 战绩列表和 data.gaming 里都没有玩家名，只有主页接口和战绩详情里有，
   * 所以订阅项里缓存一份（checkOnline 每轮、出详情图时顺手更新）。
   * 一次都没拿到过时退回 QQ 的群名片 / 昵称，最后退到 QQ 号。
   */
  async resolveDisplayName (qq, sub) {
    if (sub?.roleName) return String(sub.roleName)

    // pickGroupSafe / resolveMemberName 负责跨适配器的 ID 形态：
    // 官bot 的群号是 openid、user_id 是 appid:openid，Number() 一律 NaN
    // 多群订阅取第一个群问名字就够——群名片可能各群不同，但这只是拿不到营地昵称时的兜底
    return resolveMemberName(pickGroupSafe(subGroups(sub)[0]), qq)
  }
}

/** 读配置，读不到时按「开启」处理，和 shouldQuote 的兜底思路一致 */
function readConfig () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/**
 * 调观战服务（server/watch-server.js，pm2 名 gok-watch）。
 *
 * 盯梢要用它两件事：查「这个号是不是某个全局账号的好友」（`friendCampIds`）、
 * 记下开播坐标供 `#营地开播` 用。
 *
 * ⚠️ 和 apps/watchBattle.js 的 callApi 是同一套（那边没导出，各写一份）。
 *    服务没起时**抛异常**，由调用方兜住 —— 盯梢只是锦上添花，不该因此报错刷屏。
 */
async function callWatchApi (path, { method = 'GET', body = null, timeout = 15000 } = {}) {
  const base = String(readConfig().watchApiUrl || 'http://127.0.0.1:8899').replace(/\/+$/, '')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const r = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal
    })
    const text = await r.text()
    try {
      return JSON.parse(text)
    } catch {
      logger.error(`[王者推送] 观战服务 ${path} 返回的不是 JSON（HTTP ${r.status}）`)
      return { ok: false, error: '观战服务返回异常' }
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 盯梢轮询：独立于 cron 的短间隔定时器，只服务「上线后盯开局」这一件事。
 *
 * ⚠️⚠️ **必须放在模块顶层，不能写进 constructor** —— Yunzai 的 loader 每收到一条消息
 *    都会给每个 plugin 类 new 一个实例，写在 constructor 里等于每条消息都排一个定时器
 *    （`apps/cacheManager.js:111` 记过这个坑）。
 *
 * ⚠️ 间隔取自配置 `watchHintPollMs`（默认 15 秒）。这是插件里唯一的 setInterval，
 *    所以：异常在 `hintTick` 里兜死、重入有 `hintRunning` 闸、只遍历盯梢中的订阅。
 *    `.unref?.()` 让它在没有其它任务时能正常退出（别拖着进程不让关）。
 */
function startHintTicker () {
  const raw = Number(readConfig().watchHintPollMs)
  // 下限 5 秒：再快就是拿营地频控（命中静默 12 小时）开玩笑
  const ms = Math.max(5000, raw > 0 ? raw : 15000)
  // ⚠️ 用 Object.create 拿原型方法，**不要 `new GameRecordPush()`** ——
  //    constructor 里会跑 `super()` 注册 rule/task，在这里再跑一次是重复注册。
  //    盯梢用到的 send / resolveDisplayName / hintTick 都只用参数和模块级函数，
  //    不依赖实例状态，所以不跑 constructor 完全够用。
  const inst = Object.create(GameRecordPush.prototype)
  setInterval(() => { inst.hintTick() }, ms).unref?.()
  logger.mark(`[王者推送] 开播盯梢定时器已启动（每 ${Math.round(ms / 1000)} 秒）`)
}

// ⚠️ 独立的 15 秒盯梢轮询**已停用**（2026-09-20）：开播提示挪回 checkAll 的
//    `checkHint`，和上下线播报共用同一份 data。这里保留函数体是为了留个参照，
//    不再启动定时器 —— 它每 15 秒额外打一次 morebattlelist，正是「提示整天发不出来
//    而战绩推送照常」的根源（那条独立查询拿不到数据时，整条链路静默空转到超时）。
// startHintTicker()
