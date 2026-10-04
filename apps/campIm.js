/**
 * 营地消息接入 —— 指令 + 轮询 + 归属人分派。
 *
 * ## 干什么
 *   ① 定时从营地消息服务拉新消息，按**账号归属人**推 QQ 私信
 *   ② 两种回复方式：**引用那条私信** 或 `#营地回复 <营地号> <内容>`
 *   ③ `#营地消息` 看服务状态 / 各号连接情况
 *
 * ## 为什么不常驻 ws
 * ws 连接由**服务端**（`gok-im` 进程）持有，插件这边只是**本地 HTTP 轮询**：
 *   · 插件重启不影响 ws 连接（服务端照常收消息，游标补拉不丢）
 *   · 本地回环轮询零风控（实测 1 次/秒连打 60 次全绿）
 *
 * ## 归属人规则
 * 只推给 `AuthPool.json` 里该号的 `ownerBotUserId`。没有归属人的老号一律不推。
 * 回复的鉴权同理：**只有归属人本人（或主人）能回**。
 */
import { Config, PluginName } from '#components'
import { shouldQuote } from '#utils'
import * as client from '../utils/campImClient.js'
import * as store from '../utils/campImStore.js'
import { pushToOwner, ownerOf, getLastPush } from '../utils/campImPush.js'
import authStore from '../utils/authStore.js'

/** 配置读取（现读，改完不用重启） */
function cfg () {
  try { return Config.getDefOrConfig('config') || {} } catch { return {} }
}

/** 轮询是否开着 */
function pollEnabled () {
  return cfg().campImEnabled !== false
}

/** 轮询间隔（毫秒），下限 1000 防手滑配成 0 */
function pollMs () {
  const n = Number(cfg().campImPollMs) || 3000
  return Math.max(1000, n)
}

// ────────────────────────── 轮询 ──────────────────────────

/** 重入闸：上一轮没跑完就跳过这一轮 */
let polling = false
let pollTimer = null
/** 上次同步开关时的快照 —— 变了才调服务端，别每轮都打 */
let lastSwitchSnapshot = ''

/** 当前开关快照（用于比对有没有变化） */
function switchSnapshot () {
  const s = store.getAccountSwitches()
  return JSON.stringify(Object.keys(s).sort().map(k => [k, s[k]]))
}

/**
 * 拉一次消息并分派。
 * ⚠️ 逐条处理、逐条推进游标 —— 中间某条推失败不能卡住后面的。
 */
async function pollOnce () {
  if (polling) return
  polling = true
  try {
    // ⭐ 开关变了就同步给服务端（主人在锅巴页面改完，这里几秒内生效）
    const snap = switchSnapshot()
    if (snap !== lastSwitchSnapshot) {
      const r = await syncAccounts()
      // 同步成功才记快照；失败下轮重试
      if (r.ok) lastSwitchSnapshot = snap
    }

    const since = store.getCursor()
    const res = await client.getMessages(since)
    if (!res?.ok) return

    // ⚠️⚠️ 服务端重启后消息 id 从 1 重新计数，而游标是「只前进」的 —— 游标停在上次那个大值上，
    //    之后**一条新消息都拉不到**，表现成「收发全断」（实测 2026-09-20：游标 28、服务端 lastId 12）。
    //    检测到「服务端最新 id 比游标还小」就复位，下一轮从头补拉（队列里没推过的都会补上）。
    if (Number(res.lastId) < since) {
      logger.mark(`[营地消息] 服务端消息序号回退（游标 ${since} → 最新 ${res.lastId}），重置游标后重新拉`)
      store.resetCursor()
      return
    }

    const list = res.messages || []
    for (const msg of list) {
      const keys = store.messageKeys(msg)
      if (keys.some(k => store.hasSeenMessage(k))) {
        // ⚠️ 服务端 ws 每次重连都会把离线消息重新补拉进队列、分配**新的服务端 id**，
        //    游标（只按 id 前进）挡不住；只能靠游戏消息 id / 内容指纹去重。
        logger.debug?.(`[营地消息] 跳过服务端重放的重复消息 ${keys[0]}`)
      } else {
        // 先记后发：同一条消息只尝试推一次；推失败也别让下一次补拉再推，否则会刷屏
        for (const k of keys) store.markSeenMessage(k)
        try {
          await dispatch(msg)
        } catch (e) {
          logger.error(`[营地消息] 处理消息 ${msg?.id} 出错：${e?.message || e}`)
        }
      }
      // ⭐ 无论成功失败都推进游标 —— 否则一条坏消息会永远卡住后面所有消息
      store.setCursor(msg.id)
    }
  } catch (e) {
    // 服务没起来是常态（还没部署），debug 级别就够，别刷屏
    logger.debug?.(`[营地消息] 拉取失败：${e?.message || e}`)
  } finally {
    polling = false
  }
}

