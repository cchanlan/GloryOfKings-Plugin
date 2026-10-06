/**
 * #营地观战 —— 看营地好友里谁正在打，挑一个开直播
 *
 * 数据全部来自**观战服务**（server/watch-server.js，pm2 托管的独立进程）：
 *   GET  /api/friends        → 好友里正在打的对局（带来源账号）
 *   POST /api/start          → 开一路直播，回这一路**专属的网址** /r/<房间号>/
 *   GET  /api/rooms          → 现在正在播的有哪几路
 *   POST /api/stop           → 收工（带 rid 停某一路，不带停全部）
 *
 * ⭐ **多路**：一个对局一路，每路一个独立网址，互不干扰。
 *    「一路一个账号」—— 所以能同时开几路，取决于有几个账号有好友（服务端回 free）。
 *    想看的那个好友被别人占着账号时，服务端会挑另一个也能看到 TA 的账号。
 *
 * 为什么不自己在插件里调营地接口：好友归属跟着**登录态账号**走，
 * 而插件的 api.js 走的是「全局账号轮询」那套，没法指定用哪个号；
 * 更关键的是**取流必须用「好友所在的那个账号」**（换号一律 -1003），
 * 所以「查列表」和「取流」必须绑在同一个账号上 —— 这件事交给服务端一体处理最省心。
 *
 * 服务没起来 / 没装 ffmpeg 时，这条指令会给出人话提示，而不是抛栈。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { AT_HEAD, stripAtText } from '../utils/atTarget.js'
import { Button, getImgType, shouldQuote } from '#utils'
import { Config } from '#components'
import authStore from '../utils/authStore.js'
import apiService from '../utils/api.js'
import { LANES, MODE_NAME, matchLane, pickBattles } from '../utils/masterPool.js'
import { reportRemoteAccounts } from '../utils/remoteAccounts.js'
import { readQuoted } from '../utils/quoted.js'
// 待确认请求表要跨热重载共享，否则热重载会把用户还没点的确认吞掉（见 utils/hotState.js）
import { hotBox } from '../utils/hotState.js'

/**
 * 待确认的「中断上一路、开这一路」请求。
 *
 * ⚠️ 为什么需要它：一个账号只能服务一路，**只有一个登录态时开第二路必然没号可用**。
 *    这时不能干巴巴回一句「等一路结束再开」（用户想看的正是新这一路），
 *    而要问一句「要不要中断上一路」，用户点了确认再拿这个请求重开。
 *    请求本体（battleID / userID / roleId / watcher / owners）在这里存着，
 *    确认时原样重发 + `replace: true` —— 不用让用户重新报一遍编号。
 *
 * key = `<群号>:<QQ>`，一人一份、互不干扰；TTL 见 PENDING_TTL_MS。
 *
 * ⚠️ 跨热重载共享（`hotBox`，2026-10-06 修）：模块级 `const pendingReplace = new Map()`
 *    在热重载后会是一个**全新的空 Map**，用户之前点开的「要不要中断上一路？」待确认请求
 *    就此消失 —— 他再点「确认中断」只会得到「没有等你确认的开播」，得从头 `#营地观战`
 *    重新选一遍人。而这个待确认窗口本身就有 5 分钟，撞上热重载的概率不低。
 *    （同一个坑本轮在 7 处地方都踩过，根因族见 utils/hotState.js。）
 */
const S = hotBox('watchBattle.pendingReplace', { pendingReplace: new Map() })
const pendingReplace = S.pendingReplace
/** 待确认请求活多久。开播提示本身 40 分钟过期，这里给 5 分钟够点按钮了 */
const PENDING_TTL_MS = 5 * 60 * 1000

const pendingKey = e => `${String(e.group_id || e.user_id || '')}:${String(e.user_id || '')}`

function rememberPending (e, payload) {
  const k = pendingKey(e)
  pendingReplace.set(k, { ...payload, at: Date.now() })
  // 顺手清掉过期的，省得一个人反复触发攒一堆（条目本来就少，全扫一遍没成本）
  for (const [key, v] of pendingReplace) {
    if (Date.now() - (v?.at || 0) > PENDING_TTL_MS) pendingReplace.delete(key)
  }
}

function takePending (e, { keep = false } = {}) {
  const k = pendingKey(e)
  const v = pendingReplace.get(k)
  if (!v) return null
  /**
   * ⚠️⚠️ `keep: true` = 「先别删，等我用完再说」（2026-10-05 修）。
   *
   * 原来是**取出即删**（`delete` 无条件执行），于是「确认中断」这条路一旦失败 ——
   * 服务端抽风、超时、或者那一路刚好自己结束了 —— 待确认请求就**没了**：
   * 用户再发一次「确认中断」只会得到「没有等你确认的开播」，得从头 `#营地观战`
   * 重新选一遍人。而这一步本来就是「上个请求没成功，我想再试一次」。
   *
   * 所以：确认失败时不删（`keep`），只有**明确放弃**（继续等/算了/取消）
   * 或者成功开播之后才清掉。TTL 照旧兜底，不会永久留着。
   */
  if (!keep) pendingReplace.delete(k)
  if (Date.now() - (v.at || 0) > PENDING_TTL_MS) {
    pendingReplace.delete(k)
    return null
  }
  return v
}

/** 明确放弃待确认请求（用户说「算了」「继续等」时调） */
function dropPending (e) {
  pendingReplace.delete(pendingKey(e))
}

/** 一次开几路。10 是主人的定数（营地池子每次也正好给 10 场） */
const MASTER_COUNT = 10

/** 两种模式各占一半：排位 5 + 巅峰 5（一边不够就用另一边补满） */
const MASTER_PER_MODE = 5

/** 配置读取。改成配置项后不用重启（Config 挂了 chokidar） */
function cfg () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/**
 * 服务地址（本机调）。
 *
 * ⚠️ 这是**控制面**地址（127.0.0.1:8898）：开播/停止/好友名单这些「能动的」接口
 *    只在本机回环上听着（2026-10-05 起），公网的 8899 播放面不再受理它们。
 *    连**别人部署的**服务时这个地址指对方机器，照旧走 watchApiUrl。
 */
function apiBase () {
  return String(cfg().watchApiUrl || 'http://127.0.0.1:8899').replace(/\/+$/, '')
}

/**
 * 对外地址（发到群里给群友点的那个）。
 * 没配就退回服务地址 —— 本机跑没问题，但群友多半点不开，所以部署时该配成公网可达的。
 */
