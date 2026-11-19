import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'

const DAY = 24 * 60 * 60 * 1000
const roleIdOf = battle => String(battle?.battleDetailUrl || '').match(/[?&]toAppRoleId=(\d+)/)?.[1] || ''
const isMe = role => role?.basicInfo?.isMe === true || role?.basicInfo?.isMe === 1
const unavailable = () => ({ equipment: [], equipmentStatus: 'unavailable', skill: {}, heroName: '' })

/** Only the queried player's actual final equipment; never borrow another player's build. */
export function equipmentFromDetail (detail, battle = {}) {
  const roles = [...(detail?.redRoles || []), ...(detail?.blueRoles || [])]
  const headRole = String(detail?.head?.roleId || '')
  const targetRole = roleIdOf(battle)
  let mine = headRole ? roles.find(role => String(role?.basicInfo?.roleId || '') === headRole) : null
  if (!mine && targetRole) mine = roles.find(role => String(role?.basicInfo?.roleId || '') === targetRole)
  if (!mine) {
    const flagged = roles.filter(isMe)
    if (flagged.length === 1) mine = flagged[0]
  }
  if (!mine) return unavailable()
  const selectedRole = String(mine.basicInfo?.roleId || '')
  if (headRole && selectedRole && headRole !== selectedRole) return unavailable()
  if (targetRole && selectedRole && targetRole !== selectedRole) return unavailable()
  const usedHero = mine.battleRecords?.usedHero || {}
  for (const expected of [battle.heroId, detail?.head?.heroId]) {
    if (expected && usedHero.heroId && String(expected) !== String(usedHero.heroId)) return unavailable()
  }
  const finalEquips = mine.battleRecords?.finalEquips
  if (!Array.isArray(finalEquips)) return unavailable()
  const equipment = finalEquips.filter(e => e && e.equipIcon && String(e.equipId || '') !== '0').slice(0, 6)
    .map(e => ({ id: String(e.equipId || ''), name: String(e.equipName || ''), icon: String(e.equipIcon || '') }))
  const skill = mine.battleRecords?.skill || {}
  return {
    equipment,
    equipmentStatus: equipment.length ? 'ready' : 'empty',
    skill: { skillIcon: String(skill.skillIcon || ''), skillName: String(skill.skillName || '') },
    heroName: String(usedHero.heroName || detail?.head?.heroName || '')
  }
}

/** Persistent, scoped cache and bounded detail fetching for both list query paths. */
export function createBattleEquipmentService ({ fetchDetail, cachePath, concurrency = 2, now = Date.now,
  successTtl = 30 * DAY, failureTtl = 60 * 1000, maxEntries = 3000, logger = null } = {}) {
  if (typeof fetchDetail !== 'function') throw new TypeError('fetchDetail is required')
  const cache = new Map()
  const inflight = new Map()
  let loaded
  let active = 0
  const waiting = []
  let saving = Promise.resolve()
  const limit = Math.max(1, Math.min(3, Number(concurrency) || 2))
  const warn = message => logger?.warn?.(message)
  const load = () => loaded ||= (async () => {
    if (!cachePath) return
    try {
      const stored = JSON.parse(await fs.readFile(cachePath, 'utf8'))
      if (stored.version !== 1) return
      for (const [key, entry] of Object.entries(stored.entries || {})) {
        if (/^[a-f0-9]{64}$/.test(key) && entry?.expires > now() && Array.isArray(entry.value?.equipment)) cache.set(key, entry)
      }
    } catch (error) { if (error.code !== 'ENOENT') warn('[战绩出装] 缓存不可读，将按需重建') }
  })()
  const trim = () => {
    for (const [key, entry] of cache) if (entry.expires <= now()) cache.delete(key)
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value)
  }
  const flush = () => {
    if (!cachePath) return Promise.resolve()
    saving = saving.catch(() => {}).then(async () => {
      trim()
      const temp = `${cachePath}.${randomBytes(5).toString('hex')}.tmp`
      try {
        await fs.mkdir(path.dirname(cachePath), { recursive: true })
        await fs.writeFile(temp, JSON.stringify({ version: 1, entries: Object.fromEntries(cache) }), { mode: 0o600 })
        await fs.rename(temp, cachePath)
      } catch {
        await fs.unlink(temp).catch(() => {})
        warn('[战绩出装] 缓存写入失败，本次结果仍可正常显示')
      }
    })
    return saving
  }
  const withSlot = async work => {
    if (active >= limit) await new Promise(resolve => waiting.push(resolve))
    else active++
    try { return await work() } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
  const get = async (ID, battle, requester) => {
    if (!battle?.gameSeq || !battle.gameSvrId || !battle.relaySvrId) return unavailable()
    await load()
    const key = createHash('sha256').update(JSON.stringify([
      String(ID), String(requester || ''), String(battle.battleType || ''), String(battle.gameSvrId),
      String(battle.relaySvrId), String(battle.gameSeq), roleIdOf(battle)
    ])).digest('hex')
    const hit = cache.get(key)
    if (hit?.expires > now()) return structuredClone(hit.value)
    if (inflight.has(key)) return structuredClone(await inflight.get(key))
    const pending = withSlot(async () => {
      let value
      try { value = equipmentFromDetail(await fetchDetail(ID, battle, requester), battle) } catch { value = unavailable() }
      const ttl = value.equipmentStatus === 'ready' ? successTtl : value.equipmentStatus === 'empty' ? 30 * 60 * 1000 : failureTtl
      cache.set(key, { expires: now() + ttl, value })
      trim()
      return value
    })
    inflight.set(key, pending)
    try { return structuredClone(await pending) } finally { inflight.delete(key) }
  }
  return {
    async hydrate (ID, battles, requester, rows) {
      if (!Array.isArray(battles) || !battles.length) return rows || []
      if (!Array.isArray(rows) || rows.length !== battles.length) throw new TypeError('Battle and display row counts must match')
      const values = await Promise.all(battles.map(battle => get(ID, battle, requester)))
      await flush()
      return rows.map((row, i) => ({ ...row, ...values[i], matchKey: String(battles[i].gameSeq || '') }))
    },
    async remember (ID, battle, requester) { const value = await get(ID, battle, requester); await flush(); return value },
    flush
  }
}