/** 分派一条消息 */
async function dispatch (msg) {
  if (!msg?.text) return
  // 推给归属人
  const r = await pushToOwner(msg, { bot: global.Bot })
  if (r.ok) {
    logger.info(`[营地消息] ${msg.selfUserId} 收到 ${msg.fromRoleName || msg.fromUserId} 的消息，已推给 ${r.to}`)
  } else if (r.reason === 'no_owner') {
    logger.debug?.(`[营地消息] 营地号 ${msg.selfUserId} 没有归属人，跳过`)
  }
}

/** 启动轮询（幂等） */
function startPolling () {
  if (pollTimer) return
  const tick = async () => {
    if (pollEnabled()) await pollOnce()
    pollTimer = setTimeout(tick, pollMs())
    pollTimer.unref?.()
  }
  // 启动后先等一下再拉，别和插件加载抢资源
  pollTimer = setTimeout(tick, 5000)
  pollTimer.unref?.()
  logger.info(`[${PluginName}] 营地消息轮询已启动（间隔 ${pollMs()}ms）`)
}

/** 停掉轮询 */
function stopPolling () {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

/**
 * 把「开启了 ws 的账号」同步给服务端。
 *
 * 什么时候调：
 *   · 插件启动时一次（见文件末尾的 bootstrap）
 *   · `#营地消息同步` 手动触发
 *   · 轮询里**每隔一段时间**自动对一次 —— 主人在锅巴页面改完开关不用等重启
 */
async function syncAccounts () {
  try {
    const status = await client.getStatus()
    if (!status?.ok) return { ok: false, error: '服务没在跑' }

    const all = authStore.listAccounts().filter(a => a?.userId && a?.userSig)
    const shouldRun = all.filter(a => store.isAccountEnabled(a.userId)).map(a => String(a.userId))
    const running = new Set((status.clients || []).map(c => String(c.userId)))

    const toStart = shouldRun.filter(id => !running.has(id))
    const toStop = [...running].filter(id => !shouldRun.includes(id))

    if (toStart.length) await client.connectAccounts(toStart)
    if (toStop.length) await client.disconnectAccounts(toStop)

    return { ok: true, started: toStart, stopped: toStop }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/**
 * 启动时把「服务端队列里、游标已经越过」的消息记成已推。
 *
 * ⚠️ 为什么需要：游标停在 lastId 上，正常情况下这些旧消息不会再拉出来；
 *    但 ws 一重连，服务端会补拉离线消息、给它们分配**新的** id，于是又会被当新消息推一遍。
 *    启动时先记上，重启后即使马上重连补拉也不会重推。
 *
 * ⚠️ 只在「服务端 id 没有回退」时播种：服务端重启后 id 从 1 重来，
 *    这时不能拿旧的大游标去判断，否则会把待处理的补拉消息全吞掉（见 pollOnce 的复位逻辑）。
 */
async function seedSeenFromQueue () {
  try {
    const res = await client.getMessages(0)
    if (!res?.ok) return
    const cursor = store.getCursor()
    if (Number(res.lastId) < cursor) return
    let n = 0
    for (const msg of (res.messages || [])) {
      if (Number(msg.id) <= cursor) {
        for (const k of store.messageKeys(msg)) store.markSeenMessage(k)
        n++
      }
    }
    if (n) logger.debug?.(`[营地消息] 启动时记下 ${n} 条已推过的队列消息`)
  } catch (e) {
    logger.debug?.(`[营地消息] 启动播种已推消息失败：${e?.message || e}`)
  }
}

// ────────────────────────── 指令 ──────────────────────────

export class CampIm extends plugin {
  constructor () {
    super({
      name: '王者营地消息',
      dsc: '把营地好友消息接进 QQ 私信，可按归属人收发',
      event: 'message',
      priority: 0,
      rule: [
        { reg: '^#营地消息$', fnc: 'status' },
        // ⭐ 收消息名单的开关。默认**只有明确加进来的号才收消息**（扫进来的全局账号
        //    默认只拿来轮询），所以必须有这两条指令，不然用户扫完号不知道怎么开。
        //    ⚠️ **不带营地号**：谁发谁就是主人 —— 开了就把他**名下所有**全局账号一起开关。
        //       指定单个号是锅巴页面干的事，指令这层没必要让人记一串数字。
        { reg: '^#营地消息(开|开启|收|打开)$', fnc: 'openMine' },
        { reg: '^#营地消息(关|关闭|不收|停止)$', fnc: 'closeMine' },
        { reg: '^#营地回复\\s*(\\S+)\\s+([\\s\\S]+)$', fnc: 'reply' },
        { reg: '^#营地消息(同步|重连)$', fnc: 'resync', permission: 'master' },
        // ⚠️⚠️ 引用回复必须**放在同一个类里**，不能再单开一个 plugin 子类 ——
        //    插件自己的 `index.js:82` 每个文件**只取第一个导出**
        //    （`moduleExports[Object.keys(moduleExports)[0]]`），第二个类会被静默丢掉，
        //    规则压根注册不进去（实测：priority 表里只有 CampIm，没有 CampImQuoteReply）。
        //    这条规则匹配任意非空消息是**有意为之**：引用消息时用户发的是自由文本
        //    （可能是「好的」这种不带 # 的话）。里面只在命中我们的推送时才接管。
        { reg: '^[\\s\\S]+$', fnc: 'tryQuote', log: false }
      ]
    })
  }

  /** `#营地消息` —— 看服务状态 + 各号连接情况 */
  async status (e) {
    let res
    try {
      res = await client.getStatus()
    } catch (err) {
      return e.reply(client.serviceDownText(err), shouldQuote())
    }
    if (!res?.ok) return e.reply('营地消息服务没在跑\n请主人发 #营地消息部署', shouldQuote())

    const lines = ['营地消息服务']
    const clients = res.clients || []
    const online = clients.filter(c => c.state === 'online').length

    // ⚠️ 「N/M 在线」数的是**正在收消息的连接**，不是账号池里的号。
    //    扫过的全局账号默认不在收消息名单里（见 utils/campImStore.js 的 isAccountEnabled），
    //    所以 0/0 很可能意味着「有好几个号，但一个都没开收」。
    //    不把这层说清楚，0/0 会被当成故障（真踩过）。
    const withAuth = authStore.listAccounts().filter(a => a?.userId && a?.userSig)
    const poolCount = withAuth.length
    lines.push(`\n账号 ${online}/${clients.length} 在线（正在收消息的）`)

    // 「登录过的号」和「收消息名单」不是一个口径：清单里只有全局账号
    // （见 authStore.listGlobalAccountsByOwner 的 isGlobalDefault 判据），
    // 所以会出现「8 个登录过、#营地消息开 只收了 7 个」这种落差（真踩过）。
    // 这里把不在名单里的号**点名**，免得用户只能靠数数怀疑自己。
    const notInList = withAuth.filter(a => !store.isInImList(a.userId))

    // ⚠️ 关键：这 N 个号**不一定都能用 #营地消息开 开**。
    //    #营地消息开 走 listGlobalAccountsByOwner，只看全局账号（isGlobalDefault）；
    //    没标成全局的号（比如绑定流程没走完的那个）只能在锅巴侧边栏「＋新增」里挑。
    //    不给这个区分，用户会照着提示发 #营地消息开、然后发现数字没变（真踩过）。
    const toggleableIds = new Set(
      authStore
        .listGlobalAccountsByOwner(String(e.user_id || ''), { includeOrphan: Boolean(e.isMaster) })
        .map(x => String(x.userId))
    )
    const toggleable = notInList.filter(a => toggleableIds.has(String(a.userId)))
    const sidebarOnly = notInList.filter(a => !toggleableIds.has(String(a.userId)))

    // 只列有归属人的（没归属的号不推消息，列出来只会让人困惑）
    const shown = clients.filter(c => ownerOf(c.userId))
    if (shown.length) {
      lines.push('')
      for (const c of shown) {
        const mark = c.state === 'online' ? '🟢' : '⚪'
        lines.push(`${mark} ${c.nickname || c.userId}`)
      }
    } else if (poolCount) {
      // 有号，只是没开收 —— 这条文案才指向正确的下一步。
      // 注意分两种：能被 #营地消息开 开关的（全局号）和只能在侧边栏逐个加的，
      // 给错指令用户会白试一次。
      lines.push('\n还没有号在收消息')
      lines.push(
        toggleable.length
          ? '扫过的号默认只用来查询，要收消息得自己开：发 #营地消息开'
          : '要收消息去锅巴侧边栏「营地消息」页面，用「＋新增」挑号'
      )
    } else {
      lines.push('\n还没有营地账号\n发 #营地wx全局登录 扫码添加')
    }

    // ⚠️ 待处理条数用 `queue.length`（服务端就是当前积压条数）。
    //    这里原先写的是 `queue.lastId - 游标`：lastId 是**消息序号**
    //    （从 `MsgSeq::now_millis()` 起步的毫秒值），跟条数不是一个量纲，
    //    于是在「一个号都没在收」时显示成「有 1789905861893 条消息待处理」。
    const pending = Number(res.queue?.length || 0)
    if (pending > 0) lines.push(`\n有 ${pending} 条消息待处理`)

    // ⭐ 登录了、但不在收消息名单里的号：按「能不能用指令开」分开说。
    //    默认不收是刻意的（扫进来的全局账号大多只拿来轮询查询），但不提醒的话
    //    用户会以为「扫完就该收消息」，发现收不到也不知道为什么。
    if (notInList.length) {
      lines.push('', `你还有 ${notInList.length} 个登录过的号没收消息`)
      if (toggleable.length) {
        lines.push(`· 其中 ${toggleable.length} 个发 #营地消息开 就能开`)
      }
      if (sidebarOnly.length) {
        // 点名：不点名的话用户只能一个个试，或者以为插件坏了
        lines.push(
          `· 另有 ${sidebarOnly.length} 个没标成全局账号（${sidebarOnly.map(a => a.userId).join('、')}），` +
          '要收得去锅巴侧边栏「营地消息」页面用「＋新增」挑'
        )
      }
    }

    return e.reply(lines, shouldQuote())
  }

  /** `#营地消息开` —— 把自己名下所有全局账号加进收消息名单 */
  async openMine (e) {
    return this.#toggleMine(e, true)
  }

  /** `#营地消息关` —— 把自己名下所有全局账号移出收消息名单 */
  async closeMine (e) {
    return this.#toggleMine(e, false)
  }

  /**
   * 收消息名单的开关（**按人**，不按号）。
   *
   * ⚠️ 谁能开：**扫码登录过全局账号的人自己** —— 一个 QQ 名下的号全开/全关。
   *    早先写的是 `#营地消息收 <营地号>`，主人当场否了：「绑了全局账号的都能自主开关，
   *    你这还加个 QQ 号干嘛」。确实 —— 谁发指令谁就是那个号的主人，不用他记数字。
   *    要单独挑某一个号，去锅巴侧边栏「营地消息」页面。
   */
  async #toggleMine (e, on) {
    const uid = String(e.user_id || '')
    // 主人可以用 includeOrphan：2026-09-17 之前扫的号没记 ownerBotUserId，那批算主人的
    const mine = authStore
      .listGlobalAccountsByOwner(uid, { includeOrphan: Boolean(e.isMaster) })
      .map(a => String(a.userId))
      .filter(Boolean)

    if (!mine.length) {
      return e.reply('你还没有扫码登录过营地号\n发 #营地wx全局登录 扫码添加', shouldQuote())
    }

    for (const id of mine) store.setAccountEnabled(id, on)
    store.invalidate()
    // 立刻同步给服务端（挂上/停掉长连接），不用等下一轮轮询
    await syncAccounts()

    const lines = [
      on ? `已开始收 ${mine.length} 个号的消息` : `已停止收 ${mine.length} 个号的消息`
    ]

    // ⚠️ 「7 个」和用户以为的「8 个」对不上时，得当场解释清楚，
    //    否则只能靠数数怀疑自己。判据是 isGlobalDefault（见 listGlobalAccountsByOwner）：
    //    登录过的号里，没标成全局的那些这条指令管不着，只能去侧边栏逐个加。
    const usable = authStore.listAccounts().filter(a => a?.userId && a?.userSig)
    const rest = usable.filter(a => !mine.includes(String(a.userId)))
    if (rest.length) {
      lines.push('', `（你登录过的号一共 ${usable.length} 个，另有 ${rest.length} 个没标成全局账号，` +
        `#营地消息开 管不着：${rest.map(a => a.userId).join('、')}）`)
      lines.push('要收它们的消息，去锅巴侧边栏「营地消息」页面用「＋新增」挑')
    }

    return e.reply(lines.join('\n'), shouldQuote())
  }

  /** `#营地回复 <营地号> <内容>` */
  async reply (e) {
    const campId = e.msg.match(/^#营地回复\s*(\S+)/)?.[1] || ''
    const text = e.msg.match(/^#营地回复\s*\S+\s+([\s\S]+)$/)?.[1]?.trim() || ''
    if (!campId || !text) return e.reply('格式：#营地回复 <营地号> <内容>', shouldQuote())

    return this.#doReply(e, campId, text)
  }

  /**
   * 引用推送直接回复 —— 规则里的 `^[\s\S]+$` 那条走这里。
   * 判据见模块底部的 `tryQuoteImpl`（写在类外面是为了能单测）。
   */
  async tryQuote (e) {
    return tryQuoteImpl(e)
  }

  /**
   * 引用那条私信直接回复。
   *
   * ⚠️ 走的是 `e.reply_id` —— 主人**引用机器人发的那条推送**时才有值。
   *    「这条引用的是不是我们的推送」已经在 `CampImQuoteReply.tryQuote` 里判过了
   *    （读原文认「📩」抬头），这里只管找目标会话。
   *
   * 两条匹配路：
   *   ① 精确：`campImStore` 里按发出消息的 id 存的映射（适配器能给 id 时才有）
   *   ② 退路：**该归属人最近收到的那条推送**（`sendPrivate` 拿不到 id，只能这样）
   *
   * @returns {Promise<boolean>} true = 已处理（别再往下走）；false = 放行给别的规则
   */
  async replyByQuote (e, quotedText = '') {
    const refId = e.reply_id || e.source?.message_id || e.source?.seq
    if (!refId) return false

    const text = String(e.msg || '').trim()
    if (!text) return false

    // ① 精确匹配；② 退路：该归属人最近收到的那条推送（按人分开存，重启也在）
    const ref = store.getRef(refId) || getLastPush(String(e.user_id || ''))
    if (!ref) return false

    // ⚠️⚠️ **核对收件人**：被引用原文里应当同时出现这条 ref 的**营地号**和**发信人名**。
    //    退路（「最近一条推送」）在主人引用**较旧**那条时会取到别人的 —— 2026-09-20 实测：
    //    引用「缨发给 1536597962」的推送，回给了 1580886057（两个号都有归属人，特别容易串）。
    //    光看 id 认不出来，只有原文能证明「这条推送确实是 TA 发的」。
    //    宁可什么都不发，也不能把消息发给不相干的好友。
    if (quotedText) {
      const missCamp = !String(quotedText).includes(String(ref.selfUserId))
      const missNick = Boolean(ref.nick) && !String(quotedText).includes(String(ref.nick))
      if (missCamp || missNick) {
        logger.warn(`[营地消息] 引用回复认不出收件人（原文对不上 ref ${ref.selfUserId}/${ref.nick || '-'}），不回复`)
        await e.reply('这条推送太旧，认不出收件人\n引用最新那条，或等 TA 再发一条', shouldQuote())
        return true
      }
    }

    await this.#doReply(e, ref.selfUserId, text, ref)
    return true
  }

  /** 实际发送（带鉴权） */
  async #doReply (e, campId, text, ref = null) {
    const owner = ownerOf(campId)
    const uid = String(e.user_id || '')

    // 鉴权：归属人本人，或主人
    if (!e.isMaster && owner !== uid) {
      return e.reply('这不是你的营地账号哦', shouldQuote())
    }
    if (!owner) {
      return e.reply(`营地号 ${campId} 还没有归属人\n让它自己发一次 #营地wx全局登录 绑定`, shouldQuote())
    }

    // 目标角色：引用的用 ref 里的，指令式的现查
    let toUserId = ref?.toUserId || ''
    let toRoleId = ref?.toRoleId || ''
    let fromRoleId = ref?.fromRoleId || ''

    if (!toUserId) {
      // 指令式：拿最近一条来自该会话的消息反查
      const last = await this.#findLastPeer(campId)
      if (!last) {
        return e.reply(`不知道要回给谁\n让 TA 先给 ${campId} 发一条消息，或者引用那条私信回复`, shouldQuote())
      }
      toUserId = last.fromUserId
      toRoleId = last.fromRoleId
      fromRoleId = last.raw?.toRoleId || ''
    }

    let res
    try {
      res = await client.sendMessage({
        selfUserId: String(campId),
        toUserId,
        toRoleId,
        fromRoleId,
        message: text
      })
    } catch (err) {
      return e.reply(client.serviceDownText(err), shouldQuote())
    }

    if (res?.ok) return e.reply('已回复', shouldQuote())

    logger.warn(`[营地消息] 回复失败：${JSON.stringify(res).slice(0, 200)}`)
    return e.reply('没发出去，稍后再试', shouldQuote())
  }

  /** 从服务端队列里找该账号最近一条「别人发来的」消息 */
  async #findLastPeer (campId) {
    try {
      const res = await client.getMessages(0)
      const list = (res?.messages || []).filter(m => String(m.selfUserId) === String(campId))
      return list.length ? list[list.length - 1] : null
    } catch {
      return null
    }
  }

  /** `#营地消息同步` —— 按开关重新连账号 */
  async resync (e) {
    const r = await syncAccounts()
    if (!r.ok) return e.reply(`同步失败：${r.error}`, shouldQuote())
    const parts = []
    if (r.started?.length) parts.push(`启动 ${r.started.length} 个`)
    if (r.stopped?.length) parts.push(`停止 ${r.stopped.length} 个`)
    return e.reply(parts.length ? `已同步：${parts.join('，')}` : '已经是最新的了', shouldQuote())
  }
}

// ────────────────────────── 引用回复的判据 ──────────────────────────

/**
 * 引用那条推送直接回复（`CampIm` 的一条规则，见上面 rule 里的注释）。
 *
 * ⚠️ 云崽的调度（`lib/plugins/loader.js:277`）：fnc 返回 `false` → `continue` 走下一条规则；
 *    返回别的（包括 undefined）→ 直接 `return` 结束整条消息的处理。
 *    所以这里**只在命中我们的推送时**接管，否则一律 `return false` 放行给别的插件
 *    （不然会把椰奶的「回复」、DF 的「联系主人」全吃掉）。
 *
 * ⚠️ 规则用 `^[\s\S]+$`（匹配任意非空消息）是**有意为之**：引用消息时用户发的
 *    内容本身是自由文本（可能是「好的」这种不带 # 的话），没法用更窄的正则去框。
 *    代价是每条消息都会进一次这个函数 —— 但它先做最便宜的 `e.reply_id` 判空，
 *    没有引用立刻 return false，开销可以忽略。
 */
async function tryQuoteImpl (e) {
  const refId = e.reply_id || e.source?.message_id || e.source?.seq
  if (!refId) return false

  const text = String(e.msg || '').trim()
  if (!text) return false

  // ① 精确匹配：按被引用消息的 id 查（适配器能给出 id 时才有）
  const hit = store.getRef(refId)

  // ② 读被引用消息的原文：既用来判「是不是我们的推送」，也用来**核对收件人**
  //    ⚠️ 不能只看「该归属人最近有没有收到推送」—— 那样会把主人引用的
  //    **任何** 消息都当成营地回复（别的插件的引用消息也被吃掉）。
  //    所以这里必须真的把被引用的那条读出来，认「📩」这个推送抬头。
  //    ⚠️ 精确命中时**也读**：读到的原文能核对收件人（见 replyByQuote 里的校验），
  //       多花一次读消息，换「绝不回错人」，值。
  const quoted = await readQuoted(e)

  // 读不到原文时只能信精确匹配；两者都没有就放行
  if (!quoted && !hit) return false
  if (quoted && !isCampPush(quoted)) return false

  const camp = new CampIm()
  return camp.replyByQuote(e, quoted || '')
}

/**
 * 读被引用消息的纯文本。
 *
 * 各家适配器给的口子不一样，逐个试：
 *   · `e.getReply()` —— 云崽 loader 在收到 reply 段时挂的（`loader.js:367`）
 *   · `bot.getMsg(id)` / `e.group.getMsg(id)` / `e.friend.getMsg(id)`
 *   · `bot.sendApi('get_msg')` —— Gscore-Adapter 走这条
 *   · `getChatHistory` —— 部分适配器只给这条
 *
 * ⚠️ 全失败要返回 null（不是 ''）—— 调用方靠它区分「读不到」和「读到空的」。
 */
async function readQuoted (e) {
  const refId = e.reply_id
  if (!refId) return null

  const bot = e.bot || globalThis.Bot

  // ① 云崽自带的（yenai 也走这条，实测能拿到东西）
  try {
    if (typeof e.getReply === 'function') {
      const t = flattenMsg(await e.getReply())
      if (t) return t
    }
  } catch { /* 换下一条路 */ }

  // ② 适配器各自的
  for (const fn of [
    () => bot?.getMsg?.(refId),
    () => e.group?.getMsg?.(refId),
    () => e.friend?.getMsg?.(refId),
    () => bot?.sendApi?.('get_msg', { message_id: refId }),
    () => e.group?.getChatHistory?.(e.source?.seq, 1),
    () => e.friend?.getChatHistory?.(e.source?.time, 1)
  ]) {
    try {
      let r = await fn()
      if (Array.isArray(r)) r = r.pop()        // 聊天记录返回的是数组
      const t = flattenMsg(r)
      if (t) return t
    } catch { /* 换下一条路 */ }
  }

  return null
}

/** 把各种形状的「消息」对象拍平成纯文本；拍不出东西返回 '' */
function flattenMsg (r) {
  if (!r) return ''
  if (typeof r === 'string') return r

  // OneBot 的 get_msg 返回：{ message: [...], raw_message: '...' }
  if (typeof r.raw_message === 'string' && r.raw_message) return r.raw_message
  if (typeof r.message === 'string') return r.message

  const arr = Array.isArray(r.message)
    ? r.message
    : Array.isArray(r.msg_elements) ? r.msg_elements : null
  if (!arr) return ''

  return arr.map(seg => {
    if (!seg) return ''
    if (typeof seg === 'string') return seg
    if (seg.type === 'text') return seg.text ?? seg.data?.text ?? ''
    return ''
  }).join('')
}

/**
 * 这条被引用的消息是不是「营地推送」。
 *
 * 判据用推送文案里的固定抬头 `📩`（见 `campImPush.js` 的 `buildContent`）——
 * 比查 id 稳（id 拿不到），比查「最近有没有推送」准（不会误吃别的插件的引用）。
 */
function isCampPush (text) {
  return text.includes('📩')
}

// ────────────────────────── 启动 ──────────────────────────

/**
 * ⚠️⚠️ **必须放在模块顶层，不能写进 constructor** —— Yunzai 的 loader 每收到一条消息
 *    都会给每个 plugin 类 new 一个实例，写在 constructor 里等于每条消息都排一个定时器
 *    （`apps/gameRecordPush.js:1364-1370` 记过这个坑）。
 *
 * ⚠️ **顶层不能做网络 I/O** —— loader 有 `plugin_load_timeout`，超时整个插件加载失败
 *    （`apps/shareNotify.js:4-15`）。所以这里只 setTimeout 延迟，真正的请求在回调里发。
 *
 * ⚠️ 用 `Object.create` 拿原型方法，**不要 `new CampIm()`** ——
 *    constructor 里会跑 `super()` 注册 rule，在这里再跑一次是重复注册。
 */
function bootstrap () {
  // 启动后 8 秒再动：别和插件加载、别的定时任务抢资源
  setTimeout(async () => {
    try {
      if (!pollEnabled()) {
        logger.info(`[${PluginName}] 营地消息未启用（配置 campImEnabled）`)
        return
      }
      // 先按开关把账号同步给服务端（服务没起来就静默跳过，等部署）
      const r = await syncAccounts()
      if (!r.ok) {
        logger.info(`[${PluginName}] 营地消息服务还没就绪：${r.error}`)
      } else if (r.started?.length || r.stopped?.length) {
        logger.info(`[${PluginName}] 营地消息账号已同步：启动 ${r.started?.length || 0} 个，停止 ${r.stopped?.length || 0} 个`)
      }
      // 先给「已经推过的旧消息」打标，别等 ws 重连补拉时又推一遍
      await seedSeenFromQueue()
      startPolling()
    } catch (e) {
      logger.warn(`[${PluginName}] 营地消息启动失败：${e?.message || e}`)
    }
  }, 8000).unref?.()
}

bootstrap()
