/**
 * 「连别人的服务端」时，把本机的营地账号递给那台服务端。
 *
 * ## 为什么需要这一步
 *
 * 观战 / 营地消息两个服务端读的都是**它自己那台机器**上的 `data/AuthPool.json`
 * （见 `server/lib/camp.js` 与 `server-im/camp-im-server.js` 里的 POOL）。
 * 插件和服务端同机时，两边天然共享同一份文件，什么都不用做 ——
 * 这也是原来唯一支持的形态。
 *
 * 但插件连的是**别人的**服务端时，账号登录态只写在**插件这台机器**上：
 *   · 插件侧显示「扫码登录成功，已绑定」
 *   · 服务端的池子里却没有这个号 → 查好友回空 / 回一句「这些账号都不在登录态池子里」
 * 表现就是**登录明明成功，一发观战还是取不到好友**。
 *
 * 所以每次调远端之前，把本机的全局账号 POST 给服务端的 `/api/accounts`。
 * 那边**只存内存、不落盘**（TTL 见服务端的 `setRuntimeAccounts`），进程重启即失效。
 *
 * ## 什么时候不用传
 *
 * 服务地址是本机回环（`127.0.0.1` / `localhost` / `::1`）时直接跳过 ——
 * 同机时服务端自己就能读到 AuthPool.json，传一遍纯属白费。
 * 局域网、公网地址一律要传（服务端在另一台机器上，文件不共享）。
 *
 * ## 节流
 *
 * 两个功能都是高频调用（拉消息默认 3 秒一轮），所以带**指纹 + 60 秒**双重节流：
 * 账号没变就一分钟报一次（够续上服务端的 TTL），指纹一变立刻上报。
 */
import authStore, { isUsableAuth } from './authStore.js'

/** 状态接口。⚠️ 它在**两个面上都有**，所以只能证明「这是个服务」，证明不了「控制面在这」 */
export const STATUS_PATH = '/api/status'

/**
 * ⭐ **只在控制面存在**的探针接口。
 *
 * ⚠️⚠️ 为什么不能再用 `/api/status` 当探针（2026-10-05 修）：服务端从 2026-10-05 起
 *    把控制面（开播/停止/好友名单/账号）拆到了**本机回环**的 8898，播放面（8899，公网）
 *    只留下播放页要用的 `/api/status`、`/api/record/*`。
 *    而 `#营地观战连接` 原来正是拿 `/api/status` 探活 —— 那个接口**在播放面上也通**，
 *    于是：
 *      · 用户填的地址是对方的**播放面**（外网唯一能填的）
 *      · 探测**必定成功** → 插件报「✅ 已连接这个观战服务」并写进配置
 *      · 之后每一次调用（`/api/friends` `/api/start` …）全是 **404 没有这个接口**
 *    等于把用户引进一个「连上了但什么都干不了」的死局，而且提示完全看不出来。
 *
 *    `/api/rooms` 是控制面独有的**只读、零营地请求**接口，正好当探针：
 *    它通 = 这个地址确实是可指挥的控制面；它 404 = 那是播放面（或根本不是我们的服务）。
 */
export const CONTROL_PATH = '/api/rooms'

/**
 * 探一下这个地址是不是活着的**控制面**（能开播/能取名单的那个面）。
 *
 * 三层判据，为的是把「填错面」和「填错服务」分开说清楚：
 *   ① `/api/rooms` 通 → 控制面，可用
 *   ② `/api/rooms` 404 但 `/api/status` 通 → **这是播放面**（或老版本服务端被拆开之后
 *      只剩播放面）：插件指挥不动它，得换成控制面地址
 *   ③ 两个都不通 → 根本不是我们的服务（比如填成了分发服务）
 *
 * @returns {Promise<{ok: boolean, kind?: 'control'|'playback'|'unknown', status?: object,
 *                    accounts?: number, message?: string}>}
 */
export async function probeControl (base, { timeout = 8000 } = {}) {
  const url = String(base || '').replace(/\/+$/, '')
  if (!url) return { ok: false, kind: 'unknown', message: '还没填服务地址' }

  const getJson = async path => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeout)
    try {
      const r = await fetch(url + path, { signal: ctl.signal })
      if (r.status === 401) return { status: 401, data: null }
      const data = await r.json().catch(() => null)
      return { status: r.status, data }
    } catch (error) {
      return { status: 0, data: null, error }
    } finally {
      clearTimeout(timer)
    }
  }

  // ① 控制面独有的接口
  const ctrl = await getJson(CONTROL_PATH)
  if (ctrl.status === 401) {
    return { ok: false, kind: 'control', message: '这个服务设了口令，插件连不上（让对方去掉服务端口令）' }
  }
  if (ctrl.data?.ok) {
    return { ok: true, kind: 'control', status: ctrl.data, accounts: Number(ctrl.data.accounts || 0) }
  }

  // ② 退一步看它是不是「播放面」——/api/status 在两个面上都有
  const play = await getJson(STATUS_PATH)
  if (play.data?.ok) {
    return {
      ok: false,
      kind: 'playback',
      message: '这个地址是**播放面**（群友看直播用的那个端口），插件要指挥的是**控制面**' +
        '（默认 127.0.0.1:8898，只管本机）。要连别人部署的，得让对方把控制面开出来并给你地址；' +
        '否则就在本机自己部署一套（#营地观战接入）'
    }
  }

  // ③ 什么都不是
  if (ctrl.status === 404 || play.status === 404) {
    return {
      ok: false,
      kind: 'unknown',
      message: '这个地址不是观战/消息服务（观战和消息各是一个独立服务，不是发代码包的那个分发服务）'
    }
  }
  const timeoutHit = /abort|timeout/i.test(ctrl.error?.message || play.error?.message || '')
  return { ok: false, kind: 'unknown', message: timeoutHit ? '服务没响应' : '连不上这个地址' }
}