function publicBase () {
  const p = String(cfg().watchPublicUrl || '').trim()
  return (p || apiBase()).replace(/\/+$/, '')
}

/**
 * 发到群里的直播间链接：**http 和 https 各发一条**，并告诉人先点哪条。
 *
 * ⚠️⚠️ 为什么非得发两条（2026-09-24 踩透，别再合并成一条）：
 *   · **http 那条是首选**：服务端会 302 到营地 CDN，观众直连腾讯云边缘节点，
 *     本机上行 ≈ 0（原来是「观众数 × 2.9Mbps」）。能走这条就该走这条。
 *   · **但浏览器会拆台**：桌面 Chrome/Edge 和部分手机浏览器（实测小米自带）会把 http
 *     **强制升级成 https**（HTTPS-Upgrade），而营地 CDN 只有 http —— 它的证书是单层通配
 *     `*.liveplay.myqcloud.com`，盖不住真实 CNAME 那个多级子域
 *     `xxx.livecenter.smoba.qq.com.livecdn.liveplay.myqcloud.com`，https 直连必然证书错误。
 *     于是 https 页面去拉 http 流 = Mixed Content，**浏览器连请求都不发**
 *     → 永久黑屏 + 无限「重连中…」。
 *   · 「让页面自己跳回 http」已验证是死路：跳过去立刻被浏览器升回来；服务端 302 到 http
 *     更糟（CF 隧道入口只有 443，会被边缘拽回 https → 死循环）。
 *   · **https 那条是兜底**：服务端对 https 请求不再 302、改用本机转发
 *     （见 watch-server.js 的 `isHttpsReq`），画面一定有，代价是每个观众吃约 2.9Mbps 上行。
 * 所以让人**先点 http、黑屏再点 https**：多数人保住零上行，谁也不会看不了。
 */
function liveLinks (path) {
  const base = publicBase()
  const p = String(path || '/')
  const httpUrl = base.replace(/^https:/i, 'http:') + p
  const httpsUrl = base.replace(/^http:/i, 'https:') + p
  if (!canTls(base)) return `直播间：${base}${p}`
  return `直播间：${httpUrl}\n黑屏或一直「重连中」就点这条：${httpsUrl}`
}

/**
 * 这个对外地址有没有可用的 https？
 * ⚠️ 内网/本机地址（IP、`[v6]`、localhost、带端口）**没有证书** —— 给这种地址提示
 *    「改成 https」只会把人引到一个证书错误页，比黑屏更让人懵。
 *    liveLinks 和「在播」列表两处都要用，别各写一份（改漏一处就会发出坏链接）。
 */
