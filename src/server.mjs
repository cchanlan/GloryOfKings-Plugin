/**
 * 服务组装：中间件链 + 路由分发 + 生命周期。
 *
 * 请求处理顺序（任何一步失败都直接回错误，不会继续往下走）：
 *   按 IP 令牌桶 → 健康检查（免鉴权） → 管理面（admin secret） → 数据面（Bearer token） → 404
 */
import http from 'node:http'
import { assertRuntime, loadConfig } from './config.mjs'
import { openDatabase, SCHEMA_VERSION } from './db.mjs'
import { clientIp, HttpError, sendError, sendJson } from './http.mjs'
import { parseTokenClientId, sha256Hex } from './crypto.mjs'
import { Cooldown, FailureBan, TokenBucket, WindowCounter } from './ratelimit.mjs'
import { authenticate, purge, touchClient, writeAudit } from './store.mjs'
import { bindRoutes } from './routes/bind.mjs'
import { adminRoutes } from './routes/admin.mjs'

/**
 * 单 IP 的限流额度。默认 120 次/分钟、允许 60 次突发，可用环境变量调。
 *
 * 客户端那边每条指令最多问一次（本地只有 5 秒防抖，没变更时服务端只回 40 字节），
 * 正常使用远够。但多个 bot 挤在同一个 NAT 或反代后面时它们**共用一个 IP**，
 * 那种部署就得把额度放大 —— 所以这两个值是可配的。
 */
const DEFAULT_IP_RATE_PER_MINUTE = 120
const DEFAULT_IP_BURST = 60

/** 全局读上限。自保用：被当成免费代理刷时至少不会把库拖垮 */
const GLOBAL_READ_PER_MINUTE = 1000

/** 连接上限与单请求硬超时 */
const MAX_CONNECTIONS = 256
const REQUEST_TIMEOUT_MS = 15000

const startedAt = Date.now()
let db = null

function log (level, message) {
  const line = `[gok-share] ${new Date().toISOString()} ${message}`
  if (level === 'error') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

/**
 * 4xx 是预期内的（扫描器撞 401、客户端配错 token），一分钟同类只留一行；
 * 5xx 才是真出事了，原样带堆栈打出来。
 * 不这么做的话，一个公网上的共享库会被扫描器把日志刷到没法查问题。
 */
const rejectLogAt = new Map()

function reportError (error) {
  const status = Number(error?.status) || 500

  if (status >= 500) {
    log('error', `请求处理出错：${error?.stack || error}`)
    return
  }

  const key = `${status}:${error?.error || ''}`
  const now = Date.now()
  if (now - (rejectLogAt.get(key) || 0) < 60000) return

  rejectLogAt.set(key, now)
  log('warn', `请求被拒绝：${status} ${error?.error || ''}（${error?.message || ''}）`)
}

/** 从 Authorization 头取 Bearer token。绝不接受 query 里的 token——那会进 access log */
function bearerToken (req) {
  const header = String(req.headers.authorization || '').trim()
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match ? match[1].trim() : ''
}

export async function startServer () {
  assertRuntime()

  const config = loadConfig()
  db = openDatabase(config.dbPath)

  const limiters = {
    ipBucket: new TokenBucket(
      config.ipRatePerMinute || DEFAULT_IP_RATE_PER_MINUTE,
      config.ipBurst || DEFAULT_IP_BURST
    ),
    globalRead: new WindowCounter(GLOBAL_READ_PER_MINUTE),
    // (client, qq) 响应冷却，见 ratelimit.mjs
    readCooldown: new Cooldown(1000),
    authBan: new FailureBan({ threshold: 20, windowMs: 60000, banMs: 300000 })
  }

  /** 每日清理任务。用 setInterval + unref 保证它不会吊住进程退出 */
  const cleanupTimer = setInterval(() => {
    try {
      const result = purge(db)
      if (result.binds || result.audits) {
        log('info', `每日清理：过期绑定 ${result.binds} 条、过期审计 ${result.audits} 条`)
      }
    } catch (error) {
      log('error', `清理任务失败：${error.message}`)
    }
  }, 86400000)
  cleanupTimer.unref?.()

  const server = http.createServer((req, res) => {
    handleRequest(req, res, config, limiters).catch(error => {
      reportError(error)
      if (!res.writableEnded) sendError(res, error)
    })
  })

  server.maxConnections = MAX_CONNECTIONS
  server.headersTimeout = REQUEST_TIMEOUT_MS

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    // host 为空就**不传** host，让 Node 自己选：有 IPv6 时绑 `::`（双栈，v4/v6 都通），
    // 没有才退回 `0.0.0.0`。传死 `'0.0.0.0'` 会只剩 IPv4，v6 侧一个字节都进不来。
    if (config.host) server.listen(config.port, config.host, resolve)
    else server.listen(config.port, resolve)
  })

  const addr = server.address()
  log('info', `共享库已启动：http://${addr.address}:${addr.port}（${addr.family}）`)
  log('info', `数据库：${config.dbPath}`)

  const shutdown = signal => {
    log('info', `收到 ${signal}，正在关闭…`)
    server.close(() => {
      try { db?.close() } catch {}
      process.exit(0)
    })
    // 有长连接拖着时最多等 5 秒，别让 pm2 以为进程卡死了
    setTimeout(() => process.exit(0), 5000).unref?.()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  return server
}

