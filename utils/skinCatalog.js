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
