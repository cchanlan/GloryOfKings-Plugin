/**
 * 管理面：签发/吊销 token、看统计、按明文 QQ 强制删除。
 *
 * 鉴权用 X-Admin-Secret 头配恒时比较，**不走 token 那套**：
 * admin secret 是部署者自己保管的一把钥匙，丢了就改环境变量重启，
 * 不需要在数据库里留任何可被拖库利用的材料。
 *
 * 「按明文 QQ 强制删除」这个接口是必须的：有人拿别人的 QQ 上传了一个不属于他的
 * 营地ID 时，被冒名的人自己没有退出路径（客户端那条撤销只有本人能触发）。
 * 有一个能申诉的出口，才敢把「共享即公开」写成接入方之间的君子协定。
 */
import crypto from 'node:crypto'
import { HttpError, readJsonBody, sendJson } from '../http.mjs'
import { createToken, safeEqualText } from '../crypto.mjs'
import { clip, normalizeId } from '../validate.mjs'
import {
  adminDeleteByQQ, createClient, deleteBind, getClientById, listClients, setClientEnabled, stats, writeAudit
} from '../store.mjs'
import { hashQQ } from '../crypto.mjs'

const MAX_NAME_LENGTH = 60
const MAX_QUOTA = 1000000

/** 校验 X-Admin-Secret。失败时也计入来源封禁，撞库脚本会被拉黑 */
function requireAdmin (ctx) {
  const presented = String(ctx.req.headers['x-admin-secret'] || '')
  if (!presented || !safeEqualText(presented, ctx.config.adminSecret)) {
    if (ctx.limiters.authBan.recordFailure(ctx.ip)) {
      ctx.logger?.warn?.(`[gok-share] ${ctx.ip} 连续认证失败，已临时封禁`)
    }
    // 不区分「没带」和「带错了」，一律同一句话
    throw new HttpError(401, 'unauthorized', '管理密钥不正确')
  }
  ctx.limiters.authBan.clear(ctx.ip)
}

async function handleIssueToken (ctx) {
  const body = await readJsonBody(ctx.req)

  const name = clip(body?.name, MAX_NAME_LENGTH).trim()
  if (!name) {
    throw new HttpError(422, 'invalid_name', 'name 不能为空，用它能认出的名字（比如「某某的机器人」）')
  }

  const quotaPerDay = clampInt(body?.quotaPerDay, 2000, 0, MAX_QUOTA)
  const writePerHour = clampInt(body?.writePerHour, 60, 0, MAX_QUOTA)
  const note = clip(body?.note, 200)

  // 先插入占位行拿到自增 id，token 里要编进这个 id；UNIQUE 约束保证不会撞
  const placeholder = `pending:${crypto.randomUUID()}`
  const id = createClient(ctx.db, {
    name,
    quotaPerDay,
    writePerHour,
    note,
    tokenHash: placeholder,
    tokenPrefix: 'pending'
  })

  const { token, tokenHash, tokenPrefix } = createToken(id)
  ctx.db.prepare('UPDATE clients SET token_hash = ?, token_prefix = ? WHERE id = ?')
    .run(tokenHash, tokenPrefix, id)

  writeAudit(ctx.db, { clientId: id, action: 'token.issue', detail: name })

  sendJson(ctx.res, 201, {
    ok: true,
    id,
    name,
    // 明文 token 只在这里出现这一次，之后管理面只能看到前缀
    token,
    tokenPrefix,
    quotaPerDay,
    writePerHour
  })
}

function clampInt (raw, fallback, min, max) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function handleListTokens (ctx) {
  const rows = listClients(ctx.db)
  sendJson(ctx.res, 200, {
    ok: true,
    clients: rows.map(row => ({
      id: Number(row.id),
      name: row.name,
      tokenPrefix: row.token_prefix,
      quotaPerDay: Number(row.quota_per_day),
      writePerHour: Number(row.write_per_hour),
      enabled: Number(row.enabled) === 1,
      note: row.note,
      createdAt: Number(row.created_at),
      lastSeenAt: Number(row.last_seen_at)
    }))
  })
}

async function handleRotate (ctx, id) {
  const existing = getClientById(ctx.db, id)
  if (!existing) throw new HttpError(404, 'not_found', '没有这个 client')

  const { token, tokenHash, tokenPrefix } = createToken(id)
  ctx.db.prepare('UPDATE clients SET token_hash = ?, token_prefix = ?, enabled = 1 WHERE id = ?')
    .run(tokenHash, tokenPrefix, id)

  writeAudit(ctx.db, { clientId: id, action: 'token.issue', detail: `rotate:${existing.name}` })
  sendJson(ctx.res, 200, { ok: true, id, token, tokenPrefix })
}

function handleRevoke (ctx, id) {
  if (!setClientEnabled(ctx.db, id, false)) {
    throw new HttpError(404, 'not_found', '没有这个 client')
  }

  writeAudit(ctx.db, { clientId: id, action: 'token.revoke', detail: `revoke:${id}` })
  sendJson(ctx.res, 200, { ok: true, id, enabled: false })
}

function handleStats (ctx) {
  sendJson(ctx.res, 200, { ok: true, ...stats(ctx.db) })
}

async function handleForceDelete (ctx) {
  const body = await readJsonBody(ctx.req)

  const qq = normalizeId(body?.qq)
  if (!qq) throw new HttpError(422, 'invalid_qq', 'QQ 号必须是 5~12 位数字')

  const qqHash = hashQQ(ctx.config.salt, qq)
  const deleted = deleteBind(ctx.db, { qqHash })

  writeAudit(ctx.db, { clientId: null, action: 'bind.del', qqHash, detail: `admin-force-delete=${deleted}` })
  sendJson(ctx.res, 200, { ok: true, deleted })
}

/**
 * @param {object} ctx
 * @returns {Promise<boolean>} 是否已处理该请求
 */
export async function adminRoutes (ctx) {
  const { method, pathname } = ctx
  if (!pathname.startsWith('/api/v1/admin/')) return false

  requireAdmin(ctx)

  if (pathname === '/api/v1/admin/tokens') {
    if (method === 'POST') { await handleIssueToken(ctx); return true }
    if (method === 'GET') { handleListTokens(ctx); return true }
    throw new HttpError(405, 'method_not_allowed', '该路径支持 POST 和 GET', { Allow: 'POST, GET' })
  }

  const match = /^\/api\/v1\/admin\/tokens\/(\d+)(\/rotate)?$/.exec(pathname)
  if (match) {
    const id = Number(match[1])
    if (match[2]) {
      if (method !== 'POST') {
        throw new HttpError(405, 'method_not_allowed', '轮换只支持 POST', { Allow: 'POST' })
      }
      await handleRotate(ctx, id)
      return true
    }
    if (method !== 'DELETE') {
      throw new HttpError(405, 'method_not_allowed', '吊销只支持 DELETE', { Allow: 'DELETE' })
    }
    handleRevoke(ctx, id)
    return true
  }

  if (pathname === '/api/v1/admin/stats') {
    if (method !== 'GET') {
      throw new HttpError(405, 'method_not_allowed', '统计只支持 GET', { Allow: 'GET' })
    }
    handleStats(ctx)
    return true
  }

  if (pathname === '/api/v1/admin/binds/delete') {
    if (method !== 'POST') {
      throw new HttpError(405, 'method_not_allowed', '强制删除只支持 POST', { Allow: 'POST' })
    }
    await handleForceDelete(ctx)
    return true
  }

  throw new HttpError(404, 'not_found', '没有这个管理接口')
}
