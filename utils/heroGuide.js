/**
 * 英雄攻略（出装 / 英雄关系 / 技能）—— 数据来自**王者荣耀官网英雄资料页**，不碰营地接口。
 *
 * 为什么用官网而不是营地：营地的英雄详情在 App 原生页里，H5 那套接口要 MSDK 签名过不去
 * （见记忆 gok-team-analyze-msdk-blocked）；官网资料页是公开静态页，出装、英雄关系、
 * 技能描述一次全给，还带官方 Tips 文案。
 *
 * 三个必须知道的坑（都在 ApiService.getHeroDetailPage 的注释里也写了）：
 *   1. 页面路径是**英雄拼音**（`herodetail/luyana.shtml`），拿英雄ID拼是 404
 *   2. 页面编码 **GB18030**
 *   3. 装备只给 ID，名字要另拉 item.json（那个文件是 UTF-8）
 *
 * 官网这些数据版本级更新，变化极慢，所以整份解析结果按英雄缓存 6 小时。
 */
import { ApiService, cache } from '#utils'

/** 英雄表 / 装备表 / 单英雄攻略的内存缓存时长（秒） */
const CATALOG_TTL = 6 * 3600
const GUIDE_TTL = 6 * 3600

/** heroskinlist.json 的字段名是混淆的，集中在这里对照，别散落到各处 */
const F = {
  heroList: 'yxlb20_2489',
  skinList: 'pflb20_3469',
  heroId: 'yxid_a7',
  heroName: 'yxmclb_9965',
  heroPinyin: 'yxpymc_4614',
  heroRole: 'fllb_2105',
  heroRole2: 'fzy_8576',
  heroAvatar: 'yxtxlb_8443',
  heroCover: 'fmb1lb_5300',
  heroOnline: 'sxsjlb_1516',
  heroIntro: 'yjhjsl_5003',
  skinId: 'pfidlb_3934',
  skinName: 'pfmclb_7523',
  skinHero: 'yxmclb_9965',
  skinQuality: 'pfpzlb_3289',
  skinOnline: 'sxsjlb_1516',
  skinIntro: 'yjhjsl_5003',
  skinGet: 'hqfs_8609',
  skinCover: 'fmlb_4536',
  skinGift: 'pfgift_4455'
}

export { F as PVP_FIELDS }

/**
 * 官网英雄表：一份 132 条的英雄清单，按英雄名和拼音双向索引。
 * 顺带给出 ename -> 英雄名 的表，英雄关系那块只给 ename，要靠它翻名字。
 * @returns {Promise<{list: object[], byName: Map, byEname: Map}>}
 */
export async function getHeroCatalog () {
  const hit = cache.get('gok:pvpHeroCatalog')
  if (hit) return hit

  const raw = await ApiService.getPvpSkinList()
  const list = (raw?.[F.heroList] || []).map(h => ({
    ename: String(h[F.heroId] || ''),
    name: String(h[F.heroName] || ''),
    pinyin: String(h[F.heroPinyin] || ''),
    role: String(h[F.heroRole] || ''),
    role2: String(h[F.heroRole2] || ''),
    avatar: String(h[F.heroAvatar] || ''),
    cover: String(h[F.heroCover] || ''),
    online: String(h[F.heroOnline] || ''),
    intro: String(h[F.heroIntro] || '')
  })).filter(h => h.name && h.pinyin)

  const byName = new Map()
  const byEname = new Map()
  for (const hero of list) {
    byName.set(hero.name, hero)
    byEname.set(hero.ename, hero)
  }

  const result = { list, byName, byEname }
  cache.set('gok:pvpHeroCatalog', result, CATALOG_TTL)
  return result
}

/** 装备 ID -> {name, icon}。官网装备图规律：itemimg/<id>.jpg */
export async function getItemMap () {
  const hit = cache.get('gok:pvpItemMap')
  if (hit) return hit

  const list = await ApiService.getPvpItemList()
  const map = new Map()
  for (const item of list || []) {
    const id = String(item?.item_id || '')
    if (!id) continue
    map.set(id, {
      id,
      name: String(item.item_name || ''),
      price: Number(item.total_price) || 0,
      icon: itemIcon(id)
    })
  }

  cache.set('gok:pvpItemMap', map, CATALOG_TTL)
  return map
}

export const itemIcon = id => `https://game.gtimg.cn/images/yxzj/img201606/itemimg/${id}.jpg`
export const skillIcon = (ename, index) => `https://game.gtimg.cn/images/yxzj/img201606/heroimg/${ename}/${ename}${index}.png`

