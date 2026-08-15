// 王者官网(pvp.qq.com)资料库皮肤立绘图源。
// 营地接口给的 szLargeIcon 对刚上线的新皮肤往往还是占位图、bigCover 只有 180x280，
// 官网这张表则是 816 条皮肤的封面图 100% 齐全，用来补营地取不到的图。
import ApiService from './api.js'
import cache from './cache.js'

const CACHE_KEY = 'pvp_skin_cover'
// 总表缓存 6 小时：新皮肤上线是天级频率，没必要频繁重拉 780KB
const CACHE_TTL = 6 * 3600

// 官网封面原图是 3750x2112 的横版立绘（约 850KB），直接塞竖卡要横向裁掉大半，
// 且体积换算成 base64 会把截图撑大。这里用腾讯云数据万象在 CDN 侧处理好再下载：
// 等比缩放到短边铺满(!720x1280r)后居中裁成 720x1280，恰好对齐营地 szLargeIcon 的规格，
// 出图约 150KB。皮肤立绘的人物基本居中，居中裁能稳定得到完整的人物胸像。
const MOGR = 'imageMogr2/thumbnail/!720x1280r/gravity/center/crop/720x1280/format/jpg/quality/85'

// 总表的字段名带随机后缀（pfidlb_3934 等），是官网自己生成的、可能随改版变化。
// 故只把它们当“优先猜测”，对不上时靠值的形态重新认字段（见 detectKeys）。
const GUESS_ID_KEY = 'pfidlb_3934'
const GUESS_COVER_KEY = 'fmlb_4536'
// 封面图 URL 里的固定路径标记，用来认出封面图字段（另有 E1 方形头像、B1 超宽图，都不合用）
const COVER_MARK = 'custom_wzry_A1'

/**
 * 认出“皮肤ID”和“封面图”两个字段名。
 * 封面图：值里带 custom_wzry_A1 路径标记，唯一。
 * 皮肤ID：纯数字且几乎不重复——表里另有纯数字的上线日期(8位)和皮肤标签(大量重复)，
 *         靠“取值几乎两两不同”把 ID 和它们区分开。
 */
function detectKeys (list) {
  const sample = list[0] || {}
  const keys = { id: '', cover: '' }

  if (typeof sample[GUESS_ID_KEY] === 'string' && typeof sample[GUESS_COVER_KEY] === 'string' &&
      String(sample[GUESS_COVER_KEY]).includes(COVER_MARK)) {
    return { id: GUESS_ID_KEY, cover: GUESS_COVER_KEY }
  }

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
    }
  }
  return keys
}

/**
 * 拉取并建立 皮肤ID -> 封面图地址 的索引。带内存缓存与并发去重，
 * 一次渲染里几十张皮肤同时问路也只会实拉一次总表。
 * @returns {Promise<Map<string, string>>} 拉取失败返回空 Map（调用方按“没有图”处理即可）
 */
let pending = null

async function loadCoverMap () {
  const cached = cache.get(CACHE_KEY)
  if (cached) return cached
  if (pending) return pending

  pending = (async () => {
    try {
      const raw = await ApiService.getPvpSkinList()
      // 顶层是个对象，皮肤总表和英雄总表各占一个键（键名同样带随机后缀），取最长的那个数组
      const list = Object.values(raw || {})
        .filter(Array.isArray)
        .sort((a, b) => b.length - a.length)[0] || []
      const keys = detectKeys(list)
      const map = new Map()
      if (keys.id && keys.cover) {
        for (const item of list) {
          const id = String(item[keys.id] || '')
          const url = String(item[keys.cover] || '')
          // 同一皮肤ID偶有重复条目（改过名的旧皮肤），保留先出现的那条
          if (id && url && !map.has(id)) map.set(id, url)
        }
      } else {
        logger?.warn?.('[GloryOfKings] 官网皮肤总表字段名无法识别，跳过官网图源')
      }
      cache.set(CACHE_KEY, map, CACHE_TTL)
      logger?.debug?.(`[GloryOfKings] 官网皮肤总表已缓存 ${map.size} 条`)
      return map
    } catch (err) {
      logger?.debug?.(`[GloryOfKings] 官网皮肤总表拉取失败: ${err.message}`)
      // 失败也短暂缓存空表，避免一次渲染里几十张皮肤逐个重试超时
      const empty = new Map()
      cache.set(CACHE_KEY, empty, 300)
      return empty
    } finally {
      pending = null
    }
  })()

  return pending
}

/**
 * 取某张皮肤在官网的立绘图地址（已带好裁成 720x1280 竖版的处理参数）。
 * @param {string|number} skinId 皮肤ID，与营地的 iSkinId 同一套编号
 * @returns {Promise<string>} 取不到返回空字符串
 */
export async function getPvpSkinCover (skinId) {
  if (!skinId) return ''
  const map = await loadCoverMap()
  const url = map.get(String(skinId))
  return url ? `${url}?${MOGR}` : ''
}
