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

/**
 * 段位强弱序，只用来跨段位比较；同段位再比星数（星数在段内才可比）。
 *
 * ⚠️⚠️ **王者档只写一个「王者」，不要按子段名细分**（2026-10-06 修）。
 *    原先这张表停在「荣耀王者」，S40 之后新增的**无双/绝世/非凡/至圣王者**
 *    全都 `includes` 不上任何一项 → `rankOrder` 返回 **-1** → 被判成**低于倔强青铜**。
 *    由于 `compareRank` 在 `oa !== ob` 时直接 `return oa - ob`，
 *    非王者那一方**一律获胜**，段位结论整个反过来。
 *
 *    实测（真实 `data/RankSnapshot.json` 24 个账号）：
 *      · 认不出的段位 **6 个**（至圣×2、非凡×2、绝世×1、无双×1）
 *      · 两两配对 522 对里**方向错 108 对（20.7%）**
 *      · 典型：`最强王者3星 vs 非凡王者12星` 判「左边赢」，实际右边高得多
 *
 *    为什么**不**去补四个子段名：子段名与星数的对应关系**跨赛季会变**，
 *    拿本插件自己的 1123 条真实王者战绩反推，区间是重叠的
 *    （最强王者 1~8 星、非凡王者 1~15 星 —— 同一个星数在两季叫不同称号）。
 *    按名字硬排会引入新的错判，所以这里只认到「王者」这一层，
 *    **王者段内部一律改比星数**（`utils/rankTrend.js` 的文件头已考证：
 *    王者段 stars 是累积值、不随小段重置，1~97 单调，段内可比）。
 *    两个王者号之间因此按星数分高下，这正是官方口径。
 */
const RANK_ORDER = ['倔强青铜', '秩序白银', '荣耀黄金', '尊贵铂金', '永恒钻石', '至尊星耀', '王者']

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

/**
 * 「荣耀王者」→ 6；名字带罗马数字（永恒钻石I）也能认，认不出返回 -1。
 *
 * ⚠️ 匹配顺序：**从高到低**遍历，且「王者」那一项只认「王者」二字，
 *    这样最强/无双/绝世/非凡/至圣/荣耀/传奇王者会一起落到王者档。
 *    「荣耀黄金」与「荣耀王者」都含「荣耀」，靠「王者」二字区分，不受影响。
 */
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
    // ⚠️ 这里**故意不加** `hasPlays`（2026-10-06 复核后撤回一条「疑似 bug」）。
    //    曾以为「401 缺失 → plays=0 → kingCompare 的 `has` 为假 → 总场次这行静默消失」。
    //    去翻模板发现是**有告知**的：KingCompare.html:135 出「N 项缺数据跳过」角标、
    //    :186-187 再列明细「缺数据没参与比分的项：总场次」。
    //    也就是说用户看得见这项没比，这是设计好的行为，不是 bug。
    //    真去改成「显示 —」反而要动出图，得先过目，本轮不做。
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
 *
 * ⚠️ 任一方认不出（`rankOrder` 返回 -1）时返回 **0（不比）**，而不是拿 -1 去减。
 *    原先 `oa !== ob` 就直接 `return oa - ob`，于是「认不出的段位」等于「比青铜还低」，
 *    对面无条件获胜 —— 这正是王者子段那个 bug 的放大器（2026-10-06 修）。
 *    现在改成认不出就弃权：`kingCompare` 见 `diff === 0` 既不加分也不扣分，
 *    宁可这行不比，也不给出**反向**的结论。
 *
 * @returns {number} >0 左边高，<0 右边高，0 打平或无法比较
 */
export function compareRank (a, b) {
  const oa = rankOrder(a?.name)
  const ob = rankOrder(b?.name)
  // 认不出就弃权：绝不能让它冒充「最低段位」去输给任何对手
  if (oa < 0 || ob < 0) return 0
  if (oa !== ob) return oa - ob
  return num(a?.star) - num(b?.star)
}
