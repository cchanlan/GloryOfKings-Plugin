/**
 * 巅峰分趋势的数据整理（纯计算，不发任何请求）。
 *
 * 数据源是本地归档库 utils/battleArchive.js（推送轮询顺手落的库，保留 35 天），
 * 所以这条趋势**通常零营地请求**；库里凑不够点时才由调用方去补拉战绩。
 *
 * 两条实测口径，写死在这里别再猜：
 * 1. **只能取 mapName 含「巅峰」的场次**。排位局同样带 old/newMasterMatchScore 字段，
 *    但两者恒等（排位不影响巅峰分），混进来就是一串水平线，把真实涨跌压成噪声。
 *    实测账号 1580886057：48 场里 33 场巅峰、15 场「排位赛 双排」。
 * 2. **覆盖天数由轮询运行时长决定，不是 35 天**。库最多留 35 天，但只有轮询跑过的那段
 *    才有记录，实测三个账号分别只覆盖 3.8 / 6.2 / 19.4 天 —— 所以图上要如实标出
 *    「实际覆盖 X 天」，不能按用户要的天数写。
 */

/** 默认看多少天 */
export const TREND_DEFAULT_DAYS = 14
/**
 * 想凑够多少场巅峰局。
 *
 * 天数只是首选窗口：巅峰赛在归档里只占一部分（实测 48 场里 33 场巅峰、另一个号一场都没有），
 * 窗口内不足这个数就放宽到全库最近这么多场（见 pickPeakWindow），
 * 调用方也据此决定要不要现拉几页补上。
 */
export const TREND_TARGET_POINTS = 10
/** 少于这么多场就没什么趋势可看 */
export const TREND_MIN_POINTS = 4
/** 折线最多画多少个点：再多点会挤成一团，超了按等距抽稀（首尾必留） */
const MAX_POINTS = 60

const toInt = value => {
  const num = Number(value)
  return Number.isFinite(num) ? Math.trunc(num) : 0
}

/** 是不是巅峰赛的场次。营地的 mapName 实测是「巅峰赛」，留个 includes 兜住可能的后缀 */
export function isPeakBattle (item) {
  return String(item?.mapName || '').includes('巅峰')
}

/**
 * 从归档里挑出区间内可用的巅峰局。
 * @param {Array<object>} battles loadArchive 的返回（倒序）
 * @param {number} fromSec 区间起点（秒）
 * @returns {Array<object>} 正序（旧 → 新），已去掉没有巅峰分的场次
 */
export function pickPeakBattles (battles = [], fromSec = 0) {
  const from = toInt(fromSec)
  return (Array.isArray(battles) ? battles : [])
    .filter(item => isPeakBattle(item) && toInt(item?.dtEventTime) >= from && toInt(item?.newMasterMatchScore) > 0)
    .slice()
    .sort((a, b) => toInt(a.dtEventTime) - toInt(b.dtEventTime))
}

/**
 * 取「要画的那一窗巅峰局」：先按天数窗口取，窗口内不足 target 场就放宽成全库最近 target 场。
 *
 * 为什么要放宽：巅峰赛不是每天都打，按 14 天取常常只有三五场，涨跌看不出形状。
 * 用户要的是「最近这些巅峰赛打成什么样」，窗口是手段不是目的；
 * 放宽了就在图上如实标出来（图头本来就有「实际覆盖 X 天」）。
 *
 * @returns {{list: Array<object>, relaxed: boolean}} relaxed=true 表示突破了天数窗口
 */
export function pickPeakWindow (battles = [], fromSec = 0, target = TREND_TARGET_POINTS) {
  const inRange = pickPeakBattles(battles, fromSec)
  if (inRange.length >= target) return { list: inRange, relaxed: false }

  const all = pickPeakBattles(battles, 0)
  if (all.length <= inRange.length) return { list: inRange, relaxed: false }
  return { list: all.slice(-target), relaxed: true }
}

/** 等距抽稀，首尾必留 */
function thin (list, max = MAX_POINTS) {
  if (list.length <= max) return list
  const step = (list.length - 1) / (max - 1)
  const out = []
  for (let i = 0; i < max; i++) out.push(list[Math.round(i * step)])
  return out
}