/**
 * 探一下这个地址是不是活着的观战/消息服务（GET /api/status）。
 *
 * ⚠️ `#营地消息连接` 那边也用它。⚠️ 它**证明不了控制面**（那个接口两个面都有）——
 *    要判断「能不能指挥」，用上面的 `probeControl`。
 */
export async function probeRemoteStatus (base, { timeout = 8000 } = {}) {
  const url = String(base || '').replace(/\/+$/, '')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const r = await fetch(url + STATUS_PATH, { signal: ctl.signal })
    // ⚠️ 插件**不带口令**。对方服务端要是设了 GOK_*_TOKEN，这里就会撞 401。
    //    而插件没地方填口令 —— 所以别说「口令不对」（用户没法改），
    //    直接告诉他一条走得通的路：让对方去掉那个口令。
    if (r.status === 401) {
      return { ok: false, message: '这个服务设了口令，插件连不上（让对方去掉服务端口令）' }
    }
    const data = await r.json().catch(() => null)
    if (!data?.ok) {
      return {
        ok: false,
        message: r.status === 404
          ? '这个地址不是观战/消息服务（观战和消息各是一个独立服务，不是发代码包的那个分发服务）'
          : `服务返回异常`
      }
    }
    return { ok: true, status: data, accounts: Number(data.accounts || 0) }
  } catch (error) {
    const timeoutHit = /abort|timeout/i.test(error?.message || '')
    return { ok: false, message: timeoutHit ? '服务没响应' : '连不上这个地址' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 这个地址是不是「别人家的」。
 *
 * ⚠️ 只把 loopback 当本机：同机部署时服务端读得到 AuthPool.json，不用传。
 *    局域网 IP（192.168.x.x 之类）算远端 —— 那多半是另一台机器。
 */
export function isRemoteBase (base = '') {
  const host = String(base)
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
  return !/^(127\.|localhost\b|\[::1\]|::1\b|0\.0\.0\.0)/.test(host)
}

/** 本机「能用来查好友 / 取流」的全局账号（服务端要的就是这批） */
function usableGlobalAccounts () {
  const accounts = {}
  for (const account of authStore.listAccounts()) {
    if (!account.isGlobalDefault || account.authInvalid || !isUsableAuth(account)) continue
    accounts[account.userId] = account
  }
  return accounts
}

/**
 * 指纹：id + 登录态最后更新时间。
 * 重新扫码会刷新 updatedAt —— 那一变就必须立刻重报，不能等节流窗口过去。
 */
function fingerprint (accounts) {
  return Object.keys(accounts).sort()
    .map(id => `${id}:${accounts[id].updatedAt || ''}`)
    .join('|')
}

/** 指纹没变时的最小上报间隔 */
const REPORT_MIN_MS = 60 * 1000
/** 上次上报记录：服务地址 → { fp, at } */
const lastReport = new Map()

/**
 * 把本机全局账号递给服务端。
 *
 * ⚠️ **失败不影响主流程**，调用方不用管返回值：
 *    服务端本来就有这些号（同机部署）时这次请求纯属多余；
 *    真没有的话，下一次查询会回「账号不在登录态池子里」，那是更准的信号。
 *
 * @param {string} base 服务地址（观战 / 消息各自的）
 * @param {{force?: boolean, timeout?: number}} [opts]
 */
export async function reportRemoteAccounts (base, { force = false, timeout = 8000 } = {}) {
  const url = String(base || '').replace(/\/+$/, '')
  if (!url || !isRemoteBase(url)) return { ok: true, skipped: 'local' }

  const accounts = usableGlobalAccounts()
  const ids = Object.keys(accounts)
  if (!ids.length) return { ok: false, skipped: 'no-account' }

  const fp = fingerprint(accounts)
  const prev = lastReport.get(url)
  if (!force && prev && prev.fp === fp && Date.now() - prev.at < REPORT_MIN_MS) {
    return { ok: true, skipped: 'throttled' }
  }

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeout)
  try {
    const r = await fetch(`${url}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accounts }),
      signal: ctl.signal
    })
    const data = await r.json().catch(() => ({}))
    // 只有真送进去了才记节流点：被 401 挡回来时下次还得再试
    if (data?.ok) lastReport.set(url, { fp, at: Date.now() })
    else logger.warn(`[远端账号] 上报被拒（HTTP ${r.status}）${data?.error || ''}`)
    return { ...data, ok: Boolean(data?.ok) }
  } catch (error) {
    // 连不上/超时：静默交给主流程兜（下面那次真正的查询会把原因暴露得更准）
    return { ok: false, error: error?.message || String(error) }
  } finally {
    clearTimeout(timer)
  }
}