/** 去标签 + 收空白。官网的说明里混着 <p> 和 &nbsp; */
const clean = html => String(html || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim()

/** 补全官网的协议相对地址（//game.gtimg.cn/... ） */
const absUrl = url => {
  const text = String(url || '').trim()
  if (!text) return ''
  return text.startsWith('//') ? `https:${text}` : text
}

/**
 * 按名字找英雄，支持部分匹配（「守约」→「百里守约」）与拼音。
 * @returns {Promise<object|null>}
 */
export async function findHero (input) {
  const key = String(input || '').trim()
  if (!key) return null

  const { list, byName } = await getHeroCatalog()
  if (byName.has(key)) return byName.get(key)

  const lower = key.toLowerCase()
  return list.find(h => h.pinyin === lower) ||
    list.find(h => h.name.includes(key)) ||
    list.find(h => h.pinyin.includes(lower)) ||
    null
}

/**
 * 出装建议。页面上是两个 tab（推荐出装一 / 二），每套是
 * `<ul class="equip-list" data-item="1422|1136|...">` + 紧跟的 `<p class="equip-tips">Tips：…</p>`。
 *
 * **装备名不在 data-item 附近**：页面里那段带名字的 `<li>` 是注释掉的（官网自己也靠 JS 渲染），
 * 所以名字一律走 item.json 翻，翻不到就只显示图和 ID。
 */
function parseBuilds (html, itemMap) {
  const builds = []
  const re = /data-item="([^"]*)"[\s\S]*?class="equip-tips">([^<]*)</g
  let m
  while ((m = re.exec(html)) !== null) {
    const ids = m[1].split('|').map(s => s.trim()).filter(Boolean)
    if (!ids.length) continue
    builds.push({
      items: ids.map(id => ({
        id,
        name: itemMap.get(id)?.name || '',
        icon: itemMap.get(id)?.icon || itemIcon(id)
      })),
      tips: clean(m[2]).replace(/^Tips[:：]\s*/, '')
    })
  }
  return builds
}

/**
 * 英雄关系：最佳搭档 / 压制英雄 / 被压制英雄，三块结构一样。
 *
 * 切段方式是按 `hero-f1`（每块的小标题）split 而不是正则匹配整块 ——
 * 那些 div 是多层嵌套的，正则配对 `</div>` 会切错；split 之后每段里
 * 取**第一个** hero-list-desc 就一定是本段自己的。
 *
 * 每块里 `data-src="{ename}"` 是英雄ID列表，`hero-list-desc` 里的 `<p>` 按同一顺序
 * 给出「为什么」的官方说明（第 2 条起是 display:none，是 tab 切换用的，内容有效）。
 */
