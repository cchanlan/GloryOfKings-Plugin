/**
 * 开黑房间的 HTTP 客户端。打的是**分发服务**（`distUrl` / 6868），不是共享库。
 *
 * ## 为什么挂在分发服务上
 *
 * 共享库（`shareApiUrl`）是别人搭的，只有 `/api/v1/bind` 那三个口，加接口不在我们手里。
 * 分发服务是主人自己的，而且**接入方早就填好了地址和令牌**（为了拉观战/消息的服务端包），
 * 令牌还是「一把通吃三套」的那一把 —— 所以开黑对用户来说是零配置，升级插件就能用。
 *
 * ## 三条自我约束（同 shareStore）
 *
 * 1. **绝不抛异常**。服务端随时可能在部署，它挂了只能是「这次开黑用不了」，
 *    不能让别的王者指令跟着失败。
 * 2. **业务拒绝和网络故障必须分开**。服务端对「房号不存在」「分路被占」回的是
 *    409/404 + 一句人话，那句要原样给用户看；而 ECONNREFUSED 这种只能说「连不上」。
 *    混在一起用户就会看到「共享库返回 409」这种天书。
 * 3. **轮询失败要熔断**。30 秒一轮的东西，服务端下线时不能每轮都干等 2 秒。
 */
import fetch from 'node-fetch'
import { Config } from '#components'
import { normalizeBase } from './deploy.js'

/** 指令是用户当场在等的，给足一点；轮询那条单独短一些 */
const WRITE_TIMEOUT_MS = 6000
const POLL_TIMEOUT_MS = 4000

/** 连续失败几次开始熔断，以及退避区间 */
const CIRCUIT_THRESHOLD = 3
const CIRCUIT_BASE_MS = 60 * 1000
const CIRCUIT_MAX_MS = 10 * 60 * 1000

/**
 * ⚠️ 状态**必须锚在 globalThis 上**：JiuLi 热重载会给 plugins/ 下每个模块追加
 *    `?jiuli_reload=<代数>` 重新求值，模块级变量会出现多份（同 shareStore 的 STATE_KEY，
 *    那边真踩过「多份实例各写各的缓存、互相抹数据」）。
 */
const STATE_KEY = '__gokTeamClientState'
const holder = (globalThis[STATE_KEY] ||= {})
const circuit = (holder.circuit ||= { failures: 0, openUntil: 0, backoffMs: CIRCUIT_BASE_MS })
const warnAt = (holder.warnAt ||= new Map())

function warnOnce (key, message) {
  const now = Date.now()
  if (now - (warnAt.get(key) || 0) < 300000) return
  warnAt.set(key, now)
  try { logger?.warn?.(message) } catch {}
}

/**
 * 读分发服务的地址和令牌。每次现读 —— 锅巴里改完立刻生效（Config 有文件监听）。
 *
 * 令牌回退读 `shareToken`：三套服务合并令牌之前配过的机器不用重新填
 * （和 shareStore.readShareConfig 保持同一套回退规则）。
 */
export function readTeamConfig () {
  try {
    const cfg = Config.getDefOrConfig('config') || {}
    return {
      url: normalizeBase(cfg.distUrl || ''),
      token: String(cfg.distToken || cfg.shareToken || '').trim(),
      enabled: cfg.teamUpEnabled !== false
    }
  } catch {
    return { url: '', token: '', enabled: false }
  }
}

/** 地址和令牌都齐了才算能用 */
export function isTeamReady () {
  const cfg = readTeamConfig()
  return Boolean(cfg.enabled && cfg.url && cfg.token)
}

/**
 * 没配好时给用户看的那句。
 *
 * 按「只说做什么、要用户动手的给全路径」写 —— 两条路都给到能直接照做的程度：
 * 一句指令，或者锅巴上那两格的确切名字（分组名 + 字段名，少一个就得自己翻页找）。
 */
export const TEAM_NOT_READY_HINT =
  '开黑要先接入服务端：让机器人主人发 #营地观战接入 <地址> <令牌>，' +
  '或在锅巴面板「王者荣耀插件 → 服务端接入」里填上「分发服务地址」和「接入令牌」'

function circuitOpen () {
  return Date.now() < circuit.openUntil
}

