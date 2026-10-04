/**
 * 英雄详情（营地 `/gametoolbox/hero/record/pagedetails`）的数据整理。
 *
 * 这个接口是营地 App 英雄详情页的唯一数据源，一次请求就把整页数据全给了：
 * 生涯场次/胜率、近一个月荣誉、荣耀战力曲线、表现五维、最近对局、称号。
 * 放在 utils 里是为了能脱机测纯计算（不依赖 plugin 桩）。
 */
import { getLocalImage } from './fileUtils.js'
import { localImg, resolveEvaluate, buildKillTags } from './battleDetailImage.js'

/**
 * 表现五维。顺序跟着营地那页的雷达图：输出 → 生存 → KDA → 团战 → 发育。
 *
 * ⚠️ 字段名两套拼写：`avgPerformance` 里是 `hurhero`，`zjList` 每场里是 `hurthero`
 * （营地自己拼错的 `hurthero` 只出现在单场，别按同一个词去取）。
 */
const RADAR_DIMS = [
  ['hurhero', '输出'],
  ['survive', '生存'],
  ['kda', 'KDA'],
  ['battle', '团战'],
  ['grow', '发育']
]

/**
 * 雷达图满分。接口给的五维是 0~100 的整数（实测孙权 69/65/63/65/60、元流之子射手 66/66/65/62/54），
 * 按百分制画，不同英雄之间才可比。别拿 seasonPage 那套万分制的 RADAR_MAX=12000 来套。
 */
const RADAR_MAX = 100

/** 定位/分路的颜色，和营地那页一致 */
const TYPE_COLORS = {
  坦克: '#6ab0f5',
  战士: '#f0932b',
  刺客: '#c97bdb',
  法师: '#6ab0f5',
  射手: '#e0708a',
  辅助: '#57c98a'
}

/**
 * 战力曲线按天去重。
 * 接口给的是**每场对局一个点**（孙权那页 47 个点其实只有 20 天），
 * 直接画会出现大量同一天的重叠点，X 轴也排不开；同一天取最后一条 = 当天收盘战力。
 * @param {Array<{data: string, value: number}>} list
 */
export function foldPowerCurve (list = []) {
  const byDay = new Map()
  for (const item of list) {
    const day = String(item?.data || '').trim()
    if (!day) continue
    byDay.set(day, Number(item.value) || 0)
  }
  return [...byDay.entries()].map(([date, value]) => ({ date, value }))
}

/**
 * 单场战绩 → 模板要的结构。字段来源是 zjList，和 morebattlelist 同族但少了几个字段，
 * 别直接把 queryGameStats 那套 toListItem 搬过来。
 */
export function toRecentItem (item = {}) {
  const used = Number(item.usedtime) || 0
  return {
    gameType: item.mapName || '',
    gameTime: item.gametime || '',
    gameDuration: used ? `${Math.floor(used / 60)}分${used % 60}秒` : '',
    killCnt: Number(item.killcnt) || 0,
    deadCnt: Number(item.deadcnt) || 0,
    assistCnt: Number(item.assistcnt) || 0,
    gameResult: Number(item.gameresult) === 1 ? '胜利' : '失败',
    win: Number(item.gameresult) === 1,
    heroIcon: item.heroIcon || '',
    desc: item.matchDesc || '',
    // 这个接口的 mvpUrlV3/mvpUrlV2 实测是空串，MVP 只能靠 mvpcnt / losemvp 判
    mvp: Number(item.mvpcnt) ? { label: 'MVP', icon: localImg('mvp.png') }
      : Number(item.losemvp) ? { label: 'SVP', icon: localImg('svp.png') }
        : { label: '', icon: '' },
    // evaluateUrlV3 是 32 位哈希（本地有对应图标），V2/V1 兜底
    evaluate: resolveEvaluate([item.evaluateUrlV3, item.evaluateUrlV2, item.evaluateUrl]),
    killTags: buildKillTags(item),
    grade: item.grade || ''
  }
}

/**
 * 原始响应 → 模板数据。
 * @param {object} data `/gametoolbox/hero/record/pagedetails` 的 `data`
 * @param {object} [options]
 * @param {string} [options.fallbackName] 接口没给英雄名时用的名字（用户输入的那个）
 * @returns {object|null} 没玩过这个英雄时返回 null，调用方据此提示
 */
export async function buildHeroDetail (data, { fallbackName = '' } = {}) {
  const info = data?.heroInfo || {}
  const winNum = Number(info.winNum) || 0
  const failNum = Number(info.failNum) || 0
  const totalGames = winNum + failNum
  if (!totalGames) return null

  const portrait = await resolvePortrait(info)
  const curve = foldPowerCurve(data.powerData)
  const radar = RADAR_DIMS.map(([key, label]) => {
    const value = Number(data.avgPerformance?.[key]) || 0
    return { label, value, pct: Math.min(Math.max(value / RADAR_MAX, 0.02), 1) }
  })

  return {
    heroName: info.SzTitle || fallbackName,
    heroAlias: info.SzAlias || '',
    heroType: info.SzHeroType || '',
    heroTypeColor: TYPE_COLORS[info.SzHeroType] || '#f5d76e',
    branchRoad: info.SzBranchRoad || '',
    portrait,
    medals: (data.medalList || []).map(m => String(m?.UserMedalInfo || '')).filter(Boolean),
    skilledText: info.skilledTitle || '',
    totalGames,
    totalWins: winNum,
    // 营地那页保留两位小数，跟着它走，别自作主张四舍五入成「50.5%」
    winRate: ((winNum / totalGames) * 100).toFixed(2),
    honor: {
      best: Number(info.bestCount) || 0,
      gold: Number(info.goldCount) || 0,
      silver: Number(info.silverCount) || 0,
      mvp: Number(info.mvpCount) || 0,
      score: info.avgGrade || '—'
    },
    power: curve.length ? curve[curve.length - 1].value : 0,
    powerCurve: curve,
    radar,
    // art-template 的作用域里没有 JSON，两个图的数据只能先在 Node 侧序列化好再递进去
    powerCurveJson: JSON.stringify(curve),
    radarJson: JSON.stringify(radar),
    recent: (data.zjList || []).map(toRecentItem),
    hideMatch: Boolean(data.isHideMatchDetail || data.isHideMatch)
  }
}

/** 立绘。v2（newSzHeroPic）是营地新版大图，优先；取不到就退回 v1 */
async function resolvePortrait (info) {
  const candidates = [info.newSzHeroPic, info.SzHeroPic].filter(Boolean)
  for (const url of candidates) {
    // 立绘是竖图，转 base64 前先让 CDN 压到宽 640，不然一张图能有几 MB
    const thumb = /file\.myqcloud\.com/.test(url) && !/imageMogr2/.test(url)
      ? `${url}?imageMogr2/thumbnail/640x`
      : url
    const img = await getLocalImage(thumb)
    if (Buffer.isBuffer(img)) return `data:image/jpeg;base64,${img.toString('base64')}`
  }
  return ''
}