const dayKey = sec => {
  const d = new Date(sec * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const mdText = sec => {
  const d = new Date(sec * 1000)
  return `${d.getMonth() + 1}-${d.getDate()}`
}

const hmText = sec => {
  const d = new Date(sec * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const signed = n => (n > 0 ? `+${n}` : String(n))

/**
 * 最长连胜 / 连败。逃跑（gameresult 既不是 1 也不是 2）算断。
 * @returns {{win: number, lose: number}}
 */
function streaks (list) {
  let win = 0
  let lose = 0
  let curWin = 0
  let curLose = 0
  for (const item of list) {
    const r = toInt(item.gameresult)
    curWin = r === 1 ? curWin + 1 : 0
    curLose = r === 2 ? curLose + 1 : 0
    if (curWin > win) win = curWin
    if (curLose > lose) lose = curLose
  }
  return { win, lose }
}

/**
 * 把巅峰局序列整理成模板数据。
 * @param {Array<object>} picked pickPeakBattles 的返回（正序）
 * @param {object} [ctx]
 * @param {object} [ctx.heroMap] heroId → 英雄名（归档里只有 heroId）
 * @param {Function} [ctx.iconOf] heroId → 头像 URL。由调用方注入，这个模块不碰网络/图源，
 *   免得为了一条 URL 把 reportStore → pushStore → api 整条链拖进来（脱机测时要打一堆桩）
 * @param {number} [ctx.days] 用户要看的天数，只用于文案
 * @param {boolean} [ctx.relaxed] 是否突破了天数窗口（pickPeakWindow 的返回），只用于文案
 * @param {number} [ctx.recent] 「最近战况」列几场
 * @returns {object|null} 少于 2 场时返回 null（一个点画不出趋势）
 */
export function buildTrendView (picked = [], { heroMap = {}, iconOf = () => '', days = TREND_DEFAULT_DAYS, relaxed = false, recent = 8 } = {}) {
  if (picked.length < 2) return null

  const scores = picked.map(item => toInt(item.newMasterMatchScore))
  const first = picked[0]
  const last = picked[picked.length - 1]
  // 起点用最早一场的「打之前」分数：这样涨跌把第一场本身也算进去
  const startScore = toInt(first.oldMasterMatchScore) || scores[0]
  const current = scores[scores.length - 1]
  const peak = Math.max(...scores)
  const low = Math.min(...scores)
  const delta = current - startScore

  const win = picked.filter(item => toInt(item.gameresult) === 1).length
  const lose = picked.filter(item => toInt(item.gameresult) === 2).length
  const played = win + lose
  const winRate = played ? Math.round((win / played) * 1000) / 10 : 0

  // 折线点：抽稀后的每场一个点
  const trend = thin(picked).map(item => ({
    score: toInt(item.newMasterMatchScore),
    time: toInt(item.dtEventTime)
  }))

  // 逐日战况：一天一行，净涨跌 = 当天最后一场的 new - 第一场的 old
  const byDay = new Map()
  for (const item of picked) {
    const key = dayKey(toInt(item.dtEventTime))
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(item)
  }
  const dayRows = [...byDay.entries()].reverse().map(([key, list]) => {
    const dayStart = toInt(list[0].oldMasterMatchScore) || toInt(list[0].newMasterMatchScore)
    const dayEnd = toInt(list[list.length - 1].newMasterMatchScore)
    const diff = dayEnd - dayStart
    const w = list.filter(item => toInt(item.gameresult) === 1).length
    const l = list.filter(item => toInt(item.gameresult) === 2).length
    return {
      date: key.slice(5).replace('-', '/'),
      count: list.length,
      win: w,
      lose: l,
      score: dayEnd,
      deltaText: signed(diff),
      deltaClass: diff > 0 ? 'up' : (diff < 0 ? 'down' : 'flat')
    }
  })

  // 最近几场：倒序列出，分差用这一场自己的 old→new
  const recentRows = picked.slice(-recent).reverse().map(item => {
    const diff = toInt(item.newMasterMatchScore) - toInt(item.oldMasterMatchScore)
    const result = toInt(item.gameresult)
    return {
      heroName: heroMap[String(item.heroId)] || `英雄${item.heroId}`,
      heroIcon: iconOf(item.heroId),
      resultText: result === 1 ? '胜' : (result === 2 ? '负' : '—'),
      resultClass: result === 1 ? 'win' : (result === 2 ? 'lose' : 'flat'),
      kda: `${toInt(item.killcnt)}/${toInt(item.deadcnt)}/${toInt(item.assistcnt)}`,
      score: toInt(item.newMasterMatchScore),
      deltaText: signed(diff),
      deltaClass: diff > 0 ? 'up' : (diff < 0 ? 'down' : 'flat'),
      timeText: `${mdText(toInt(item.dtEventTime))} ${hmText(toInt(item.dtEventTime))}`
    }
  })

  const spanDays = Math.max(1, Math.round((toInt(last.dtEventTime) - toInt(first.dtEventTime)) / 86400 * 10) / 10)
  const streak = streaks(picked)

  // 英雄战绩：只统计有胜负的场次，按净分贡献排序，看清是谁在带分
  const heroMapStat = new Map()
  for (const item of picked) {
    const id = String(item.heroId || '')
    if (!id) continue
    if (!heroMapStat.has(id)) heroMapStat.set(id, { id, count: 0, win: 0, net: 0 })
    const row = heroMapStat.get(id)
    row.count += 1
    if (toInt(item.gameresult) === 1) row.win += 1
    row.net += toInt(item.newMasterMatchScore) - toInt(item.oldMasterMatchScore)
  }
  const heroRows = [...heroMapStat.values()]
    .sort((a, b) => b.net - a.net || b.count - a.count)
    .slice(0, 6)
    .map(row => ({
      heroName: heroMap[row.id] || `英雄${row.id}`,
      heroId: row.id,
      heroIcon: iconOf(row.id),
      count: row.count,
      winRate: row.count ? Math.round((row.win / row.count) * 100) : 0,
      netText: signed(row.net),
      netClass: row.net > 0 ? 'up' : (row.net < 0 ? 'down' : 'flat')
    }))

  return {
    count: picked.length,
    win,
    lose,
    winRate,
    winRateClass: winRate >= 50 ? 'good' : 'bad',
    startScore,
    current,
    peak,
    low,
    deltaText: signed(delta),
    deltaClass: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat'),
    maxWinStreak: streak.win,
    maxLoseStreak: streak.lose,
    spanDays,
    rangeText: `${mdText(toInt(first.dtEventTime))} ~ ${mdText(toInt(last.dtEventTime))}`,
    // 用户要 days 天，库里只有 spanDays 天，两个都说清楚。
    // 放宽过窗口时一律说实际覆盖，否则「近 2 天」会和旁边的日期区间自相矛盾
    coverText: !relaxed && spanDays >= days ? `近 ${days} 天` : `实际覆盖 ${spanDays} 天`,
    trend,
    dayRows,
    recentRows,
    heroRows
  }
}
