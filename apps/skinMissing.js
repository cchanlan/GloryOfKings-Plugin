/**
 * #缺皮肤 —— 反查还差哪些皮肤。
 *
 * 一次 `getSkinList` 就同时拿到两边的数据，所以整条指令只花 1 次营地请求：
 *   heroSkinList      该账号「已拥有」的皮肤（口径见下）
 *   heroSkinConfList  与账号无关的全量皮肤配置表（约 956 条，唯一齐全的清单）
 * 差集就是缺失。故意不走 utils/skinCatalog.js 的 getCampSkinConf：那份缓存是给「查皮肤」
 * 这类不需要账号数据的场景用的，这里反正要拉自己的已拥有列表，同一响应里的配置表白送。
 *
 * 两个口径是实测出来的，照抄别处会算错：
 *  1) heroSkinList 里**并非全是已拥有**——测试号返回 150 条，其中只有 57 条真拥有，
 *     其余 92 条没有 iBuy 字段（营地拿它顺带下发新英雄/新皮肤的展示项）。
 *     判据 `'iBuy' in skin && szClass != null` 数出来正好等于 skinCountInfo.owned。
 *  2) 配置表里 isHidden === 1 的 134 条是**经典皮肤**（原皮），而已拥有列表从不返回它们，
 *     不排掉的话每个英雄都会凭空多出一条「缺失」。排掉后 822 条，
 *     与营地自己的 skinCountInfo.totalSkinNum(823) 只差 1。
 *
 * 输出是纯文字：缺失动辄七八百条，出图既慢又没人逐张看，文字给「概况 + 高价值 TOP + 逐英雄」
 * 三层最实用。品质口径（tierRank / pickTierText / QUALITY_STATS）与皮肤墙共用一份。
 */
import path from 'path'
import {
  ApiService, getCurrentId, readYamlFile, Button, shouldQuote,
  AT_HEAD, stripAtText, resolveTargetUserId, resolveMemberName,
  isClassicSkin, SZ_ORDER, tierRank, pickTierText, QUALITY_STATS
} from '#utils'
import { PluginData } from '#components'
import { loadPushList } from '../utils/pushStore.js'

/** 概况里「高价值缺失」列几条 */
const TOP_MISSING = 12
/** 概况里「缺得最多的英雄」列几个 */
const TOP_HERO = 6
/** 单个英雄的皮肤最多列几条，够覆盖目前皮肤最多的英雄（20 出头） */
const MAX_HERO_SKINS = 30

export class SkinMissing extends plugin {
  constructor () {
    super({
      name: '王者皮肤缺失',
      dsc: '反查还差哪些皮肤',
      event: 'message',
      // 和其它新指令一致：抢在 queryGameStats 的宽匹配之前
      priority: 0,
      rule: [
        { reg: `${AT_HEAD}#(缺皮肤|皮肤缺失|还差(什么|哪些)皮肤|缺哪些皮肤)\\s*(.*)$`, fnc: 'query' }
      ]
    })
  }

  async query (e) {
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint, shouldQuote())

    const input = stripAtText(e.msg)
      .replace(/^#(缺皮肤|皮肤缺失|还差(什么|哪些)皮肤|缺哪些皮肤)\s*/, '')
      .trim()
    const args = parseArgs(input)

    let campId = args.campId
    if (!campId && args.index) {
      const ids = (readYamlFile(path.join(PluginData, 'UserData.yaml')) || {})[userId]?.ids || []
      campId = ids[args.index - 1] || ''
      if (!campId) {
        return e.reply(`你没有第 ${args.index} 个绑定的营地ID，发送 #营地ID 看看列表`, shouldQuote())
      }
    }
    if (!campId) campId = getCurrentId(userId)

    if (!campId) {
      return e.reply(['你还没有绑定营地ID，先发送 #绑定营地 [营地ID]', Button.bind()], shouldQuote())
    }

    let data
    try {
      const res = await ApiService.getSkinList(String(campId), String(userId))
      data = res?.data || res
    } catch (error) {
      logger.error(`[王者缺皮肤] ${campId} 取皮肤列表失败: ${error.message}`)
      return e.reply(`查询失败：${error.message}`, shouldQuote())
    }

    const conf = Object.values(data?.heroSkinConfList || {}).filter(item => !isClassicSkin(item))
    if (!conf.length) {
      return e.reply('营地没返回皮肤配置表，稍后再试试', shouldQuote())
    }

    const owned = ownedSkinIds(data?.heroSkinList)
    const name = await displayName(e, userId)

    if (args.heroName) {
      const matched = matchHero(conf, args.heroName)
      if (!matched.list.length) {
        return e.reply([
          matched.candidates.length
            ? `没找到「${args.heroName}」，你是想查：${matched.candidates.join('、')}`
            : `没找到英雄「${args.heroName}」，英雄名要写全，比如 #缺皮肤 妲己`,
          Button.skinMissing('', campId)
        ], shouldQuote())
      }
      return e.reply([
        renderHero(matched.hero, matched.list, owned, name),
        Button.skinMissing(matched.hero, campId)
      ], shouldQuote())
    }

    return e.reply([
      renderOverview(conf, owned, data?.skinCountInfo, name, campId),
      Button.skinMissing('', campId)
    ], shouldQuote())
  }
}