function recordFailure () {
  circuit.failures += 1
  if (circuit.failures >= CIRCUIT_THRESHOLD) {
    circuit.openUntil = Date.now() + circuit.backoffMs
    circuit.backoffMs = Math.min(circuit.backoffMs * 2, CIRCUIT_MAX_MS)
    warnOnce('circuit', `[开黑] 连续失败 ${circuit.failures} 次，暂停 ${Math.round(circuit.backoffMs / 1000)} 秒后再试`)
  }
}

function recordSuccess () {
  circuit.failures = 0
  circuit.backoffMs = CIRCUIT_BASE_MS
  circuit.openUntil = 0
}

/** 手动复位。服务端刚恢复、但退避还没走到时用得上（也给脱机测试用） */
export function resetTeamCircuit () {
  recordSuccess()
}

/**
 * 发一次请求。
 *
 * @returns {Promise<object>} 一律是 `{ok: boolean, ...}`，**绝不抛**。
 *   业务拒绝：原样带回服务端的 `{ok:false, error, message}`
 *   网络故障：`{ok:false, error:'network'|'timeout'|'circuit', message:<人话>}`
 *   没升级：  `{ok:false, error:'not_supported', message:<人话>}`
 */
async function request (method, pathname, { body, query, timeout } = {}) {
  const cfg = readTeamConfig()
  if (!cfg.enabled) return { ok: false, error: 'disabled', message: '开黑功能在锅巴里关掉了' }
  if (!cfg.url || !cfg.token) return { ok: false, error: 'not_ready', message: TEAM_NOT_READY_HINT }

  if (circuitOpen()) {
    return { ok: false, error: 'circuit', message: '服务端暂时连不上，过几分钟再试' }
  }

  const qs = query ? `?${new URLSearchParams(query)}` : ''

  try {
    const response = await fetch(`${cfg.url}/api/v1/team${pathname}${qs}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.token}`
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout || WRITE_TIMEOUT_MS)
    })

    // 404 在这里有两种含义，必须分开：
    //   · 带 JSON 体的 `no_such_room` —— 业务结果（房号不存在），下面统一处理
    //   · 不带体 / `not_found` —— **服务端还没升级**，根本没有这组接口。
    //     这条一定要说清楚，否则主人会以为是自己配错了地址
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }

    if (response.status === 401) {
      recordSuccess() // 连得上，是令牌问题，不该触发熔断
      return { ok: false, error: 'bad_token', message: '令牌无效，找机器人主人要一个新的' }
    }
    if (response.status === 403) {
      recordSuccess()
      return { ok: false, error: 'token_revoked', message: '令牌已被吊销，找机器人主人要一个新的' }
    }
    if (response.status === 404 && (!data || data.error === 'not_found')) {
      recordSuccess()
      return {
        ok: false,
        error: 'not_supported',
        message: '服务端还不支持开黑，等主人升级一下'
      }
    }

    recordSuccess()

    if (data && typeof data === 'object') return data

    return { ok: false, error: 'bad_response', message: `服务端返回了 ${response.status}` }
  } catch (error) {
    recordFailure()
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    warnOnce(
      `req:${pathname}`,
      `[开黑] ${method} ${pathname} 失败：${error?.message || error}`
    )
    return timedOut
      ? { ok: false, error: 'timeout', message: '服务端响应太慢，稍后再试' }
      : { ok: false, error: 'network', message: '连不上服务端，稍后再试' }
  }
}

/** 建房。payload 见服务端 team.mjs 的 createRoom */
export function teamCreate (payload) {
  return request('POST', '/create', { body: payload })
}

export function teamJoin (payload) {
  return request('POST', '/join', { body: payload })
}

export function teamLeave (payload) {
  return request('POST', '/leave', { body: payload })
}

export function teamClose (payload) {
  return request('POST', '/close', { body: payload })
}

/**
 * 拉变更。`since` 是上次拿到的 rev —— 相等时服务端只回几十字节。
 *
 * ⚠️ 水位用服务端的 `rev` 而不是时间戳：十几台接入方各自计时，
 *    拿本地时间当水位的话，时钟快的那台会漏播、慢的会重播（刷屏）。
 */
export function teamList (since = 0) {
  return request('GET', '/list', { query: { since: String(Number(since) || 0) }, timeout: POLL_TIMEOUT_MS })
}

/** 池子概况。排查用，不含任何隐私字段 */
export function teamStats () {
  return request('GET', '/stats', { timeout: POLL_TIMEOUT_MS })
}
