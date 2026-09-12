/**
 * 绑定相关的三个接口：上传（PUT）、撤销（DELETE）、查询（POST query）。
 *
 * 查询刻意用 POST 而不是 GET：QQ 是这套设计里唯一要保护的明文，
 * 放进 URL 就会落进反代的 access log、代理缓存和各种中间层的历史里。
 * token 同理，只走 Authorization 头，不接受 query 传参。
 */
import { HttpError, readJsonBody, sendJson } from '../http.mjs'
import { hashQQ } from '../crypto.mjs'
import { normalizeId, normalizeCampIds } from '../validate.mjs'
import {
  consumeQuota, countRecentWrites, deleteBind, putBind, queryBind, writeAudit
} from '../store.mjs'

/** 取 body 里的 qq 并转成摘要。校验不过一律 422，不回显原值 */
function readQQHash (config, rawQQ) {
  const qq = normalizeId(rawQQ)
  if (!qq) {
    throw new HttpError(422, 'invalid_qq', 'QQ 号必须是 5~12 位数字')
  }
  return hashQQ(config.salt, qq)
}

/**
 * 让该 (client, qq) 的读冷却立刻失效。
 *
 * 不做这一步会有个很难查的体验问题：用户刚 `#开启营地ID共享`（PUT），紧接着发
 * `#查询战绩`（query），拿到的却是 PUT 之前那份 60 秒冷却响应，看起来就像共享没生效。
 */
function invalidateReadCache (ctx, qqHash) {
  ctx.limiters.readCooldown.delete(`${ctx.client.id}:${qqHash}`)
}

/** 写操作的两道闸：小时速率 + 每日配额 */
function guardWrite (ctx) {
  const { db, client } = ctx

  const perHour = Number(client.write_per_hour) || 0
  if (perHour > 0 && countRecentWrites(db, client.id) >= perHour) {
    throw new HttpError(429, 'rate_limited', `写入太频繁（上限 ${perHour} 次/小时），请稍后再试`, {
      'Retry-After': '600'
    })
  }

  const quota = consumeQuota(db, { clientId: client.id, limit: Number(client.quota_per_day) || 0 })
  if (!quota.ok) {
    throw new HttpError(429, 'quota_exceeded', `今日配额已用完（${quota.limit} 次/天），明天重置`, {
      'Retry-After': '3600'
    })
  }
}

/** 读操作只吃每日配额 */
function guardRead (ctx) {
  const { db, client } = ctx
  const quota = consumeQuota(db, { clientId: client.id, limit: Number(client.quota_per_day) || 0 })
  if (!quota.ok) {
    throw new HttpError(429, 'quota_exceeded', `今日配额已用完（${quota.limit} 次/天），明天重置`, {
      'Retry-After': '3600'
    })
  }
}

/**
 * PUT /api/v1/bind —— 上传本 client 对某个 QQ 的全量绑定。
 * 是「本实例的这组记录长这样」，不是「追加」：本实例上删掉一个号能生效，
 * 别的实例写的记录不受影响（见 db.mjs 顶部关于主键的说明）。
 */
async function handlePut (ctx) {
  guardWrite(ctx)

  const body = await readJsonBody(ctx.req)
  const qqHash = readQQHash(ctx.config, body?.qq)

  const parsed = normalizeCampIds(body?.campIds)
  if (!parsed.ok) {
    writeAudit(ctx.db, { clientId: ctx.client.id, action: 'bind.put', qqHash, ok: false, detail: parsed.error })
    throw new HttpError(422, parsed.error, parsed.message)
  }

  // current 允许缺省（客户端算出来是空），服务端会退回第一个
  const current = body?.current === undefined || body.current === null
    ? ''
    : (normalizeId(body.current) || '')

  const result = putBind(ctx.db, {
    qqHash,
    clientId: ctx.client.id,
    campIds: parsed.ids,
    currentCampId: current
  })

  invalidateReadCache(ctx, qqHash)
  writeAudit(ctx.db, { clientId: ctx.client.id, action: 'bind.put', qqHash, detail: `count=${result.count}` })
  sendJson(ctx.res, 200, {
    ok: true,
    count: result.count,
    current: result.current,
    // 必须回 putBind 内部实际用的那个时间戳。这里另取一次 Date.now() 会略大于
    // 落库的 last_seen_at，客户端拿它当 since 再来查就会被误判成「未变更」
    updatedAt: result.updatedAt
  })
}

/** DELETE /api/v1/bind —— 撤销共享。删该 QQ 下全部 client 的记录并留墓碑 */
async function handleDelete (ctx) {
  guardWrite(ctx)

  const body = await readJsonBody(ctx.req)
  const qqHash = readQQHash(ctx.config, body?.qq)

  const deleted = deleteBind(ctx.db, { qqHash })

  invalidateReadCache(ctx, qqHash)
  writeAudit(ctx.db, { clientId: ctx.client.id, action: 'bind.del', qqHash, detail: `deleted=${deleted}` })
  sendJson(ctx.res, 200, { ok: true, deleted })
}

/** POST /api/v1/bind/query —— 查询。命中墓碑或查无记录都回 404 */
async function handleQuery (ctx) {
  const body = await readJsonBody(ctx.req)
  const qqHash = readQQHash(ctx.config, body?.qq)

  const cooldownKey = `${ctx.client.id}:${qqHash}`
  const cached = ctx.limiters.readCooldown.get(cooldownKey)
  if (cached) {
    // 冷却期内连配额都不扣：这不是一次真正的查询
    sendJson(ctx.res, cached.status, cached.payload)
    return
  }

  guardRead(ctx)

  const since = Number(body?.since) || 0
  const result = queryBind(ctx.db, { qqHash, since })

  let status = 200
  let payload

  if (!result.found) {
    status = 404
    payload = { ok: false, error: 'not_found', message: '该 QQ 没有共享记录' }
  } else if (result.unchanged) {
    // 客户端缓存还有效。几十字节的响应，稳态下绝大部分查询都走这条
    payload = { ok: true, unchanged: true, updatedAt: result.updatedAt }
  } else {
    payload = {
      ok: true,
      unchanged: false,
      campIds: result.campIds,
      current: result.currentCampId,
      updatedAt: result.updatedAt
    }
  }

  ctx.limiters.readCooldown.set(cooldownKey, { status, payload }, ctx.config.readCooldownMs)
  writeAudit(ctx.db, { clientId: ctx.client.id, action: 'bind.get', qqHash, detail: `found=${result.found}` })
  sendJson(ctx.res, status, payload)
}

/**
 * @param {object} ctx
 * @returns {Promise<boolean>} 是否已处理该请求
 */
export async function bindRoutes (ctx) {
  const { method, pathname } = ctx

  if (pathname === '/api/v1/bind') {
    if (method === 'PUT') { await handlePut(ctx); return true }
    if (method === 'DELETE') { await handleDelete(ctx); return true }
    throw new HttpError(405, 'method_not_allowed', '该路径只支持 PUT 和 DELETE', { Allow: 'PUT, DELETE' })
  }

  if (pathname === '/api/v1/bind/query') {
    if (method !== 'POST') {
      throw new HttpError(405, 'method_not_allowed', '该路径只支持 POST', { Allow: 'POST' })
    }
    await handleQuery(ctx)
    return true
  }

  return false
}