/* ---------------------------------------------------------- 解析与口径 */

/** `#缺皮肤 妲己 1580886057` / `#缺皮肤2` 都能认：5 位以上数字是营地ID，4 位以内是绑定序号，其余当英雄名 */
function parseArgs (input = '') {
  const out = { campId: '', index: null, heroName: '' }
  const rest = []
  for (const tok of String(input).split(/[\s,，、]+/).filter(Boolean)) {
    if (/^\d+$/.test(tok)) {
      if (tok.length >= 5) { out.campId = tok; continue }
      if (out.index === null) { out.index = Number(tok); continue }
    }
    rest.push(tok)
  }
  out.heroName = rest.join('')
  return out
}

/**
 * 已拥有的皮肤ID集合。判据不是「出现在 heroSkinList 里」——那份列表混了展示项，
 * 见文件头注释第 1 条。
 */
function ownedSkinIds (heroSkinList) {
  const out = new Set()
  for (const skin of Array.isArray(heroSkinList) ? heroSkinList : []) {
    if ('iBuy' in skin && skin.szClass != null) out.add(String(skin.skinId))
  }
  return out
}

// 营地的 szHeroTitle 与用户手输的名字常差括号或空格（元流之子(法师)），比对前统一去掉
const norm = name => String(name ?? '').replace(/[\s（）()]/g, '')

// 元流之子的 5 个分身沿用 #查皮肤 的缩写：元法/元射/元辅/元坦/元刺
const YUAN_ABBR = { 法: '法师', 射: '射手', 辅: '辅助', 坦: '坦克', 刺: '刺客' }

/**
 * 从配置表里认英雄名。先精确匹配，不中再按包含关系给候选——
 * 直接在配置表里找而不去拉官网 herolist，是为了守住「整条指令只 1 次请求」。
 */
function matchHero (conf, input) {
  const abbr = String(input).match(/^元(.)$/)
  const want = norm(abbr && YUAN_ABBR[abbr[1]] ? `元流之子(${YUAN_ABBR[abbr[1]]})` : input)

  const exact = conf.filter(item => norm(item.szHeroTitle) === want)
  if (exact.length) {
    return { hero: exact[0].szHeroTitle, list: sortSkins(exact), candidates: [] }
  }

  const names = []
  for (const item of conf) {
    const title = String(item.szHeroTitle || '')
    if (title && norm(title).includes(want) && !names.includes(title)) names.push(title)
  }
  if (names.length === 1) {
    const list = conf.filter(item => item.szHeroTitle === names[0])
    return { hero: names[0], list: sortSkins(list), candidates: [] }
  }
  return { hero: '', list: [], candidates: names.slice(0, 8) }
}

/** 皮肤ID升序：末两位就是皮肤序号，按它排出来的顺序和游戏里一致 */
function sortSkins (list) {
  return [...list].sort((a, b) => Number(a.iSkinId) - Number(b.iSkinId))
}

/** 价值序：先按高价值品质档，再按营地评级，最后按标价 */
function valueRank (a, b) {
  const ta = tierRank(a.classTypeName)
  const tb = tierRank(b.classTypeName)
  if (ta !== tb) return ta - tb
  const sa = SZ_ORDER.includes(a.szClass) ? SZ_ORDER.indexOf(a.szClass) : SZ_ORDER.length
  const sb = SZ_ORDER.includes(b.szClass) ? SZ_ORDER.indexOf(b.szClass) : SZ_ORDER.length
  if (sa !== sb) return sa - sb
  return Number(b.iPrice || 0) - Number(a.iPrice || 0)
}

