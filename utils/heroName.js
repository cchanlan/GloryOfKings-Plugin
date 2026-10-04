/**
 * 英雄名 → heroId 的模糊匹配。
 *
 * 官网 herolist.json 的 cname 里，元流之子带半角括号（`元流之子(射手)`），
 * 而营地的接口两边都有（`元流之子(射手)` / `元流之子（射手）`），所以匹配和展示都做了兼容。
 * `#查战绩` 与 `#英雄详情` 共用这一份，别再各写一套。
 */
import ApiService from './api.js'

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
  const heroList = await ApiService.getHeroList()
  if (!Array.isArray(heroList) || !heroList.length) {
    throw new Error('获取英雄列表失败，请稍后再试')
  }

  const name = String(heroName || '').trim()
  if (!name) throw new Error('请输入英雄名称')

  const abbr = name.match(/^元(.)/)
  if (abbr && YUAN_ABBR[abbr[1]]) {
    const hero = heroList.find(h => h.cname === `元流之子(${YUAN_ABBR[abbr[1]]})`)
    if (hero) return { heroId: String(hero.ename), matchedName: name }
  }

  const hero = heroList.find(h => h.cname === name) ||
    heroList.find(h => h.cname?.startsWith(name)) ||
    heroList.find(h => h.cname?.includes(name))

  if (!hero) throw new Error(`未找到英雄「${name}」，请检查名称`)

  return { heroId: String(hero.ename), matchedName: simplifyHeroName(hero.cname) }
}