async function handleRequest (req, res, config, limiters) {
  res.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.writableEnded) {
      try { res.destroy() } catch {}
    }
  })

  const ip = clientIp(req, config.trustProxy)
  if (limiters.authBan.isBanned(ip)) {
    throw new HttpError(429, 'rate_limited', '尝试次数过多，请稍后再试', { 'Retry-After': '300' })
  }

  if (!limiters.ipBucket.take(ip)) {
    throw new HttpError(429, 'rate_limited', '请求太频繁', { 'Retry-After': '60' })
  }

  const url = new URL(req.url || '/', 'http://localhost')
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  const method = String(req.method || 'GET').toUpperCase()

  // 健康检查免鉴权，但**不返回任何计数**：库有多大是运维信息，不该由公网接口泄露
  if (pathname === '/api/v1/health') {
    if (method !== 'GET') {
      throw new HttpError(405, 'method_not_allowed', '健康检查只支持 GET', { Allow: 'GET' })
    }
    sendJson(res, 200, {
      ok: true,
      service: 'gok-share',
      schema: SCHEMA_VERSION,
      time: Date.now(),
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000)
    })
    return
  }

  const ctx = { req, res, method, pathname, url, db, config, limiters, ip, logger: { warn: m => log('warn', m) } }

  // 管理面自带 admin secret 鉴权，不走 token
  if (await adminRoutes(ctx)) return

  // 其余全是数据面，一律要 Bearer token
  const rawToken = bearerToken(req)
  if (!rawToken) {
    throw new HttpError(401, 'unauthorized', '缺少 Authorization: Bearer <token>')
  }

  const clientId = parseTokenClientId(rawToken)
  if (!clientId) {
    // 格式不对就别查库了，省得给扫描器制造查询量
    limiters.authBan.recordFailure(ip)
    throw new HttpError(401, 'unauthorized', 'token 无效')
  }

  const found = authenticate(db, sha256Hex(rawToken))
  if (!found) {
    if (limiters.authBan.recordFailure(ip)) {
      log('warn', `${ip} 连续认证失败，已临时封禁`)
    }
    throw new HttpError(401, 'unauthorized', 'token 无效')
  }
  // 和「token 抄错了」区分开，方便主人自查是自己吊销过还是配错了
  if (found.disabled) {
    throw new HttpError(403, 'forbidden', 'token 已被吊销')
  }

  limiters.authBan.clear(ip)
  touchClient(db, found.client.id)
  ctx.client = found.client

  // 全局读上限只压查询，写操作本来就受每 client 的小时速率约束
  if (pathname === '/api/v1/bind/query') {
    if (!limiters.globalRead.take()) {
      log('error', '全局读上限被触发，可能有接入方在批量枚举')
      throw new HttpError(429, 'rate_limited', '服务繁忙，请稍后再试', { 'Retry-After': '60' })
    }
  }

  if (await bindRoutes(ctx)) return

  throw new HttpError(404, 'not_found', '没有这个接口')
}

/** 兜住没被 catch 的异常，避免进程直接退出 */
export function installGlobalGuards () {
  process.on('uncaughtException', error => {
    log('error', `未捕获异常：${error?.stack || error}`)
  })
  process.on('unhandledRejection', reason => {
    log('error', `未处理的 Promise 拒绝：${reason?.stack || reason}`)
  })
}
