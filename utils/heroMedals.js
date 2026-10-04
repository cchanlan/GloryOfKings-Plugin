/**
 * 英雄荣耀称号（「台北第37孙权」这种）。
 *
 * 营地把称号放在**单英雄战绩详情**里（/gametoolbox/hero/record/pagedetails），
 * 英雄列表接口没有，所以只能一个英雄一次请求。插件的请求走全局串行队列（1.2 秒一次），
 * 扫 15 个英雄就要十几秒，因此：
 *  - 结果按「角色 + 英雄」缓存 30 分钟，#我的英雄 与 #称号墙 共用同一份，先查的那条帮后查的省请求；
 *  - 调用方自己控制扫多少个英雄，别把全部 40+ 个都扫（营地频控 -30107 就是这么撞上的）。
 *
 * medalList 实测是**两条**，同一个英雄一起给：
 *   TitleType 2 → 带地名的市级榜，「台北第37孙权」
 *   TitleType 1 → 不带地名的小范围榜，「第9孙权」（数字明显更小）
 * 战力不够上榜的英雄返回空数组（实测后羿 战力 2359 → []）。
 * 拿到的是**当前**排名；营地 App「历史赛季」页显示的是历史最高时的称号，两者可能差一档。
 */
import ApiService from './api.js'
import cache from './cache.js'

const CACHE_TTL = 1800
/** 串行间隔。真正的节流在 api 层的全局队列（1.2 秒），这里只是不主动扎堆 */
const GAP_MS = 250

/** 「台北第37孙权」→ { area: '台北', rank: 37, hero: '孙权' }；解析不出来就只留原文 */
export function parseMedal (text) {
  const raw = String(text || '').trim()
  const matched = raw.match(/^(.*?)第\s*(\d+)\s*(.+)$/)
  if (!matched) return { area: '', rank: 0, hero: '', text: raw }
  return { area: matched[1].trim(), rank: Number(matched[2]), hero: matched[3].trim(), text: raw }
}

/**
 * 逐英雄拉称号。
 * @param {string} roleId 角色ID（getProfile 的 targetRoleId）
 * @param {Array<{heroId: string|number, name?: string}>} heroes 要扫的英雄
 * @param {object} ctx {roleName, serverId, campId, botUserId}
 * @returns {Promise<Map<string, Array<object>>>} heroId → medalList 原始数组（空数组也会进 Map，代表「查过了，没上榜」）
 */
export async function fetchHeroMedals (roleId, heroes = [], ctx = {}) {
  const result = new Map()
  if (!roleId) return result

  const { roleName = '', serverId = '', campId = '', botUserId = '' } = ctx

  for (const hero of heroes) {
    const heroId = String(hero?.heroId ?? '')
    if (!heroId) continue

    const key = `gok:medals:${roleId}:${heroId}`
    const cached = cache.get(key)
    if (typeof cached !== 'undefined') {
      result.set(heroId, Array.isArray(cached) ? cached : [])
      continue
    }

    try {
      const res = await ApiService.getHeroRecordDetails(roleId, hero.heroId, { roleName, serverId }, campId, botUserId)
      const list = Array.isArray(res?.data?.medalList) ? res.data.medalList : []
      cache.set(key, list, CACHE_TTL)
      result.set(heroId, list)
    } catch (error) {
      // 单个英雄失败不缓存（下次还有机会），也不打断整轮
      logger?.debug?.(`[王者称号] ${hero?.name || heroId} 获取失败: ${error.message}`)
    }

    await new Promise(resolve => setTimeout(resolve, GAP_MS))
  }

  return result
}

/** 取展示用的那一条：营地按返回顺序展示，第一条（带地名的市级榜）就是它给的主称号 */
export function primaryMedal (list) {
  return String(list?.[0]?.UserMedalInfo || '')
}

/**
 * 这批英雄里有几个还得真发请求。调用方拿它决定要不要先回一句「请稍候」——
 * 缓存全命中时只要一两秒，回执反而变成多余的一条消息。
 */
export function pendingMedalCount (roleId, heroes = []) {
  if (!roleId) return heroes.length
  let pending = 0
  for (const hero of heroes) {
    const heroId = String(hero?.heroId ?? '')
    if (!heroId) continue
    if (typeof cache.get(`gok:medals:${roleId}:${heroId}`) === 'undefined') pending += 1
  }
  return pending
}
