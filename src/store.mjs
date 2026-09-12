/**
 * 数据操作层。所有 SQL 集中在这里，路由层不直接碰 db。
 */
import { hashQQ } from './crypto.mjs'
import { MAX_CAMP_IDS } from './validate.mjs'

/** prepared statement 缓存。node:sqlite 每次 prepare 都要过一遍 SQL 解析，热点路径上没必要重复付 */
const statementCache = new WeakMap()

function stmt (db, sql) {
  let cache = statementCache.get(db)
  if (!cache) {
    cache = new Map()
    statementCache.set(db, cache)
  }

  let prepared = cache.get(sql)
  if (!prepared) {
    prepared = db.prepare(sql)
    cache.set(sql, prepared)
  }
  return prepared
}

/** 本地日期的 YYYY-MM-DD。用本地日期而不是 UTC，运营看配额时和挂钟对得上 */
function localDayKey (now = Date.now()) {
  const d = new Date(now)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ----------------------------------------------------------------- 审计 */

/**
 * @param {*} db
 * @param {{clientId?: number|null, action: string, qqHash?: string, ok?: boolean, detail?: string}} entry
 */
export function writeAudit (db, entry) {
  try {
    stmt(db, 'INSERT INTO audit (ts, client_id, action, qq_hash, ok, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        Date.now(),
        entry.clientId ?? null,
        String(entry.action || 'unknown'),
        String(entry.qqHash || ''),
        entry.ok === false ? 0 : 1,
        String(entry.detail || '')
      )
  } catch {
    // 审计写失败不能连累主流程
  }
}

/* ----------------------------------------------------------------- 客户端（token） */

export function createClient (db, { name, quotaPerDay = 2000, writePerHour = 60, note = '', tokenHash, tokenPrefix }) {
  const result = stmt(db,
    'INSERT INTO clients (name, token_hash, token_prefix, quota_per_day, write_per_hour, note, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(String(name), tokenHash, tokenPrefix, Number(quotaPerDay), Number(writePerHour), String(note), Date.now())

  return Number(result.lastInsertRowid)
}

export function getClientById (db, id) {
  return stmt(db, 'SELECT * FROM clients WHERE id = ?').get(Number(id)) || null
}

export function listClients (db) {
  return stmt(db,
    'SELECT id, name, token_prefix, quota_per_day, write_per_hour, enabled, note, created_at, last_seen_at ' +
    'FROM clients ORDER BY id ASC'
  ).all()
}

export function setClientEnabled (db, id, enabled) {
  const result = stmt(db, 'UPDATE clients SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, Number(id))
  return Number(result.changes) > 0
}

/**
 * 按 token 摘要取出 client 行。
 *
 * 拿摘要去查而不是遍历全表逐个恒时比对：摘要本身是 sha256 的输出，攻击者要命中
 * 也只能靠碰出同样的摘要，谈不上时序侧信道。恒时比较留着给 admin secret 用
 * （那个才是可以直接猜的明文）。
 *
 * @returns {{client: object, disabled: boolean}|null} 查无此 token 返回 null
 */
export function authenticate (db, tokenHash) {
  const row = stmt(db, 'SELECT * FROM clients WHERE token_hash = ?').get(String(tokenHash))
  if (!row) return null
  return { client: row, disabled: Number(row.enabled) !== 1 }
}

/** last_seen_at 节流：高频查询下不必每个请求都写一次库 */
export function touchClient (db, id, now = Date.now(), minGapMs = 60000) {
  try {
    stmt(db, 'UPDATE clients SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?')
      .run(now, Number(id), now - minGapMs)
  } catch {}
}

/* ----------------------------------------------------------------- 配额 */

/**
 * 检查并消耗一次读写配额。
 * @returns {{ok: true, used: number, limit: number}|{ok: false, used: number, limit: number}}
 */
export function consumeQuota (db, { clientId, limit, amount = 1, now = Date.now() }) {
  if (!limit || limit <= 0) return { ok: true, used: 0, limit: 0 }

  const day = localDayKey(now)
  stmt(db, 'INSERT INTO quota (client_id, day, used) VALUES (?, ?, 0) ON CONFLICT(client_id, day) DO NOTHING')
    .run(Number(clientId), day)

  const row = stmt(db, 'SELECT used FROM quota WHERE client_id = ? AND day = ?').get(Number(clientId), day)
  const used = Number(row?.used || 0)

  if (used + amount > limit) return { ok: false, used, limit }

  stmt(db, 'UPDATE quota SET used = used + ? WHERE client_id = ? AND day = ?')
    .run(Number(amount), Number(clientId), day)

  return { ok: true, used: used + amount, limit }
}

/** 小时窗口的写配额。用 quota 表存不下「小时」维度，直接数审计表更省事 */
export function countRecentWrites (db, clientId, windowMs = 3600000, now = Date.now()) {
  const row = stmt(db,
    "SELECT COUNT(*) AS n FROM audit WHERE client_id = ? AND ts > ? AND action IN ('bind.put', 'bind.del')"
  ).get(Number(clientId), now - windowMs)
  return Number(row?.n || 0)
}

/* ----------------------------------------------------------------- 绑定 */

/**
 * 上传某个 client 对某个 QQ 的全量绑定。
 *
 * 语义是「**本 client** 的这组记录长这样」——先删掉本 client 对该 QQ 的旧记录，
 * 再整组写进去。所以本实例上删掉一个号是能生效的，同时不会碰到别的实例写的记录。
 *
 * @returns {{count: number, current: string, updatedAt: number}}
 */
export function putBind (db, { qqHash, clientId, campIds, currentCampId, now = Date.now() }) {
  const ids = Array.isArray(campIds) ? campIds.slice(0, MAX_CAMP_IDS) : []
  const current = ids.includes(currentCampId) ? currentCampId : (ids[0] || '')

  db.exec('BEGIN IMMEDIATE')
  try {
    stmt(db, 'DELETE FROM bind_ids WHERE qq_hash = ? AND client_id = ?').run(qqHash, Number(clientId))

    const insert = stmt(db,
      'INSERT INTO bind_ids (qq_hash, client_id, camp_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
    )
    for (const campId of ids) insert.run(qqHash, Number(clientId), campId, now, now)

    stmt(db,
      'INSERT INTO bind_current (qq_hash, client_id, current_camp_id, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(qq_hash, client_id) DO UPDATE SET current_camp_id = excluded.current_camp_id, updated_at = excluded.updated_at'
    ).run(qqHash, Number(clientId), current, now)

    // 重新共享了，之前那条「此人已撤销」的墓碑必须撤掉，
    // 否则别的实例查到墓碑会一直当他不存在
    stmt(db, 'DELETE FROM revoke_log WHERE qq_hash = ?').run(qqHash)

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return { count: ids.length, current, updatedAt: now }
}

/**
 * 撤销：删掉该 QQ 下的**全部**记录（不管哪个 client 写的），并留下墓碑。
 *
 * 这是用户级意愿（「我不想被共享了」），不是「本实例删掉一个号」——
 * 后者走 putBind 上传剩余的那组。两件事必须分开。
 */
export function deleteBind (db, { qqHash, now = Date.now() }) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = stmt(db, 'DELETE FROM bind_ids WHERE qq_hash = ?').run(qqHash)
    stmt(db, 'DELETE FROM bind_current WHERE qq_hash = ?').run(qqHash)
    stmt(db, 'INSERT INTO revoke_log (qq_hash, revoked_at) VALUES (?, ?) ' +
      'ON CONFLICT(qq_hash) DO UPDATE SET revoked_at = excluded.revoked_at').run(qqHash, now)
    db.exec('COMMIT')
    return Number(result.changes)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * 查询。返回该 QQ 下所有 client 贡献的营地ID 并集。
 *
 * @returns {{found: false}
 *          |{found: true, unchanged: true, updatedAt: number}
 *          |{found: true, unchanged: false, campIds: string[], currentCampId: string, updatedAt: number}}
 */
export function queryBind (db, { qqHash, since = 0 }) {
  // 墓碑优先，且**不受 since 影响**：否则客户端拿着一个旧时间戳就能跳过撤销
  const revoked = stmt(db, 'SELECT revoked_at FROM revoke_log WHERE qq_hash = ?').get(qqHash)
  if (revoked) return { found: false }

  const rows = stmt(db,
    'SELECT camp_id, MAX(last_seen_at) AS seen FROM bind_ids WHERE qq_hash = ? GROUP BY camp_id ORDER BY camp_id ASC'
  ).all(qqHash)

  if (!rows.length) return { found: false }

  const updatedAt = rows.reduce((max, row) => Math.max(max, Number(row.seen) || 0), 0)

  if (since > 0 && updatedAt <= since) {
    return { found: true, unchanged: true, updatedAt }
  }

  const campIds = rows.map(row => String(row.camp_id))

  // 「当前号」取最后写入的那个 client 的。它可能在并集里不存在了（那个实例后来删了），
  // 那就退回第一个——客户端只需要一个能用的默认值
  const currentRow = stmt(db,
    'SELECT current_camp_id FROM bind_current WHERE qq_hash = ? ORDER BY updated_at DESC LIMIT 1'
  ).get(qqHash)
  const picked = String(currentRow?.current_camp_id || '')
  const currentCampId = campIds.includes(picked) ? picked : campIds[0]

  return { found: true, unchanged: false, campIds, currentCampId, updatedAt }
}

/* ----------------------------------------------------------------- 管理面统计与维护 */

export function stats (db) {
  const binds = stmt(db, 'SELECT COUNT(DISTINCT qq_hash) AS qqs, COUNT(*) AS rows FROM bind_ids').get()
  const week = stmt(db, 'SELECT COUNT(DISTINCT qq_hash) AS n FROM bind_ids WHERE first_seen_at > ?')
    .get(Date.now() - 7 * 86400000)
  const clients = stmt(db, 'SELECT COUNT(*) AS total, SUM(enabled) AS active FROM clients').get()

  return {
    totalQq: Number(binds?.qqs || 0),
    totalRows: Number(binds?.rows || 0),
    newQq7d: Number(week?.n || 0),
    clientsTotal: Number(clients?.total || 0),
    clientsActive: Number(clients?.active || 0)
  }
}

/** 每天跑一次的清理：过期绑定、过期墓碑、过期审计、过期配额 */
export function purge (db, { retentionDays = 180, auditDays = 30, now = Date.now() } = {}) {
  const bindCutoff = now - retentionDays * 86400000
  const auditCutoff = now - auditDays * 86400000

  const binds = stmt(db, 'DELETE FROM bind_ids WHERE last_seen_at < ?').run(bindCutoff)
  stmt(db, 'DELETE FROM bind_current WHERE qq_hash NOT IN (SELECT DISTINCT qq_hash FROM bind_ids)').run()
  stmt(db, 'DELETE FROM revoke_log WHERE revoked_at < ?').run(bindCutoff)
  const audits = stmt(db, 'DELETE FROM audit WHERE ts < ?').run(auditCutoff)
  stmt(db, 'DELETE FROM quota WHERE day < ?').run(localDayKey(auditCutoff))

  return { binds: Number(binds.changes), audits: Number(audits.changes) }
}

/** 管理员按明文 QQ 强制删除。被冒名的人申诉时用这个出口。 */
export function adminDeleteByQQ (db, salt, qq) {
  return deleteBind(db, { qqHash: hashQQ(salt, qq) })
}
