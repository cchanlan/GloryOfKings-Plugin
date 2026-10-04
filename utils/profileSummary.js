/**
 * 营地主页（/game/koh/profile）的可比字段提取。
 *
 * 主页的数据全塞在 head.mods 数组里，每项靠 modId 区分，一次请求就能拿到段位、巅峰分、
 * 战斗力、场次、胜率、MVP、英雄数、皮肤数、最高战力英雄 —— 所以双人对比每人只要 1 次请求。
 * 实测的 modId 对应关系（测试号 1580886057）：
 *   708 10v10 定级（name=未定级/段位名，param1.rankingStar 星数）
 *   701 5v5 段位（name=荣耀王者，param1.rankingStar=68）
 *   702 巅峰赛（content=1878，就是巅峰分）
 *   304 战斗力（content=85056）
 *   401 总场次    408 MVP 次数    409 胜率（content='51.92%'）
 *   201 英雄 '89/131'    202 皮肤 '57/820'
 *   601 当前最高战力英雄（param1 里有 heroId/playNum/winRate/heroFightPower）
 * 每一项都可能缺（不同赛季/隐藏设置），所以全部走兜底，缺的项在对比时直接跳过。
 */

/** 段位强弱序，只用来跨段位比较；同段位再比星数（星数在段内才可比） */
const RANK_ORDER = ['倔强青铜', '秩序白银', '荣耀黄金', '尊贵铂金', '永恒钻石', '至尊星耀', '最强王者', '荣耀王者']

const num = value => {
  const n = Number(String(value ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

const parseJson = text => {
  if (!text || typeof text !== 'string') return {}
  try {
    return JSON.parse(text) || {}
  } catch {
    return {}
  }
}

/** 「荣耀王者」→ 7；名字带罗马数字（永恒钻石I）也能认，认不出返回 -1 */
export function rankOrder (name) {
  const text = String(name || '')
  for (let i = RANK_ORDER.length - 1; i >= 0; i--) {
    if (text.includes(RANK_ORDER[i])) return i
  }
  return -1
}

/**
 * 把主页响应整理成一份扁平摘要。
 * @param {object} data getProfile 返回的 data
 * @returns {object|null} 取不到角色时返回 null
 */
export function summarizeProfile (data) {
  const roleId = String(data?.targetRoleId || '')
  const role = (data?.roleList || []).find(item => String(item.roleId) === roleId) || (data?.roleList || [])[0]
  if (!role) return null

  const mods = Array.isArray(data?.head?.mods) ? data.head.mods : []
  const mod = id => mods.find(item => Number(item.modId) === id) || null

  const rank5v5 = mod(701)
  const rank10v10 = mod(708)
  const hero = mod(601)
  const heroParam = parseJson(hero?.param1)
  const [heroOwn, heroTotal] = String(mod(201)?.content || '').split('/')
  const [skinOwn, skinTotal] = String(mod(202)?.content || '').split('/')

  return {
    roleId,
    roleName: String(role.roleName || ''),
    roleIcon: String(role.roleIcon || ''),
    areaName: String(role.areaName || ''),
    gameLevel: num(role.gameLevel),
    online: Number(role.gameOnline) || 0,
    rank: rank5v5 ? { name: String(rank5v5.name || ''), star: num(parseJson(rank5v5.param1).rankingStar) } : null,
    rank10v10: rank10v10 ? { name: String(rank10v10.name || ''), star: num(parseJson(rank10v10.param1).rankingStar) } : null,
    // 巅峰分 0 表示这个赛季没打巅峰赛，对比时要当「无数据」而不是「0 分」
    peak: num(mod(702)?.content),
    power: num(mod(304)?.content),
    plays: num(mod(401)?.content),
    mvp: num(mod(408)?.content),
    winRate: num(mod(409)?.content),
    heroOwn: num(heroOwn),
    heroTotal: num(heroTotal),
    skinOwn: num(skinOwn),
    skinTotal: num(skinTotal),
    topHero: hero
      ? {
          heroId: String(heroParam.heroId || ''),
          power: num(heroParam.heroFightPower || hero.content),
          playNum: num(heroParam.playNum),
          winRate: num(heroParam.winRate)
        }
      : null
  }
}

/** 段位文本：「荣耀王者 68 星」 */
export function rankText (rank) {
  if (!rank?.name) return ''
  return rank.star ? `${rank.name} ${rank.star} 星` : rank.name
}

/**
 * 比两个段位谁高：先比段位序，同段位再比星数。
 * @returns {number} >0 左边高，<0 右边高，0 打平或无法比较
 */
export function compareRank (a, b) {
  const oa = rankOrder(a?.name)
  const ob = rankOrder(b?.name)
  if (oa !== ob) return oa - ob
  return num(a?.star) - num(b?.star)
}
