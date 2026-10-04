/**
 * 营地 IM 服务端的客户端封装（插件端）。
 *
 * 和 `apps/watchBattle.js` 调观战服务是同一套模式：
 *   · 地址每次现读配置（Config 挂了 chokidar，改配置不用重启云崽）
 *   · `AbortController` + `setTimeout` 做超时（不用 `AbortSignal.timeout`，为了 finally 里能 clearTimeout）
 *   · ⚠️ **HTTP 状态码只进日志，不进用户可见文案**（文案约定：不露实现细节）
 *
 * 服务端只做协议（ws 收 / HTTP 发），业务判断全在插件这边。
 */
import { Config } from '#components'
import { reportRemoteAccounts } from './remoteAccounts.js'

/** 配置读取。改成配置项后不用重启（Config 挂了 chokidar） */
function cfg () {
  try { return Config.getDefOrConfig('config') || {} } catch { return {} }
}

/** 服务地址（本机调） */
export function apiBase () {
  return String(cfg().campImApiUrl || 'http://127.0.0.1:8900').replace(/\/+$/, '')
}

/**
 * 调服务端。
 *
 * ⚠️ 连的是**别人的**服务端时，每次调用前先把本机的营地账号递过去
 *    （见 utils/remoteAccounts.js）—— 对方的池子里没有这些号，不递就是
 *    「扫码登录成功、消息却一条都收不到」。本机地址会自动跳过，不多花请求。
 *
 * @param {string} path
 * @param {{method?: string, body?: object|null, timeout?: number}} [opts]
 */
export async function callApi (path, { method = 'GET', body = null, timeout = 15000 } = {}) {
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
      logger.error(`[营地消息] ${path} 返回的不是 JSON（HTTP ${r.status}）`)
      return { ok: false, error: '营地消息服务返回异常' }
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 各账号连接状态 */
export async function getStatus () {
  return callApi('/api/status')
}

/** 拉新消息（since = 上次拿到的最大 id） */
export async function getMessages (since = 0) {
  return callApi(`/api/messages?since=${Number(since) || 0}`)
}

/**
 * 拉某个营地号「在游戏里」的好友（只含 `gameOnline === 1` 的）。
 * @param {string} selfUserId 用哪个营地号去拉
 */
export async function getFriends (selfUserId) {
  return callApi(`/api/friends?selfUserId=${encodeURIComponent(String(selfUserId || ''))}`, { timeout: 30000 })
}

/**
 * 发一条营地消息。
 * @param {{selfUserId: string, toUserId: string, toRoleId?: string, fromRoleId?: string, message: string}} opts
 */
export async function sendMessage (opts) {
  return callApi('/api/send', { method: 'POST', body: opts, timeout: 20000 })
}

/** 启动某些账号的 ws 连接 */
export async function connectAccounts (userIds) {
  return callApi('/api/connect', { method: 'POST', body: { userIds } })
}

/** 停掉某些账号的 ws 连接 */
export async function disconnectAccounts (userIds) {
  return callApi('/api/disconnect', { method: 'POST', body: { userIds } })
}

/**
 * 服务没起来时的提示：说清发生了什么 + 下一步做什么。
 * ⚠️ 不露实现细节（端口、进程名之外的都不写）。
 *
 * ⚠️ 看到这句的**多半不是主人**（群友发指令也会撞上），所以别只写
 * 「请主人发 #营地消息部署」—— 没接入过的话那条也跑不起来。
 * 统一指向「进群找主人要地址和令牌」这条对谁都成立的路。
 */
export function serviceDownText (error) {
  const hint = /abort|timeout/i.test(error?.message || '')
    ? '营地消息服务没响应'
    : '营地消息服务没在跑'
  return `${hint}\n用别人部署好的：请主人发 #营地消息连接 <地址>（地址找部署方要）；` +
    '自己装一套：进群 972915804 找主人要部署地址和令牌，请主人发 #营地消息接入 <地址> <令牌>'
}
