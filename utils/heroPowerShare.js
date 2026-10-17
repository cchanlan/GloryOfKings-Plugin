/**
 * 英雄战力的跨机器人上报与排名。
 *
 * 营地只给「各模式场次前 5」的英雄，做不了跨机器人的战力榜，所以：
 *   · 查 `#常用英雄` 时把展示的那几个英雄的战力**顺手传一份**到共享库
 *   · `#英雄名总排名` 从共享库按战力降序拉回来
 *
 * 三条硬约束（跟 shareStore 一致）：
 *   1. **绝不阻塞、绝不抛异常**：上报是 fire-and-forget，共享库挂了不能影响出图
 *   2. **本地优先**：没接入共享库时直接跳过，连请求都不发
 *   3. **限频**：同一用户同一英雄 1 小时内只传一次（共享库有小时写入速率）
 */
import fetch from 'node-fetch'
import { readShareConfig } from './shareStore.js'

const REPORT_TIMEOUT_MS = 8000
const READ_TIMEOUT_MS = 8000
/** 同一用户同一英雄的重复上报间隔。共享库默认 60 次/小时，查一次传一次会撞墙 */
const REPORT_TTL_MS = 60 * 60 * 1000

/** `qq:heroId` -> 上次上报时间戳 */
const reportedAt = new Map()

export function isHeroPowerReady () {
  const cfg = readShareConfig()
  return Boolean(cfg.enabled && cfg.apiUrl && cfg.token)
}

/**
 * 上报一批英雄战力。逐条 PUT，失败的跳过，整体永不抛。
 *
 * @param {string} qq 上报人的 QQ（服务端只存它的哈希）
 * @param {Array<{campId:string, heroId:number, heroName:string, power:number, nick?:string, area?:string, roleIcon?:string}>} items
 * @returns {Promise<{sent:number, skipped:number}>}
 */
export async function reportHeroPowers (qq, items) {
  const result = { sent: 0, skipped: 0 }
  const cfg = readShareConfig()
  if (!cfg.enabled || !cfg.apiUrl || !cfg.token || !qq) return result

  const now = Date.now()
  for (const item of items || []) {
    const heroId = Number(item?.heroId)
    if (!heroId) continue

    const key = `${qq}:${heroId}`
    if (now - (reportedAt.get(key) || 0) < REPORT_TTL_MS) {
      result.skipped += 1
      continue
    }

    try {
      const res = await fetch(`${cfg.apiUrl}/api/v1/hero/power`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          qq: String(qq),
          campId: String(item.campId || ''),
          heroId,
          heroName: String(item.heroName || ''),
          power: Number(item.power) || 0,
          nick: String(item.nick || ''),
          area: String(item.area || ''),
          roleIcon: String(item.roleIcon || '')
        }),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS)
      })
      if (res.ok) {
        reportedAt.set(key, now)
        result.sent += 1
      }
    } catch {
      // 共享库是别人的服务，挂了只能少传一次，不能影响查询
    }
  }
  return result
}

/**
 * 查某英雄的跨机器人战力排名。
 *
 * @param {string} heroName 英雄全名（元流之子要带分身，如「元流之子(射手)」）
 * @param {number} [limit=50]
 * @returns {Promise<{ok:boolean, message?:string, heroId?:number, total?:number, list?:Array}>}
 */
export async function queryHeroPowerRank (heroName, limit = 50) {
  const cfg = readShareConfig()
  if (!cfg.enabled || !cfg.apiUrl || !cfg.token) {
    return { ok: false, message: '这台机器人还没接入营地ID共享库' }
  }

  try {
    const res = await fetch(`${cfg.apiUrl}/api/v1/hero/power/rank`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ heroName, limit }),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS)
    })

    // 404 = 服务端还是旧版（没这个接口）。跟「连不上」分开说，免得主人去查网络
    if (res.status === 404) {
      return { ok: false, message: '共享库还没更新到支持英雄战力排名的版本' }
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: '共享库拒绝了这次请求，检查一下令牌' }
    }
    if (!res.ok) {
      return { ok: false, message: `共享库返回了 ${res.status}` }
    }

    const data = await res.json()
    return {
      ok: true,
      heroId: Number(data?.heroId) || 0,
      total: Number(data?.total) || 0,
      list: Array.isArray(data?.list) ? data.list : []
    }
  } catch {
    return { ok: false, message: '连不上共享库' }
  }
}
