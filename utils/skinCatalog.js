// 营地「全量皮肤配置表」：查皮肤图鉴的皮肤清单主源。
// 营地 h5getheroskinlist 除了返回某账号拥有的皮肤(heroSkinList)，还会附带一张与账号无关的
// 全量皮肤配置表(heroSkinConfList，约 956 条，含 134 个英雄的原皮与刚上线的联动皮肤)。
// 官网 herolist.json 的 skin_name 更新滞后(海月漏了海之女神/真言先知)、官网皮肤总表不收原皮
// 也漏联动皮(墨子的迪迦奥特曼)，只有这张表是齐的，故拿它当图鉴清单，官网表退居兜底。
import path from 'path'
import ApiService from './api.js'
import cache from './cache.js'
import { readYamlFile } from './yamlUtils.js'
import { PluginData } from '#components'

const CACHE_KEY = 'camp_skin_conf'
// 配置表缓存 6 小时：新皮肤上线是天级频率，而这个接口响应有几百 KB，不宜每次查皮肤都拉
const CACHE_TTL = 6 * 3600
// 拉取失败也短暂缓存空表，避免登录态失效时每次查皮肤都白等一轮接口超时
const FAIL_TTL = 300

let pending = null

/**
 * 凑出可用来发起请求的「营地ID + 属主QQ」候选。配置表本身与查谁无关，接口只是必须带一个
 * friendUserId，故任意一个真实玩家的营地ID都行：优先调用方给的(通常是触发者自己绑的)，
 * 其次从已绑定用户里挑几个兜底。
 * 注意两点：
 *  1) 必须带属主QQ，鉴权候选是按它取的，缺了会直接判定“无可用登录态”；
 *  2) 不要拿全局账号自己的营地ID来查——那个账号常常没有王者角色，接口会回 -30087，
 *     而插件会把这种错误当登录态失效计数，白白把全局账号标记成不可用。
 */
function collectCandidates (preferCampId = '', preferBotUserId = '') {
  const list = []
  const push = (campId, botUserId) => {
    const id = String(campId || '').trim()
    const owner = String(botUserId || '').trim()
    if (!/^\d+$/.test(id) || !owner) return
    if (list.some(c => c.campId === id)) return
    list.push({ campId: id, botUserId: owner })
  }

  push(preferCampId, preferBotUserId)

  const users = readYamlFile(path.join(PluginData, 'UserData.yaml')) || {}
  for (const [botUserId, info] of Object.entries(users)) {
    if (!info?.ids?.length) continue
    push(info.ids[info.current || 0], botUserId)
    if (list.length >= 4) break
  }
  return list
}

/**
 * 取营地全量皮肤配置表。
 * @param {{campId?: string, botUserId?: string}} opts 优先用来发请求的营地ID及其属主QQ
 * @returns {Promise<Map<string, object>>} 皮肤ID -> 皮肤配置；取不到返回空 Map
 */
export async function getCampSkinConf ({ campId = '', botUserId = '' } = {}) {
  const cached = cache.get(CACHE_KEY)
  if (cached) return cached
  if (pending) return pending

  pending = (async () => {
    for (const candidate of collectCandidates(campId, botUserId)) {
      try {
        const res = await ApiService.getSkinList(candidate.campId, candidate.botUserId)
        const data = res && res.data ? res.data : res
        const conf = data?.heroSkinConfList
        if (!conf || typeof conf !== 'object') continue
        const map = new Map()
        for (const item of Object.values(conf)) {
          const skinId = String(item?.iSkinId || '')
          if (skinId) map.set(skinId, item)
        }
        if (!map.size) continue
        cache.set(CACHE_KEY, map, CACHE_TTL)
        logger?.debug?.(`[GloryOfKings] 营地皮肤配置表已缓存 ${map.size} 条`)
        return map
      } catch (err) {
        logger?.debug?.(`[GloryOfKings] 营地皮肤配置表拉取失败: ${err.message}`)
      }
    }
    const empty = new Map()
    cache.set(CACHE_KEY, empty, FAIL_TTL)
    return empty
  })()

  try {
    return await pending
  } finally {
    pending = null
  }
}

// 营地的 szHeroTitle 与官网 herolist 的 cname 偶有括号/空格差异（如元流之子的分身），
// 比对前统一去掉全半角括号与空白，避免因写法不同漏匹配。
function normalizeHeroName (name) {
  return String(name ?? '').replace(/[\s（）()]/g, '')
}

