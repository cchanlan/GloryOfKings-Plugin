// 王者官网(pvp.qq.com)资料库皮肤立绘图源。
// 营地接口给的 szLargeIcon 对刚上线的新皮肤往往还是占位图、bigCover 只有 180x280，
// 官网这张表则是 816 条皮肤的封面图 100% 齐全，用来补营地取不到的图。
import ApiService from './api.js'
import cache from './cache.js'

const CACHE_KEY = 'pvp_skin_index'
// 总表缓存 6 小时：新皮肤上线是天级频率，没必要频繁重拉 780KB
const CACHE_TTL = 6 * 3600

// 官网封面原图是 3750x2112 的横版立绘（约 850KB），直接用会把截图撑大，
// 故一律交给腾讯云数据万象在 CDN 侧处理好再下载，出图 150KB 上下：
// - portrait：等比缩放到短边铺满(!720x1280r)后居中裁成 720x1280，对齐营地 szLargeIcon 的规格，
//   皮肤立绘的人物基本居中，居中裁能稳定得到完整的人物胸像（皮肤墙的竖版卡片用）
// - landscape：只按宽缩放不裁，保留原始横版构图（皮肤图鉴的横版大图用）
const MOGR = {
  portrait: 'imageMogr2/thumbnail/!720x1280r/gravity/center/crop/720x1280/format/jpg/quality/85',
  landscape: 'imageMogr2/thumbnail/1400x/format/jpg/quality/85'
}

// 总表的字段名带随机后缀（pfidlb_3934 等），是官网自己生成的、可能随改版变化。
// 故只把它们当“优先猜测”，对不上时靠值的形态重新认字段（见 detectKeys）。
const GUESS_KEYS = {
  id: 'pfidlb_3934',
  cover: 'fmlb_4536',
  skinName: 'pfmclb_7523',
  heroName: 'yxmclb_9965'
}
// 封面图 URL 里的固定路径标记，用来认出封面图字段（另有 E1 方形头像、B1 超宽图，都不合用）
const COVER_MARK = 'custom_wzry_A1'

// 文本类字段（皮肤名/英雄名）的取值形态：非空、不是 URL、不是纯数字（表里另有日期与标签ID）
function isTextValue (v) {
  return Boolean(v) && !v.includes('/') && !/^\d+$/.test(v) && v.length <= 12
}

/**
 * 认出总表里的“皮肤ID/封面图/皮肤名/英雄名”四个字段名。
 * 封面图：值里带 custom_wzry_A1 路径标记，唯一。
 * 皮肤ID：纯数字且几乎不重复——表里另有纯数字的上线日期(8位)和皮肤标签(大量重复)，
 *         靠“取值几乎两两不同”把 ID 和它们区分开。
 * 皮肤名/英雄名：都是短中文文本，靠去重率区分——皮肤名近乎两两不同，
 *         英雄名只有一百多种（一个英雄多张皮肤），故去重率低得多。
 */
function detectKeys (list) {
  const sample = list[0] || {}
  const guessOk = typeof sample[GUESS_KEYS.id] === 'string' &&
    String(sample[GUESS_KEYS.cover] || '').includes(COVER_MARK) &&
    isTextValue(String(sample[GUESS_KEYS.skinName] || '')) &&
    isTextValue(String(sample[GUESS_KEYS.heroName] || ''))
  if (guessOk) return { ...GUESS_KEYS }

  const keys = { id: '', cover: '', skinName: '', heroName: '' }
  const textCandidates = []

  for (const key of Object.keys(sample)) {
    const values = list.map(item => item[key]).filter(v => v !== '' && v != null).map(String)
    if (!values.length) continue
    if (!keys.cover && values[0].includes(COVER_MARK)) {
      keys.cover = key
      continue
    }
    // ID 候选：全为纯数字、非日期、去重后仍占九成以上
    if (!keys.id && values.length === list.length && values.every(v => /^\d{1,7}$/.test(v)) &&
        new Set(values).size > values.length * 0.9) {
      keys.id = key
      continue
    }
    // 文本候选：几乎每条都有值且形态像短中文名，记下去重率待比对
    if (values.length >= list.length * 0.95 && values.every(isTextValue)) {
      textCandidates.push({ key, ratio: new Set(values).size / values.length })
    }
  }

  textCandidates.sort((a, b) => b.ratio - a.ratio)
  if (textCandidates[0] && textCandidates[0].ratio > 0.7) keys.skinName = textCandidates[0].key
  const heroCandidate = textCandidates.find(c => c.ratio < 0.5)
  if (heroCandidate) keys.heroName = heroCandidate.key
  return keys
}