function canTls (base) {
  const host = String(base).replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')
  return !(/^\d/.test(host) || /^\[/.test(host) || /^localhost/i.test(host) || /:\d+$/.test(host))
}

/**
 * 大神观战的直播间链接。
 *
 * 只给 **http** 那条：服务端会 302 到营地 CDN，观众直连腾讯云、本机上行≈0（见 liveLinks）。
 * 一次发 10 路，每条再挂一个 https 就太长了 —— 黑屏的人照末尾那句提示自己改协议。
 */
function masterLink (rid) {
  const base = publicBase()
  const url = `${base}/r/${rid}/`
  return canTls(base) ? url.replace(/^https:/i, 'http:') : url
}

/**
 * 发起人自己扫码登记的全局账号。
 *
 * 观战名单只能是「他自己的营地好友」，所以这里必须按属主取号，不能用全局账号池那套轮询
 * （轮到谁是谁，查出来会是别人的好友）。
 *
 * `includeOrphan` 只给主人开：2026-09-17 之前扫的全局账号没记 ownerBotUserId，
 * 而那时只有主人能发全局登录，所以那批无主的号一律算主人的。
 */
function myWatchers (e) {
  return authStore
    .listGlobalAccountsByOwner(e.user_id, { includeOrphan: Boolean(e.isMaster) })
    .map(account => String(account.userId))
    .filter(Boolean)
}

/**
 * 调服务接口。服务没起来会抛，调用方统一兜住。
 *
 * ⚠️ 连的是**别人的**服务端时，每次调用前先把本机的营地账号递过去
 *    （见 utils/remoteAccounts.js）—— 对方的池子里没有这些号，不递就是
 *    「扫码登录成功、一发观战却查不到好友」。本机地址会自动跳过，不多花请求。
 */
async function callApi (path, { method = 'GET', body = null, timeout = 45000 } = {}) {
  await reportRemoteAccounts(apiBase())

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const r = await fetch(apiBase() + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal
    })
    const text = await r.text()
    try {
      return JSON.parse(text)
    } catch {
      // ⚠️ 别把 HTTP 状态码写进 error —— 这串会原样发到群里（文案约定：不露实现细节）。
      //    真状态码留给日志。
      logger.error(`[营地观战] ${path} 返回的不是 JSON（HTTP ${r.status}）`)
      return { ok: false, error: '观战服务返回异常' }
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 「开局 3 分钟」。
 * 时间戳是 battleId 第三段换算来的（服务端已转成毫秒）。服务端时间和本地时钟
 * 可能有偏差，算出来是负数或超过一天就返回空串 —— 宁可不显示，也不能写个离谱的时长。
 */
function minsSince (ts) {
  if (!ts) return ''
  const min = Math.floor((Date.now() - ts) / 60000)
  if (min < 0 || min > 24 * 60) return ''
  if (min < 1) return '刚开局'
  if (min < 60) return `开局 ${min} 分钟`
  return `开局 ${Math.floor(min / 60)} 小时 ${min % 60} 分`
}

export class WatchBattle extends plugin {
  constructor () {
    super({
      name: '王者营地观战',
      dsc: '看营地好友谁在打，选一个开直播观战',
      event: 'message',
      // 完整锚定的短指令，抢在 queryGameStats 的宽匹配前面
      priority: 0,
      rule: [
        {
          reg: `${AT_HEAD}#(?:营地)?观战\\s*(.*)$`,
          fnc: 'watch'
        },
        // ⭐ 开播引导的入口：群里收到「某人开局 N 分钟，要不要开播」那条提示后，
        // 群友发这个就开「本群最近提示的那一场」。
        // 完整锚定，和上面那条观战指令不冲突（「开播」≠「观战」）
        {
          reg: '^#营地开播$',
          fnc: 'startHinted'
        }
      ]
    })
  }

  async watch (e) {
    const arg = stripAtText(e.msg).replace(/^#(?:营地)?观战\s*/, '').trim()
    // 不归本文件管的词，一律放行给别的 rule，别掉进下面的序号解析里报一句「编号不对」：
    //   · 部署 / 服务 / 接入 / 连接 —— apps/watchDeploy.js 的运维指令
    //   · 帮助 —— apps/help.js 的 `#营地观战帮助`（子帮助入口）
    // 那两个插件 priority 都是 -1、正常情况抢在前面就拦下了；这里再放行一次是兜底，
    // 万一 priority 语义变了也不会出洋相。`return false` = 不拦截，继续交给后面的 rule
    // ⚠️ 「接入」「连接」**必须在名单里**（2026-10-05 修）：它们各自后面跟着地址/令牌，
    //    掉进下面会先被 `#(?:营地)?观战\s*(.*)$` 匹配到、arg 变成「接入 http://…」，
    //    然后落到序号解析里回一句「用法：#营地观战 编号」—— 完全驴唇不对马嘴。
    // ⚠️ 判据是**前缀**而不是整串相等：`#营地观战接入 <地址> <令牌>` 走到这里时
    //    arg 已经是 `接入 http://… 令牌`（指令头被上面 replace 掉了），
    //    写 `^接入$` 永远匹配不上 —— 这正是原来漏掉这两条的原因。
    if (/^(部署|服务|帮助|接入|连接)(\s|$)/.test(arg)) return false
    // ⚠️「停」「列表」「在播」放在最前判：别让它们掉进序号解析里去。
    // 停止不需要登录态：看的那一路可能是别人开的，谁在看谁就能收自己这一路。
    if (/^(停|停止|关|关闭|stop)$/i.test(arg)) return this.stopMine(e)
    // 全停：「停全部」「停 全部」「全停」都认（隔不隔空格都行）
    if (/^(?:停|停止|关|关闭)\s*全部$/.test(arg) || /^全(?:部)?(?:停|停止|关|关闭)$/.test(arg)) {
      return this.stopAll(e)
    }
    if (/^(停|停止|关|关闭)\s*(\d+)$/i.test(arg)) {
      return this.stopOne(e, Number(arg.match(/(\d+)/)[1]))
    }
    // ⚠️ 两个列表语义**完全不同**，别合并：
    //    · 「列表」= 谁在对局中（好友名单，编号给「#营地观战 N」选人开播用）
    //    · 「在播」= 现在有几路直播在跑（房间列表，编号给「停 N」用）
    //    以前「列表」指的是后者，主人明确纠正过：列表就该是「谁在打」。
    if (/^(在播|直播间|正在播|rooms?)$/i.test(arg)) return this.rooms(e)

    // 「中断上一路、开这一路」的确认/放弃 —— 只认待确认请求，没有就说明一声
    // ⚠️ 放在登录态检查**前面**：确认时不该再要一遍登录态（本来就有，且这一步不查好友）
    if (/^(确认中断|确认|继续等|算了|取消)$/i.test(arg)) return this.confirmReplace(e, arg)

    // ⭐ 大神观战：走营地**公开的高端局池**，跟好友名单是两套数据源（见 master）
    //    `#观战大神` 和 `#观战大神 打野` 都落进来 —— 前者 arg 是「大神」，后者是「大神 打野」
    const masterArg = arg.match(/^大神\s*(.*)$/)
    if (masterArg) return this.master(e, masterArg[1].trim())

    // 名单和开播都要用「发起人自己的营地好友」，没有他自己的登录态就无从下手
    const watchers = myWatchers(e)
    if (!watchers.length) {
      return e.reply(
        '要先登录自己的营地号才能看好友对局\n发送 #营地QQ全局登录 或 #营地wx全局登录 扫码',
        shouldQuote()
      )
    }

    // 「列表」和空参数等价：都是「谁在对局中」
    if (!arg || /^列表$/.test(arg)) return this.list(e, watchers)
    return this.start(e, arg, watchers)
  }

  /** 出名单 */
  async list (e, watchers) {
    let data
    try {
      data = await callApi(`/api/friends?watchers=${encodeURIComponent(watchers.join(','))}`)
    } catch (error) {
      logger.error(`[营地观战] 取好友列表失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
    if (!data?.ok) {
      return e.reply(`拿不到好友列表\n${data?.error || '稍后再试'}`, shouldQuote())
    }

    const playing = data.playing || []
    // 模板里不做计算：编号、显示用哪个名字、开局多久、能不能开，都在这里算好
    // ⚠️ `canWatch` 用**服务端算好的**那个 —— 它按「这个好友能被哪些账号看到、其中有没有空闲的」
    //    判，跟真正开播时 pickWatcher 的判据一致。
    //    别改回 `i < free`：`free` 是全体账号口径，跟某一行能不能开不是一回事。
    const rows = playing.map((p, i) => ({
      idx: i + 1,
      name: p.nick || p.campNick || '未知',
      avatar: p.avatar,
      jobName: p.jobName,
      minsText: minsSince(p.startTs),
      canWatch: p.canWatch !== false
    }))

    // 卡片不摆群名群头像：看的是全局账号的营地好友，跟从哪个群发指令无关
    const img = await this.shot({
      playing: rows,
      total: data.total || 0,
      online: data.online || 0,
      // ⚠️⚠️ **优先用服务端算好的 `free`**（2026-10-05 修）。原先这里写的是
      //    `rows.filter(r => r.canWatch).length`，把服务端的值**盖掉了**：
      //    `canWatch` 是「这一行能不能开」，而 `free` 是「还剩几个空闲账号」，
      //    两个完全不同的口径。实测服务端 free=4、这里算出来 10，
      //    模板就报「还能开 10 路」—— 明明只有 4 个号，点了第 5 个只会被告知没号。
      //    服务端没给（老版本）时才退回按行数估算。
      free: Number.isFinite(data.free) ? data.free : rows.filter(r => r.canWatch).length
    })

    // 这条指令跟「推送订阅」无关，所以不给按钮：
    // Button.push() 是「开启/关闭战绩推送」，摆在这儿容易被误触
    await e.reply(img || this.renderText(playing, data), shouldQuote())
  }

  /** 看现在正在播的有哪几路 */
  async rooms (e) {
    let data
    try {
      data = await callApi('/api/rooms')
    } catch (error) {
      logger.error(`[营地观战] 取直播间列表失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
    if (!data?.ok) return e.reply(`拿不到直播间列表\n${data?.error || '稍后再试'}`, shouldQuote())

    const list = data.rooms || []
    if (!list.length) {
      return e.reply('现在没有在播的观战\n发送 #营地观战 看看好友里谁在打', shouldQuote())
    }
    // ⚠️ 列表里**每路只给 http 那条**（首选，走 CDN 直连零上行）——
    //    多路时每路都跟一条 https 会把消息刷得没法看，改成末尾统一说一句怎么换。
    //    双链接的来龙去脉见 liveLinks 的注释。
    const configuredBase = publicBase()
    const base = canTls(configuredBase) ? configuredBase.replace(/^https:/i, 'http:') : configuredBase
    const me = String(e.user_id || '')
    const lines = list.map((r, i) => {
      const extra = [r.recording ? '录制中' : '', `${r.clients} 人在看`].filter(Boolean).join(' · ')
      // 标出哪几路是自己开的 —— 「停 N」的 N 就是这个编号。
      // ⚠️ 同一局被别人复用过的房间要认 `coOwners`：后发起的那个人也该看到「（你开的）」，
      //    否则他会以为这一路不是自己的（2026-10-05 修）
      const mine = me && (String(r.owner || '') === me || (r.coOwners || []).map(String).includes(me))
        ? '（你开的）' : ''
      return `${i + 1}. ${r.nick || r.rid}${mine}${extra ? `（${extra}）` : ''}\n${base}${r.url}`
    })
    const tail = (canTls(base) ? '\n\n黑屏或一直「重连中」：把网址开头的 http 改成 https 再打开' : '')
      + '\n\n停自己开的：发 #营地观战 停\n停某一路：发 #营地观战 停 <上面的编号>'
    return e.reply(`📺 正在播的观战（${list.length}）\n\n${lines.join('\n')}${tail}`, shouldQuote())
  }

  /** 选了第 N 个 → 开一路直播 */
  async start (e, arg, watchers) {
    const n = Number(String(arg).match(/\d+/)?.[0])
    if (!n) {
      return e.reply(
        '用法：#营地观战 编号\n看谁在打：#营地观战 列表\n看正在播的：#营地观战 在播',
        shouldQuote()
      )
    }

    let data
    try {
      // 和出名单用同一个 watchers，序号才对得上（命中 90 秒缓存，不会重复打接口）
      data = await callApi(`/api/friends?watchers=${encodeURIComponent(watchers.join(','))}`)
    } catch (error) {
      logger.error(`[营地观战] 取好友列表失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
    if (!data?.ok) return e.reply(`拿不到好友列表\n${data?.error || '稍后再试'}`, shouldQuote())

    const playing = data.playing || []
    const picked = playing[n - 1]
    if (!picked) {
      return e.reply(
        playing.length
          ? `没有第 ${n} 个，当前只有 ${playing.length} 个人在打`
          : '现在没有好友在对局里\n发送 #营地观战 看看最新名单',
        shouldQuote()
      )
    }

    // ⚠️ 别在这里先说「正在开播…稍等」——交给 `launch` 判。
    //    这一路本来能用的账号全被占着时（`canWatch === false`），服务端会**立刻**
    //    回 no-account，先说一句「稍等」等于让用户白等一场（2026-10-05 修）。
    return this.launch(e, {
      watcher: picked.watcher,
      owners: picked.owners || [picked.watcher],
      battleID: picked.battleId,
      userID: picked.userId,
      roleId: picked.roleId,
      nick: picked.nick || picked.campNick
    }, { label: picked.nick || picked.campNick, canWatch: picked.canWatch })
  }

  /**
   * 真正发起 `/api/start`，并处理「没号可用」→ 问是否中断上一路。
   *
   * ⚠️ 抽出来是因为有两条入口：`#营地观战 N`（选好友）和 `#营地开播`（开提示里那一场）。
   *    两条的账号占用/中断确认逻辑必须一模一样，不然又会长出两套行为。
   *
   * @param {object} body `/api/start` 的请求体（不含 owner）
   * @param {object} opts `label` 显示名、`replace` 是否已确认中断、`canWatch` 这一路现在有没有空闲账号
   * @returns {Promise<boolean>} **真开起来了**返回 true（供 `confirmReplace` 决定要不要清待确认请求）。
   *   ⚠️ 别改成返回 `e.reply` 的返回值 —— 那是消息段对象，恒为真，失败也会被当成成功。
   */
  async launch (e, body, { label = '', replace = false, canWatch } = {}) {
    const payload = { ...body, owner: String(e.user_id || '') }

    // ⚠️⚠️ 「正在开播…稍等」**只在这一路真有可能开起来的时候说**（2026-10-05 修）。
    //    `/api/start` 成功那条路要等首帧（最长一分钟），所以必须先安抚一句；
    //    但账号被占时服务端是**立刻**回 no-account 的，这时候先说「稍等」再告诉人家
    //    「没号了」，等于让人白等一场 —— 而这正是这次要修掉的现象。
    //    `canWatch === false` 就是服务端算好的「这一路现在没号可用」（`owners` 里没空闲账号），
    //    为假直接进 agent 流程，别先出声。
    //    `replace` 时也不用说 —— `confirmReplace` 已经报过「正在中断上一路…」了。
    const willTry = canWatch !== false && !replace
    if (willTry) await e.reply(`正在开播「${label || payload.nick || '这一路'}」，稍等…`, shouldQuote())

    let res
    try {
      res = await callApi('/api/start', {
        method: 'POST',
        timeout: 60000,
        body: replace ? { ...payload, replace: true } : payload
      })
    } catch (error) {
      logger.error(`[营地观战] 开播失败: ${error.message}`)
      await e.reply(this.serviceDownText(error), shouldQuote())
      return false
    }

    if (!res?.ok) {
      // 账号都占着 → 问一句要不要中断上一路（只有一个登录态时这是唯一的办法）
      if (res?.code === 'no-account') {
        await this.askReplace(e, payload, res, label)
        return false
      }
      // 其余失败：服务端已经把人话原因带回来了（「这个人现在不能被观战」之类），原样转达
      await e.reply(`${res?.error || '这局取不到画面'}\n重发 #营地观战 换一个试试`, shouldQuote())
      return false
    }

    // ⭐ 每一路一个**独立网址**（带房间号），两个人可以同时看不同的对局
    // ⚠️ 发 http + https 两条（先点 http 保零上行，黑屏再点 https）—— 见 liveLinks 的注释
    const links = liveLinks(res.url || '/')
    // ⚠️ 复用别人已经开好的那一局时**不要再报「稍等」**（2026-10-05 修）：
    //    画面早就在推了，服务端也**不会**回 pending，这时说「画面马上就来」是骗人的。
    //    （原先没管 reused，用户看到「正在开播…稍等」其实是别人开的那一路，
    //      而且没有 pending 字段、连那句「最长等 1 分钟」都没有 —— 就是这个原因。）
    if (res.reused) {
      await e.reply(`这一局已经有人在播了，直接看这一路\n${links}`, shouldQuote())
      return true
    }
    await e.reply(
      // ⚠️ 别报「开局约 2 分钟」这种假数 —— 后台只知道「这一刻还没拿到画面」，
      //    跟开局多久无关（实测有一局开局 175 秒了照样要等 75 秒）。
      //    只说「在等画面 + 通常多快」，别替营地编理由。
      res.pending ? `${links}\n画面马上就来，最长等 1 分钟左右` : links,
      shouldQuote()
    )
    return true
  }

  /**
   * 没号可用了 → 问「要不要中断上一路」。
   *
   * ⚠️ 只有**确实有房间占着账号**时才问；一条都没有（纯没登录态）就别拿这话误导人。
   * ⚠️ 待确认请求存在 `pendingReplace` 里，用户点按钮/发「确认中断」时原样重发 ——
   *    不用让他重新报一遍编号。
   */
  async askReplace (e, payload, res, label = '') {
    const occupied = Array.isArray(res?.occupied) ? res.occupied : []
    if (!occupied.length) {
      // 没有房间占着 → 是真的没空闲账号，别问「中断」这种不存在的事
      return e.reply(`${res?.error || '没有空闲账号'}\n发 #营地观战 在播 看现在有哪几路`, shouldQuote())
    }

    rememberPending(e, { payload, label })
    const who = occupied.map(o => `「${o.nick || o.rid}」`).join('、')
    const name = label || payload.nick || '这一路'
    // ⚠️ `e.reply(msg, quote, data)` —— 按钮段必须和文本拼成**一个数组**放在第一个参数里，
    //    第二个参数只能放 quote 布尔。早先这里把按钮写在了第二个位置，结果：
    //      · 按钮段被当成 quote 丢掉，QQBot 上「中断/继续」两颗按钮永远发不出来；
    //      · 布尔落进第三个参数 data，解构取默认值，不报错但静默失效；
    //      · 更糟的是 quote 收到对象恒为真值，**无视用户的 quoteReply: false 强制引用**。
    return e.reply([
      [
        `账号都在忙，现在在播的有 ${who}`,
        `要中断上面那一路、改播「${name}」吗？`,
        '',
        '确认中断：发 #营地观战 确认中断',
        '算了继续看：发 #营地观战 继续等'
      ].join('\n'),
      Button.watchReplace()
    ], shouldQuote())
  }

  /** 确认/放弃「中断上一路」 */
  async confirmReplace (e, arg) {
    // ⚠️ 先**取但不删**（keep）：确认之后要真去开播，失败时得留着让用户能再试一次。
    //    只有「明确放弃」或者「开播真的成功了」才清 —— 见 takePending 的注释。
    const pend = takePending(e, { keep: true })
    if (!pend) {
      return e.reply('没有等你确认的开播\n直接发 #营地观战 编号 就行', shouldQuote())
    }
    if (!/^(确认中断|确认)$/.test(arg)) {
      dropPending(e)   // 用户明确说不要了，这条待确认请求用完就丢
      return e.reply('好，那就不动现在这一路\n发 #营地观战 在播 可以看正在播的', shouldQuote())
    }
    await e.reply(`正在中断上一路、改播「${pend.label || '新的一路'}」…`, shouldQuote())
    const ok = await this.launch(e, pend.payload, { label: pend.label, replace: true })
    // 成功了才清；失败（launch 内部已把原因回给用户）保留着，重发「确认中断」能再来一次
    if (ok) dropPending(e)
    return ok
  }

  /**
   * ⭐ 大神观战：从营地**公开的高端局池**里随机拉一批，直接开播。
   *
   * 跟好友观战是**两套数据源**，别混：
   *   · 好友观战 → 服务端 `/api/friends`，只能用「发起人自己的营地好友」，
   *     而且一个账号只能服务一路（取流要好友关系）
   *   · 大神观战 → 营地公开池（`/info/tv/choiceitem`），流**内嵌**在响应里，
   *     走服务端 `/api/start` 的**直连分支** —— 不需要好友关系，一次开几路都行
   *
   * 用法：#观战大神 / #观战大神 打野 / #观战大神 在播 / #观战大神 停
   *
   * 模式按 `gameType` 分（4 排位 / 14 巅峰），各取一半、凑不齐互补。
   * ⚠️ 巅峰赛每天 12:00 才开，没开的时候池子里只有排位 —— 那就全开排位。
   */
  async master (e, arg) {
    // 房间是同一个服务在管，「停 / 在播」直接复用好友观战那几条路
    if (/^(停|停止|关|关闭|stop)$/i.test(arg)) return this.stopMine(e)
    if (/^(?:停|停止|关|关闭)\s*全部$/.test(arg) || /^全(?:部)?(?:停|停止|关|关闭)$/.test(arg)) {
      return this.stopAll(e)
    }
    if (/^(停|停止|关|关闭)\s*(\d+)$/i.test(arg)) {
      return this.stopOne(e, Number(arg.match(/(\d+)/)[1]))
    }
    if (/^(在播|直播间|正在播|rooms?)$/i.test(arg)) return this.rooms(e)

    // 剩下的当分路筛。认不出的词要说一声 —— 默默忽略的话，用户会以为已经筛过了
    const wanted = String(arg || '').trim()
    const lane = matchLane(wanted)
    if (wanted && !lane) {
      return e.reply(`分路认不出「${wanted}」\n可选：${LANES.join(' / ')}`, shouldQuote())
    }

    // ⭐ 不需要发起人先登录：大神观战走营地**公开池**，池子里的全局号只要有一个登录过就能拉
    //    （`getAuthCandidates` 只认 `isGlobalDefault`，跟发起人是谁无关 —— 见 utils/authStore.js）。
    //    所以这里不传账号，让 api 层自己挑池子里的号；一个可用号都没有时才提示去登录。
    let res
    try {
      res = await apiService.getTvChoiceItems()
    } catch (error) {
      logger.error(`[观战大神] 拉对局池失败: ${error.message}`)
      return e.reply(
        error?.name === 'AuthConfigError'
          ? '这台机器还没有可用的营地登录态\n发 #营地wx全局登录 或 #营地QQ全局登录'
          : '拉不到对局池，稍后再试',
        shouldQuote()
      )
    }

    // 筛选和「排位 5 + 巅峰 5」的分流都在 utils/masterPool.js 里（能脱机单测）
    //
    // ⚠️ 只拉一次：实测连续三次调用拿到的是**同一批**（去重后新增 0），
    //    池子短时间内不会换人 —— 多拉几次纯属白打接口，还平白招惹频控。
    //    所以按分路筛完不够就是不够（实测「打野」一次只有 3 场），如实报几路。
    const { picked, laneMissed } = pickBattles(res?.data?.tvChoiceItems || res?.tvChoiceItems || [], {
      lane,
      count: MASTER_COUNT,
      perMode: MASTER_PER_MODE
    })
    if (!picked.length) {
      return e.reply(
        laneMissed ? `这批大神里没有「${lane}」的对局，稍后再试` : '现在没有可观战的对局，稍后再试',
        shouldQuote()
      )
    }

    await e.reply(`正在开 ${picked.length} 路直播，稍等…`, shouldQuote())

    // 并发开：直连模式不用取流、不用轮询，每路就一次请求
    const results = await Promise.all(picked.map(async (it) => {
      try {
        const r = await callApi('/api/start', {
          method: 'POST',
          timeout: 60000,
          body: {
            // ⭐ 直连模式：给了流地址就跳过「取流 + 轮询这局还在不在」
            rtmpUrl: it.url,
            nick: it.nick,
            owner: String(e.user_id || '')
          }
        })
        return r?.ok ? { ...it, rid: r.rid } : { ...it, error: r?.error || '开播失败' }
      } catch (error) {
        logger.error(`[观战大神] 开播失败: ${error.message}`)
        return { ...it, error: '观战服务没响应' }
      }
    }))

    const ok = results.filter((it) => it.rid)
    if (!ok.length) {
      return e.reply(`一路都没开起来\n${results[0]?.error || '稍后再试'}`, shouldQuote())
    }

    const lines = ok.map((it, i) => {
      const head = [MODE_NAME[it.gameType], it.lane].filter(Boolean).join('·')
      const tail = [it.nick, it.desc].filter(Boolean).join(' ')
      return `${i + 1}. ${head} ${tail}\n${masterLink(it.rid)}`
    })
    await e.reply(
      `大神观战 · 共 ${ok.length} 路\n${lines.join('\n')}\n`
      + '黑屏或一直「重连中」，把链接开头的 http 改成 https 再打开',
      shouldQuote()
    )
  }

  /**
   * `#营地开播` —— 开「本群最近提示的那一场」。
   *
   * 来龙去脉：订阅了上下线提醒的人上线后，后台会盯他进对局；进对局满 N 分钟且
   * **确认能看**（是好友 + 排位/巅峰 + 没隐私）时往群里发一条「要不要开播」的提示，
   * 同时把那一场的坐标记到观战服务。这条指令就是那个提示的入口。
   *
   * ⚠️ **坐标存服务端**：`watcher`/`owners`（这个好友能被哪些账号看到）只有服务端知道，
   *    而取流必须用「加了这个好友的那个账号」（换号一律 -1003）。
   *
   * ⚠️ **现查**：提示发出后对局可能已经打完了，直接开播会得到一个死房间。
   *    所以这里重新查一次，打完就明确告诉用户，而不是让他等一个永远转圈的页面。
   */
  async startHinted (e) {
    const gid = String(e.group_id || '')
    if (!e.isGroup || !gid) {
      return e.reply('这个指令要在群里发（开的是本群最近提示的那一场）', shouldQuote())
    }

    // ⚠️⚠️ **先看这条指令有没有引用那条开播提示**（2026-10-05 修）。
    //    一个群里订阅了上下线提醒的人往往不止一个（实测群 575663150 就有 3 个），
    //    于是「A 开局提示一条、B 开局又提示一条」，原先只认**最新**那条 ——
    //    用户看着 A 的提示发 `#营地开播`，开出来的却是 B。
    //    引用着提示发指令时，把原文里那个人名认出来，去服务端挑回**原来那一场**。
    let wantNick = ''
    const quoted = await readQuoted(e).catch(() => null)
    if (quoted) {
      // 提示原文形如「<名字> 已经开局 N 分钟了\n要不要开一路观战？发 #营地开播」
      const m = quoted.match(/^(.+?)\s*已经开局\s*\d+\s*分钟/)
      if (m) wantNick = m[1].trim()
      if (!wantNick) {
        // 认得出是我们的提示但取不出名字 → 说明一声，别默默开了别人那一场
        logger.mark(`[营地观战] 引用的是开播提示但认不出人名：${quoted.slice(0, 40)}`)
      }
    }

    let data
    try {
      const q = `/api/hint/latest?group=${encodeURIComponent(gid)}` +
        (wantNick ? `&nick=${encodeURIComponent(wantNick)}` : '')
      data = await callApi(q)
    } catch (error) {
      logger.error(`[营地观战] 取开播提示失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
    if (!data?.ok) return e.reply(`拿不到开播提示\n${data?.error || '稍后再试'}`, shouldQuote())

    const hint = data.hint
    if (!hint?.battleID) {
      // 引用着某条提示、但那条已经不在了（超时 40 分钟 / 服务重启过）—— 说清楚，
      // 别让人以为「本群还没有提示」是自己看错了
      if (wantNick) {
        return e.reply(`「${wantNick}」那条开播提示已经过期了\n发送 #营地观战 看看现在谁在打`, shouldQuote())
      }
      return e.reply('本群还没有开播提示\n发送 #营地观战 看看好友里谁在打', shouldQuote())
    }
    // ⚠️ 群里有好几场提示、用户又没引用时，提醒一句「这次开的是谁」——
    //    免得他以为开的是刚才那条（多提示场景下最容易误会的就是这一点）
    if (!wantNick && Number(data.total || 0) > 1) {
      const names = (data.list || []).map(h => h.nick).filter(Boolean).slice(0, 3).join('、')
      logger.mark(`[营地观战] 本群有 ${data.total} 条提示（${names}），开的是最新那条「${hint.nick}」`)
    }

    // 现查：这一局还在不在。对局结束后营地不会立刻清 battleId，所以不能只看「有没有值」，
    // 要比 battleId 是否还是同一局 —— 变了说明他开了下一把，那这一场也已经结束了。
    //
    // ⚠️ **不带 `refresh=1`**：那会强制绕过服务端 90 秒缓存，每次开播都把池子里所有账号
    //    挨个查一遍（一个请求/账号）。群里几个人连着发 `#营地开播` 就是连打，有频控风险
    //    （命中要静默 12 小时）。缓存最多旧 90 秒，对「这局还在不在」这个判断完全够用 ——
    //    真要是刚好在这 90 秒里打完了，`/api/start` 那边取流会回 -1005，照样兜得住。
    // ⚠️ 复查要**带上这一场的账号范围**（owners / watcher），别裸调 `/api/friends`：
    //    服务端对空 watchers 会退回「整个账号池」（wanted=null），缓存 key 还变成 '*'
    //    —— 跟 scoped 的桶是两份缓存。也就是说，为了确认「这局还在不在」，
    //    反而把池子里每个号都探了一遍，跟上面「不带 refresh 防频控」的初衷正好相反。
    //    用 owners（= 当初能看到这个好友的那些账号）最准：那一场本来就是它们看到的。
    //
    // ⚠️⚠️ **scope 为空时仍要裸查一次**（2026-10-02 补，别改成「跳过复查」）：
    //    正常路径下 `sendHint` 已经把 watcher/owners/userID/roleId 一起记进来了，scope 不该为空。
    //    为空只可能是「旧版本记下的 hint」（那时只发 battleID+campId）——
    //    这种情况 **`hint.userID` 也是 0**，而 `/api/start` 缺 userID 会直接回
    //    「缺参数：battleID / userID」。所以这次裸查不只是复查「这局还在不在」，
    //    更是**取回 userID / roleId 的唯一途径**，跳过它等于把旧 hint 彻底堵死。
    //    代价：裸查会退回整个账号池（7 个号各一次请求，实测 0.7 秒），
    //    比 scoped 的 1 次多，但只发生在旧 hint 上 —— 发一条日志留痕，别默默打。
    const scope = (Array.isArray(hint.owners) && hint.owners.length ? hint.owners : [hint.watcher]).filter(Boolean)
    if (!scope.length) {
      logger.mark(`[营地观战] hint 没带账号范围（${hint.battleID}），退回整池复查以取回 userID`)
    }
    let now
    try {
      now = await callApi('/api/friends' + (scope.length ? `?watchers=${encodeURIComponent(scope.join(','))}` : ''))
    } catch (error) {
      logger.error(`[营地观战] 开播前复查失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
    const still = (now?.playing || []).find(p => String(p.battleId) === String(hint.battleID))
    if (!still) {
      // ⚠️⚠️ 「复查查不到」≠「打完了」（2026-10-05 修）。现象：刚推完「开局 4 分钟」的
      //    提示，群友立刻发 #营地开播，却被回「这一局已经打完了」——4 分钟的排位不可能
      //    秒结束，是假阴性。来源有两个：① 复查这一发里相关账号的查询当场失败
      //    （接口抖动 / 频控），数据里其实缺了那个号；② 行被「隐私/模式」预筛摘掉了。
      //    两种情况都要给**能区分的文案**，让人重试，别一口咬死「打完了」。
      const scopeStr = scope.map(String)
      const failed = (Array.isArray(now?.bad) ? now.bad : []).map(String)
      if (failed.length && scopeStr.some(id => failed.includes(id))) {
        logger.mark(`[营地观战] 复查时账号 ${failed.join('、')} 查好友名单失败，先不算打完（hint ${hint.battleID}）`)
        return e.reply(
          '营地接口刚才抽风了，没能确认这一局还在不在（不一定是打完了）\n稍等十几秒重发一次 #营地开播',
          shouldQuote()
        )
      }
      // 提示里那一场被预筛摘掉了 → 营地当前说「看不了」（隐私 / 非排位巅峰 / 接口抽风）
      const dropped = Array.isArray(now?.dropped) ? now.dropped : []
      const dropHit = dropped.find(d =>
        (hint.roleId && String(d.roleId) === String(hint.roleId)) ||
        (hint.nick && String(d.nick || '') === String(hint.nick)))
      if (dropHit) {
        logger.mark(`[营地观战] 复查时那一局被预筛摘掉（${dropHit.reason}），去流里决定（hint ${hint.battleID}）`)
        return e.reply(
          '营地这会儿说这一局「看不了」（可能是开了战绩隐私，也可能是接口抽风）\n稍等重发 #营地开播，或发 #营地观战 看看其它对局',
          shouldQuote()
        )
      }
      // TA 还在打、只是已经换了一局（秒开下一把 / 提示太旧）→ 给句实话，别让人以为提示是假的
      const next = (now?.playing || []).find(p =>
        (hint.roleId && String(p.roleId) === String(hint.roleId)) ||
        (hint.nick && (String(p.nick || '') === String(hint.nick) || String(p.campNick || '') === String(hint.nick))))
      if (next) {
        return e.reply(
          `刚才那一局已经打完了，TA 现在开了新的一局\n发 #营地观战 列表 选「${next.nick || next.campNick || hint.nick}」开播，或等新的开播提示`,
          shouldQuote()
        )
      }
      return e.reply('这一局已经打完了\n发送 #营地观战 看看最新名单', shouldQuote())
    }

    // ⚠️ 「正在开播…稍等」交给 `launch` 判（`still.canWatch === false` 时它会跳过）——
    //    这一路没号可用时服务端立刻回 no-account，先说「稍等」等于让人白等一场（2026-10-05 修）
    // ⚠️ 走同一个 launch：账号被占时也会问「要不要中断上一路」（和 `#营地观战 N` 一致）
    return this.launch(e, {
      // ⚠️ watcher 只是首选；被占时服务端从 owners 里挑另一个也能看到 TA 的空闲账号
      watcher: still.watcher || hint.watcher,
      owners: still.owners || hint.owners || [],
      battleID: still.battleId,
      // ⚠️ 两个 ID 都要发：服务端拿 userID 取流、拿 roleId 轮询「这局还在不在」
      userID: still.userId,
      roleId: still.roleId,
      // ⚠️ `campNick` 是营地昵称兜底，原先这里漏了它（只有 `#营地观战 N` 那条带了）——
      //    两个名字都取不到时会回一句「正在开播「对局」」，很怪（2026-10-05 修）
      nick: still.nick || still.campNick || hint.nick
    }, { label: still.nick || still.campNick || hint.nick, canWatch: still.canWatch })
  }

  /**
   * 收工：只停**自己开的**那几路。
   *
   * ⚠️ 多路之后这条必须按发起人停 —— 裸「停」原先是全停，
   *    群里谁顺手发一句就会把别人正在看的直播间一起掐掉（实测两路全灭）。
   *    要全停请发「#营地观战 停全部」。
   */
  async stopMine (e) {
    // ⚠️ 拿不到发起人 QQ 就别发这个请求：服务端按 owner 停，空 owner 会掉进
    //    「没 rid 就全停」的分支，把别人正在看的几路一起掐掉（服务端已加拒空，
    //    这里再挡一道，用户看到的是人话而不是「停不了」）
    const me = String(e.user_id || '')
    if (!me) return e.reply('认不出你是哪个号，发不了停止\n请主人发 #营地观战 停 全部 收工', shouldQuote())
    try {
      const res = await callApi('/api/stop', {
        method: 'POST',
        body: { owner: me }
      })
      if (!res?.ok) return e.reply(`停不下来：${res?.error || '稍后再试'}`, shouldQuote())
      const n = Number(res.stopped || 0)
      return e.reply(
        n ? `已停止你开的 ${n} 路观战` : '你没有正在播的观战\n发 #营地观战 在播 看现在有哪几路',
        shouldQuote()
      )
    } catch (error) {
      logger.error(`[营地观战] 停止失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
  }

  /** 收工：全部停掉（别的群友开的那几路也会停，所以文案要说清） */
  async stopAll (e) {
    try {
      const res = await callApi('/api/stop', { method: 'POST', body: { owner: '*' } })
      if (!res?.ok) return e.reply(`停不下来：${res?.error || '稍后再试'}`, shouldQuote())
      const n = Number(res.stopped || 0)
      return e.reply(n ? `已停止全部 ${n} 路观战` : '现在没有在播的观战', shouldQuote())
    } catch (error) {
      logger.error(`[营地观战] 停止失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
  }

  /** 收工：只停第 N 路（编号看 #营地观战 在播） */
  async stopOne (e, n) {
    let data
    try {
      data = await callApi('/api/rooms')
    } catch (error) {
      logger.error(`[营地观战] 取直播间列表失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
    const list = data?.rooms || []
    const target = list[n - 1]
    if (!target) {
      return e.reply(
        list.length
          ? `没有第 ${n} 路，现在有 ${list.length} 路\n发 #营地观战 在播 看编号`
          : '现在没有在播的观战',
        shouldQuote()
      )
    }
    try {
      const res = await callApi('/api/stop', { method: 'POST', body: { rid: target.rid } })
      if (!res?.ok) return e.reply(`停不下来：${res?.error || '稍后再试'}`, shouldQuote())
      return e.reply(`已停止「${target.nick || target.rid}」这一路`, shouldQuote())
    } catch (error) {
      logger.error(`[营地观战] 停止失败: ${error.message}`)
      return e.reply(this.serviceDownText(error), shouldQuote())
    }
  }

  /**
   * 服务没起来时的提示：说清发生了什么 + 下一步做什么。
   *
   * ⚠️ 看到这句的**多半不是主人**（群友发 #营地观战 也会撞上），所以别写
   * 「请主人发 #王者设置」那种只有主人能做的事 —— 对方照着做不了，只会来问。
   * 统一指向「进群找主人要地址和令牌」这条对谁都成立的路。
   */
  serviceDownText (error) {
    const hint = /abort|timeout/i.test(error?.message || '')
      ? '观战服务没响应'
      : '观战服务没在跑'
    // ⚠️ 连远端那条路要的是对方的**控制面**地址，而控制面默认只绑对方本机回环 ——
    //    所以文案里得说清「要对方专门开出来」，不然群友会以为随手填个地址就行
    //    （2026-10-05 修：原来只说「地址找部署方要」，拿到播放面地址就是死局）
    return `${hint}\n自己装一套：进群 972915804 找主人要部署地址和令牌，` +
      '请主人发 #营地观战接入 <地址> <令牌>；' +
      '用别人跑着的：要对方把**控制面**开出来，再请主人发 #营地观战连接 <控制面地址>'
  }

  async shot (view) {
    try {
      return await puppeteer.screenshot('WatchBattle', {
        imgType: getImgType(),
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/WatchBattle.html',
        // 漏了这行样式表会 404，出的是纯文字图
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        title: '营地观战',
        subText: '好友里正在打的对局',
        ...view
      })
    } catch (error) {
      logger.error(`[王者营地观战] 渲染失败: ${error.message}`)
      return null
    }
  }

  /** 出图挂了时的纯文字兜底 */
  renderText (playing, data = {}) {
    const lines = ['🎮 营地观战']
    if (!playing.length) {
      lines.push('', '好友里现在没人在打')
      if (data.online) lines.push(`有 ${data.online} 人在线但没开局`)
      return lines.join('\n')
    }
    lines.push('', `⚔️ 正在对局（${playing.length}）`)
    playing.forEach((p, i) => {
      const mins = p.startTs ? Math.max(0, Math.floor((Date.now() - p.startTs) / 60000)) : 0
      const extra = [p.jobName, mins ? `开局 ${mins} 分钟` : ''].filter(Boolean).join(' · ')
      // ⚠️⚠️ 必须用**服务端算好的** `canWatch`，别用 `i < free` ——
      //    `free` 是**全体账号**口径（池子里还有几个空闲号），而这一行能不能开取决于
      //    「这个好友能被哪几个账号看到、其中有没有空闲的」，两者不是一回事。
      //    用 `i < free` 会**报错行**：可能标着能看、实际开播时 pickWatcher 挑不出号
      //    （出图那份 rows 早就改对了，这里漏改 —— 出图挂了时用户反而看到错的）。
      const can = p.canWatch === false ? '（账号占着）' : ''
      lines.push(`${i + 1}. ${p.nick || p.campNick}${extra ? `（${extra}）` : ''}${can}`)
    })
    lines.push('', '发送 #营地观战 序号 开播')
    return lines.join('\n')
  }
}
