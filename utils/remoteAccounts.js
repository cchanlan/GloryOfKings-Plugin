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

/** 两个服务端都有的状态接口 —— 拿它当「这个地址到底是不是个服务端」的探针 */
export const STATUS_PATH = '/api/status'

/**
 * 探一下这个地址是不是活着的观战/消息服务（GET /api/status）。
 *
 * 「连接」指令用它做**先试连再落盘**：地址写错了要当场知道，
 * 而不是等发 `#营地观战` 时才报一句看不懂的错。
 *
 * ⚠️ 顺便拦一类常见坑：**把「分发服务」的地址当成观战服务填**。
 *    分发服务（gok-share，发代码包的那个）也跑在 http 上、也要令牌，
 *    但它的 `/api/status` 是 404 —— 只回一句 `not_found`，
 *    用户完全看不出「我填错服务了」。这里替他把话说清楚。
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