function parseRelations (html, byEname) {
  const groups = []
  for (const part of html.split('<div class="hero-f1 fl">').slice(1)) {
    const title = clean(part.match(/<\/i>\s*([^<]+?)\s*<\/div>/)?.[1] || '')
    if (!title) continue

    const enames = [...part.matchAll(/data-src="(\d+)"/g)].map(x => x[1])
    if (!enames.length) continue

    const descBlock = part.match(/class="hero-list-desc"[^>]*>([\s\S]*?)<\/div>/)?.[1] || ''
    const descs = [...descBlock.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(x => clean(x[1]))

    groups.push({
      title,
      heroes: enames.map((ename, i) => {
        const hero = byEname.get(ename)
        return {
          ename,
          name: hero?.name || ename,
          avatar: hero?.avatar || '',
          desc: descs[i] || ''
        }
      })
    })
  }
  return groups
}

/**
 * 技能。图标在 `skill-u1` 那个 ul 里按顺序排（末尾那个 no5 是空占位，src 是 `###`，要滤掉），
 * 文案在 `skill-show` 的每个 show-list 里：`<b>技能名</b><span>冷却值：…</span><span>消耗：…</span>`。
 *
 * 末尾那个占位 tab 在文案侧也有一个空的 show-list（技能名是空串、冷却/消耗都没值），
 * 不滤掉的话图上会多出一格空技能。
 */
function parseSkills (html) {
  const iconBlock = html.match(/<ul class="skill-u1">([\s\S]*?)<\/ul>/)?.[1] || ''
  const icons = [...iconBlock.matchAll(/<img\s+src="([^"]+)"/g)]
    .map(m => absUrl(m[1]))
    .filter(url => /\.(png|jpg)$/i.test(url))

  const skills = []
  const re = /<p class="skill-name"><b>([^<]*)<\/b>([\s\S]*?)<\/p>\s*<p class="skill-desc">([\s\S]*?)<\/p>/g
  let m
  while ((m = re.exec(html)) !== null) {
    const name = clean(m[1])
    const desc = clean(m[3])
    if (!name || !desc) continue
    const tags = [...m[2].matchAll(/<span>([^<]*)<\/span>/g)]
      .map(x => clean(x[1]))
      .filter(text => text && !/[:：]\s*$/.test(text))
    skills.push({ name, tags, desc, icon: icons[skills.length] || '' })
  }
  return skills
}

/** 铭文颜色 -> 图上的配色。营地给的是「绿色铭文」这种中文串 */
export const RUNE_COLOR = {
  红色铭文: '#ff5b7c',
  绿色铭文: '#7ee0a8',
  蓝色铭文: '#6f8ef5'
}

/** 0.5998 -> '60.0%'；拿不到就空串（别印 NaN%） */
const toPercent = value => {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? `${(num * 100).toFixed(1)}%` : ''
}

/**
 * 营地官方的**核心装备 + 铭文**（英雄详情页那两块）。
 *
 * 和官网资料库互补，所以是「增强」而不是替换：
 *   官网 → 两套成套出装 + 人写的 Tips 文案
 *   营地 → 3 件核心装备、3 套铭文，**每项都带真实胜率与出场率**
 *
 * **这两个接口要营地登录态**，所以整块是尽力而为：任何一步失败都返回 null，
 * 上层照旧只用官网数据出图 —— `#英雄攻略` 「没绑营地ID也能用」这个特性不能因为加了铭文就丢掉。
 *
 * @param {string|number} heroId 英雄 ename
 * @param {string} campId 营地ID（可空，空则由 authStore 挑全局/共享账号）
 * @param {string} qq 属主QQ，authStore 按它取鉴权候选，不能省（见记忆 gok-camp-api-owner-qq）
 * @returns {Promise<{coreEquips: object[], runeSets: object[]}|null>}
 */
export async function getCampBuild (heroId, campId = '', qq = '') {
  const key = `gok:campBuild:${heroId}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  let result = null
  try {
    const [equipRes, fringeRes] = await Promise.all([
      ApiService.getHeroBestEquip(heroId, campId, qq).catch(() => null),
      ApiService.getHeroFringeData(heroId, campId, qq).catch(() => null)
    ])

    const coreEquips = (equipRes?.data?.list || []).map(item => ({
      id: String(item.equipId || ''),
      name: String(item.szTitle || ''),
      icon: String(item.szIcon || ''),
      cate: String(item.szCate || ''),
      money: Number(item.szMoney) || 0,
      label: String(item.descLabel || ''),
      winRate: toPercent(item.winRate),
      showRate: toPercent(item.showRate)
    })).filter(item => item.name)

    // 这个接口顶层就是数据（没有 returnCode / data 包装），别按常规响应解
    const runeSets = (fringeRes?.RuneSetList || []).map(set => ({
      winRate: toPercent(set.winRate),
      showRate: toPercent(set.showRate),
      runes: (set.runeList || []).map(rune => ({
        id: String(rune.runeId || ''),
        // 「5级铭文:无双」→「无双」，等级单独拎出来，卡片上省地方
        name: String(rune.szTitle || '').replace(/^\d+级铭文[:：]\s*/, ''),
        level: Number(rune.iLevel) || 0,
        num: Number(rune.num) || 0,
        color: String(rune.szColor || ''),
        colorCode: RUNE_COLOR[String(rune.szColor || '')] || '#c8d0dd',
        attr: String(rune.szCommAttr || '').replace(/\|/g, ' · '),
        icon: String(rune.szIcon || '')
      })).filter(rune => rune.name)
    })).filter(set => set.runes.length)

    if (coreEquips.length || runeSets.length) {
      result = { coreEquips, runeSets }
    }
  } catch (error) {
    logger.debug(`[英雄攻略] 营地出装/铭文获取失败（不影响出图）: ${error.message}`)
  }

  // 失败也缓存（缓存 null 走短 TTL），避免没登录态时每次查都白打两次营地请求
  cache.set(key, result, result ? GUIDE_TTL : 300)
  return result
}

/**
 * 整合一个英雄的攻略数据。整份结果按英雄缓存 6 小时（官网是版本级更新，改得很慢）。
 * @param {string} input 英雄名 / 部分名 / 拼音
 * @returns {Promise<object|null>} 找不到英雄返回 null
 */
export async function getHeroGuide (input) {
  const hero = await findHero(input)
  if (!hero) return null

  const cacheKey = `gok:heroGuide:${hero.ename}`
  const hit = cache.get(cacheKey)
  if (hit) return hit

  const [html, itemMap, catalog] = await Promise.all([
    ApiService.getHeroDetailPage(hero.pinyin),
    getItemMap(),
    getHeroCatalog()
  ])

  const guide = {
    hero,
    builds: parseBuilds(html, itemMap),
    relations: parseRelations(html, catalog.byEname),
    skills: parseSkills(html)
  }

  cache.set(cacheKey, guide, GUIDE_TTL)
  return guide
}
