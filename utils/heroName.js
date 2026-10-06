/**
 * 英雄名 → heroId 的模糊匹配。
 *
 * 官网 herolist.json 的 cname 里，元流之子带半角括号（`元流之子(射手)`），
 * 而营地的接口两边都有（`元流之子(射手)` / `元流之子（射手）`），所以匹配和展示都做了兼容。
 * `#查战绩` 与 `#英雄详情` 共用这一份，别再各写一套。
 */
import ApiService from './api.js'
import cache from './cache.js'

// 官网总表一天也不会变，缓存 6 小时 —— 与 utils/pushStore.js 的 getHeroNameMap 同口径。
// ⚠️ resolveHero 在 #英雄详情 与 #查战绩 的必经路径上，裸拉意味着官网一抖动这两条指令就没回复。
const HERO_LIST_KEY = 'gok:heroList'
const HERO_LIST_TTL = 6 * 60 * 60

/** 把全角括号归一成半角：中文输入法下括号默认是全角，而官网 cname 用的是半角 */
const normBracket = text => String(text ?? '').replace(/（/g, '(').replace(/）/g, ')')

async function getCachedHeroList () {
  const hit = cache.get(HERO_LIST_KEY)
  if (Array.isArray(hit) && hit.length) return hit

  const list = await ApiService.getHeroList()
  if (Array.isArray(list) && list.length) cache.set(HERO_LIST_KEY, list, HERO_LIST_TTL)
  return list
}

// 元X 缩写展开：元射→元流之子(射手)、元法→元流之子(法师) 等
const YUAN_ABBR = { 射: '射手', 法: '法师', 坦: '坦克', 辅: '辅助', 刺: '刺客' }

/** 「元流之子(法师)」→「元法」。展示侧统一用缩写，名字太长会把卡片撑变形 */
export function simplifyHeroName (name) {
  return String(name ?? '').replace(/元流之子\s*[（(]\s*(.)[^）)]*[）)]/g, '元$1')
}

/**
 * 按英雄名找 heroId。优先精确、其次前缀、最后包含。
 * @param {string} heroName 用户输入（可带空格）
 * @returns {Promise<{heroId: string, matchedName: string}>}
 */
export async function resolveHero (heroName) {
  const heroList = await getCachedHeroList()
  if (!Array.isArray(heroList) || !heroList.length) {
    throw new Error('获取英雄列表失败，请稍后再试')
  }

  const name = String(heroName || '').trim()
  if (!name) throw new Error('请输入英雄名称')

  // ⚠️ 两边都归一化括号再比（2026-10-06 修）：文件头写着「匹配和展示都做了兼容」，
  //    但只有展示侧的 simplifyHeroName 收了 `[（(]`；匹配侧是半角硬编码，于是用户发
  //    `#英雄详情 元流之子（法师）`（全角括号）三条 find 全部落空，报「未找到英雄」——
  //    而名字本来就是对的，用户照提示核对也查不出问题。
  const abbr = name.match(/^元(.)/)
  if (abbr && YUAN_ABBR[abbr[1]]) {
    const want = `元流之子(${YUAN_ABBR[abbr[1]]})`
    const hero = heroList.find(h => normBracket(h.cname) === want)
    if (hero) return { heroId: String(hero.ename), matchedName: name }
  }

  const target = normBracket(name)
  const hero = heroList.find(h => normBracket(h.cname) === target) ||
    heroList.find(h => normBracket(h.cname).startsWith(target)) ||
    heroList.find(h => normBracket(h.cname).includes(target))

  if (!hero) throw new Error(`未找到英雄「${name}」，请检查名称`)

  return { heroId: String(hero.ename), matchedName: simplifyHeroName(hero.cname) }
}