/** 展示名：推送轮询顺手缓存的营地昵称优先，其次群名片，都没有就用 QQ 号。都不额外发请求 */
async function displayName (e, userId) {
  const cached = String(loadPushList()[String(userId)]?.roleName || '').trim()
  if (cached) return cached
  try {
    return await resolveMemberName(e, userId) || String(userId)
  } catch {
    return String(userId)
  }
}

/* ---------------------------------------------------------- 文案 */

/** 一条皮肤的展示片段：`魅力维加斯[史诗品质] 888点券` */
function skinLine (conf) {
  const tier = pickTierText(conf.classTypeName)
  const price = Number(conf.iPrice || 0)
  return [
    String(conf.szTitle || `皮肤${conf.iSkinId}`),
    tier ? `[${tier}]` : '',
    // 限定皮肤大多不标价（iPrice 为 0），标价只在有值时给，别写成「0 点券」误导人
    price > 0 ? ` ${price}点券` : ''
  ].join('')
}

function renderHero (hero, list, owned, name) {
  const has = list.filter(item => owned.has(String(item.iSkinId)))
  const miss = list.filter(item => !owned.has(String(item.iSkinId)))

  const lines = [
    `🎨 ${name} 的「${hero}」皮肤`,
    `共 ${list.length} 款，已有 ${has.length}，还缺 ${miss.length}`,
    ''
  ]

  for (const item of list.slice(0, MAX_HERO_SKINS)) {
    lines.push(`${owned.has(String(item.iSkinId)) ? '✅' : '❌'} ${skinLine(item)}`)
  }
  if (list.length > MAX_HERO_SKINS) lines.push(`…… 还有 ${list.length - MAX_HERO_SKINS} 款`)

  lines.push('', '不含经典皮肤（原皮人人都有，列出来没意义）')
  return lines.join('\n')
}

function renderOverview (conf, owned, countInfo, name, campId) {
  const miss = conf.filter(item => !owned.has(String(item.iSkinId)))
  const total = conf.length
  const has = total - miss.length
  const pct = total ? ((has / total) * 100).toFixed(1) : '0.0'

  const lines = [
    `🎨 ${name} 的皮肤收集进度`,
    `已有 ${has} / ${total} 款（${pct}%），还缺 ${miss.length} 款`
  ]

  // 官方口径的两个数字：估值和绝版数，自己算不出来，直接引用
  const worth = Number(countInfo?.totalValue || 0)
  const notForSell = Number(countInfo?.notForSell || 0)
  if (worth > 0) lines.push(`已有皮肤估值 ${worth} 点券${notForSell > 0 ? `，其中绝版 ${notForSell} 款` : ''}`)

  // 品质分档：统计品质名而不是营地评级，两者口径不同（评级里 SR 会盖过荣耀典藏）
  lines.push('', '📦 按品质')
  for (const stat of QUALITY_STATS) {
    const hit = item => (Array.isArray(item.classTypeName) ? item.classTypeName : [])
      .some(n => stat.aliases.includes(String(n).trim()))
    const all = conf.filter(hit).length
    if (!all) continue
    const lack = miss.filter(hit).length
    lines.push(`· ${stat.label}：有 ${all - lack} / 缺 ${lack}`)
  }

  const top = [...miss].sort(valueRank).slice(0, TOP_MISSING)
  if (top.length) {
    lines.push('', `🔥 最值钱的缺失（前 ${top.length}）`)
    for (const item of top) lines.push(`· ${item.szHeroTitle} —— ${skinLine(item)}`)
  }

  const byHero = new Map()
  for (const item of miss) {
    const hero = String(item.szHeroTitle || '未知')
    byHero.set(hero, (byHero.get(hero) || 0) + 1)
  }
  const heroTop = [...byHero.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_HERO)
  if (heroTop.length) {
    lines.push('', '🕳️ 缺得最多的英雄')
    lines.push(heroTop.map(([hero, num]) => `${hero} ${num}`).join(' · '))
  }

  lines.push('', '发送 #缺皮肤 妲己 看单个英雄缺哪几款')
  lines.push('总数按营地全量配置表算，不含经典皮肤')
  return lines.join('\n')
}