/**
 * 拉取总表并建立索引：皮肤ID -> 封面图，英雄名 -> 该英雄的皮肤列表。
 * 带内存缓存与并发去重，一次渲染里几十张皮肤同时问路也只会实拉一次总表。
 * @returns {Promise<{coverById: Map<string,string>, byHero: Map<string,Array>}>} 拉取失败返回空索引
 */
let pending = null

async function loadSkinIndex () {
  const cached = cache.get(CACHE_KEY)
  if (cached) return cached
  if (pending) return pending

  pending = (async () => {
    const empty = { coverById: new Map(), byHero: new Map() }
    try {
      const raw = await ApiService.getPvpSkinList()
      // 顶层是个对象，皮肤总表和英雄总表各占一个键（键名同样带随机后缀），取最长的那个数组
      const list = Object.values(raw || {})
        .filter(Array.isArray)
        .sort((a, b) => b.length - a.length)[0] || []
      const keys = detectKeys(list)
      const index = { coverById: new Map(), byHero: new Map() }
      if (keys.id && keys.cover) {
        for (const item of list) {
          const id = String(item[keys.id] || '')
          const url = String(item[keys.cover] || '')
          // 同一皮肤ID偶有重复条目（改过名的旧皮肤），保留先出现的那条
          if (id && url && !index.coverById.has(id)) index.coverById.set(id, url)

          const heroName = keys.heroName ? String(item[keys.heroName] || '') : ''
          if (!heroName || !id) continue
          const skins = index.byHero.get(heroName) || []
          if (skins.some(s => s.skinId === id)) continue
          skins.push({ skinId: id, name: keys.skinName ? String(item[keys.skinName] || '') : '', cover: url })
          index.byHero.set(heroName, skins)
        }
        // 官网总表是按上线时间倒序的，按皮肤ID升序排回“图鉴顺序”（ID 末两位就是皮肤序号）
        for (const skins of index.byHero.values()) {
          skins.sort((a, b) => Number(a.skinId) - Number(b.skinId))
        }
      } else {
        logger?.warn?.('[GloryOfKings] 官网皮肤总表字段名无法识别，跳过官网图源')
      }
      cache.set(CACHE_KEY, index, CACHE_TTL)
      logger?.debug?.(`[GloryOfKings] 官网皮肤总表已缓存 ${index.coverById.size} 条 / ${index.byHero.size} 个英雄`)
      return index
    } catch (err) {
      logger?.debug?.(`[GloryOfKings] 官网皮肤总表拉取失败: ${err.message}`)
      // 失败也短暂缓存空表，避免一次渲染里几十张皮肤逐个重试超时
      cache.set(CACHE_KEY, empty, 300)
      return empty
    } finally {
      pending = null
    }
  })()

  return pending
}

/**
 * 取某张皮肤在官网的立绘图地址（已带好 CDN 侧的裁切/压缩参数）。
 * @param {string|number} skinId 皮肤ID，与营地的 iSkinId 同一套编号
 * @param {'portrait'|'landscape'} mode 竖版卡片(默认) 或 横版大图
 * @returns {Promise<string>} 取不到返回空字符串
 */
export async function getPvpSkinCover (skinId, mode = 'portrait') {
  if (!skinId) return ''
  const { coverById } = await loadSkinIndex()
  const url = coverById.get(String(skinId))
  return url ? `${url}?${MOGR[mode] || MOGR.portrait}` : ''
}

/**
 * 取某个英雄在官网总表里的皮肤清单（按皮肤ID升序，不含原皮——总表只收录售卖皮肤）。
 * 用于营地皮肤配置表取不到时的清单兜底。
 * @param {string} heroName 英雄全名，如「墨子」
 * @returns {Promise<Array<{skinId: string, name: string, cover: string}>>}
 */
export async function getPvpHeroSkins (heroName) {
  if (!heroName) return []
  const { byHero } = await loadSkinIndex()
  return byHero.get(String(heroName)) || []
}