/**
 * 取某个英雄在营地配置表里的全部皮肤，按皮肤ID升序（末两位就是皮肤序号，0 是原皮）。
 * @param {string} heroName 英雄全名，如「墨子」「元流之子(法师)」
 * @param {{campId?: string, botUserId?: string}} opts
 * @returns {Promise<Array<object>>} 营地皮肤配置数组；取不到返回空数组
 */
export async function getCampHeroSkins (heroName, opts = {}) {
  if (!heroName) return []
  const conf = await getCampSkinConf(opts)
  if (!conf.size) return []
  const target = normalizeHeroName(heroName)
  return [...conf.values()]
    .filter(item => normalizeHeroName(item.szHeroTitle) === target)
    .sort((a, b) => Number(a.iSkinId) - Number(b.iSkinId))
}

/* -------------------------------------------------- 品质口径（皮肤墙与缺失反查共用） */

// 营地评级 szClass 的价值序（下标越小越高）。注意它和「品质名」是两套口径，
// 评级里 SR 会盖过 S++ 的荣耀典藏，所以排序主键得用下面的 tierRank，评级只当次级键。
export const SZ_ORDER = ['SR', 'S++', 'S+', 'S', 'A', 'B', 'C', 'D']

// 高价值品质优先级(下标越小价值越高)，对齐营地“皮肤价值”口径。
// 这些顶级品质(如荣耀典藏)的综合估值 skin_worth 常为 0，无法靠 worth 排序，故用显式优先级置顶。
// 依据接口返回的 conf.classTypeName(品质名数组)精确匹配。
export const TIER_PRIORITY = ['荣耀典藏', '珍品无双', '无双至尊', '珍品传说', '传说限定']

/** 取皮肤命中的最高价值品质档位下标；未命中返回末尾档，走评级/估值兜底 */
export function tierRank (classTypeName) {
  const names = Array.isArray(classTypeName) ? classTypeName : []
  let best = TIER_PRIORITY.length
  for (const name of names) {
    const idx = TIER_PRIORITY.indexOf(String(name))
    if (idx !== -1 && idx < best) best = idx
  }
  return best
}

// 品质名展示优先级：classTypeName 是数组，常混着主题名(如“墨染江湖”)与品质名(如“无双”)，
// 顺序不固定。按“价值品质”优先挑一个用于展示，列表外的名字作为最次兜底取数组首项。
const QUALITY_LABELS = [
  '荣耀典藏', '珍品无双', '无双至尊', '珍品传说', '传说限定',
  '无双', '珍品限定', '传说品质', '史诗品质', '勇者品质', '限定'
]

/** 挑一个用于展示的品质名 */
export function pickTierText (classTypeName) {
  const names = (Array.isArray(classTypeName) ? classTypeName : [])
    .map(n => String(n).trim())
    .filter(Boolean)
  if (!names.length) return ''
  for (const label of QUALITY_LABELS) {
    if (names.includes(label)) return label
  }
  return names[0]
}

// 品质计数格。统计的是品质名(classTypeName)而不是营地评级(szClass)——两者口径不同。
// aliases 收拢同一品质的不同写法：营地对“无双”系列的返回并不统一，只认单一名字会让计数偏低。
export const QUALITY_STATS = [
  { key: 'gloryNum', label: '荣耀典藏', aliases: ['荣耀典藏'] },
  { key: 'wushuangNum', label: '无双', aliases: ['珍品无双', '无双至尊', '无双'] },
  { key: 'legendNum', label: '传说', aliases: ['珍品传说', '传说限定', '传说品质'] }
]

/** 一张皮肤只计入最先命中的那一格，避免同时含“无双”和“传说”时被重复统计 */
export function countQuality (classTypeName, counters) {
  const names = (Array.isArray(classTypeName) ? classTypeName : []).map(n => String(n).trim())
  if (!names.length) return
  for (const stat of QUALITY_STATS) {
    if (stat.aliases.some(alias => names.includes(alias))) {
      counters[stat.key]++
      return
    }
  }
}

/**
 * 判断一条配置是不是「经典皮肤」（每个英雄的默认外观）。
 * 实测判据是 isHidden === 1：134 条全是原皮，而账号的已拥有列表 heroSkinList 从不返回它们，
 * 不排掉的话每个英雄都会凭空多出一条「缺失」。排掉后可见皮肤 822 条，
 * 与营地自己的 skinCountInfo.totalSkinNum(823) 基本吻合。
 */
export function isClassicSkin (conf) {
  return Number(conf?.isHidden) === 1
}
