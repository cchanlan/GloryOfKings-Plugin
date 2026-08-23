/**
 * 日报 / 周报的汇总计算。全是纯函数，不碰接口、不碰 Yunzai 全局，可以脱机测。
 *
 * 数据来自 battleArchive（归档库），字段是裁过的精简版，
 * 但刻意保留了 summarizeSession 需要的那几个，所以段位星数直接复用 pushStore 那套——
 * 小编号回绕、赛季切换、0 星是真实值这些坑已经在那边踩平了，不重写一遍。
 */
import { summarizeSession, getHeroNameMap, formatOnlineDuration, formatStarChange, formatScoreDelta } from './pushStore.js'

const toInt = value => {
  const num = Number(value)
  return Number.isFinite(num) ? Math.trunc(num) : 0
}

/** 模式归类。mapName 实测形如「排位赛」/「排位赛 双排」/「巅峰赛」，其余按娱乐算 */
const MODE_RULES = [
  { test: /排位/, name: '排位赛' },
  { test: /巅峰/, name: '巅峰赛' }
]

export function resolveMode (mapName) {
  const name = String(mapName || '').trim()
  return MODE_RULES.find(rule => rule.test.test(name))?.name || (name || '其它')
}

/* ------------------------------------------------------------------ 区间 */

/** 今天 00:00 的时间戳（秒） */
export function todayStart (nowMs = Date.now()) {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

/**
 * 本周一 00:00 的时间戳（秒）。
 * getDay() 里 0 是周日，而中文语境的「本周」是周一到周日，
 * 所以周日要算成本周第 7 天（往前退 6 天），不能退到下一个周一去。
 */
export function weekStart (nowMs = Date.now()) {
  const d = new Date(nowMs)
  const day = d.getDay()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  return Math.floor(d.getTime() / 1000)
}

/* ------------------------------------------------------------------ 统计 */

/**
 * 区间内最长的连胜 / 连败。
 *
 * pushStore.calcStreak 算的是「从最新一场往前数」——那是给推送用的「当前连胜」。
 * 日报要的是这段时间里最长的一段，可能在区间中间，所以得自己扫一遍。
 *
 * @param {Array<object>} battles 倒序（最新在前）
 * @returns {{type:'win'|'lose'|'', count:number}}
 */
export function maxStreak (battles = []) {
  let best = { type: '', count: 0 }
  let curType = 0
  let curCount = 0

  // 从最早往最新扫，方向不影响「最长一段」的长度
  for (let i = battles.length - 1; i >= 0; i -= 1) {
    const result = toInt(battles[i]?.gameresult)
    // 1胜 2负，其它值是逃跑/未结算，中断计数
    if (result !== 1 && result !== 2) {
      curType = 0
      curCount = 0
      continue
    }

    if (result === curType) curCount += 1
    else {
      curType = result
      curCount = 1
    }

    if (curCount > best.count) {
      best = { type: curType === 1 ? 'win' : 'lose', count: curCount }
    }
  }

  return best
}

/** 按天分组，返回从早到晚。周报的柱状图用 */
export function groupByDay (battles = []) {
  const days = new Map()

  for (const item of battles) {
    const ts = toInt(item?.dtEventTime)
    if (ts <= 0) continue

    const d = new Date(ts * 1000)
    const key = `${d.getMonth() + 1}/${d.getDate()}`

    if (!days.has(key)) {
      days.set(key, { date: key, weekday: '日一二三四五六'[d.getDay()], count: 0, win: 0, lose: 0, ts })
    }

    const entry = days.get(key)
    entry.count += 1
    if (toInt(item.gameresult) === 1) entry.win += 1
    else if (toInt(item.gameresult) === 2) entry.lose += 1
    // 同一天里留最早那个时间戳，用于排序
    if (ts < entry.ts) entry.ts = ts
  }

  return [...days.values()].sort((a, b) => a.ts - b.ts)
}

/** 24 格活跃时段，返回每小时的场次数 */
export function groupByHour (battles = []) {
  const hours = new Array(24).fill(0)

  for (const item of battles) {
    const ts = toInt(item?.dtEventTime)
    if (ts <= 0) continue
    hours[new Date(ts * 1000).getHours()] += 1
  }

  return hours
}

/**
 * 英雄使用榜，按场次降序、同场次按胜率降序。
 * @param {Array<object>} battles
 * @param {Record<string,string>} heroMap heroId -> 英雄名
 */
export function rankHeroes (battles = [], heroMap = {}) {
  const heroes = new Map()

  for (const item of battles) {
    const id = String(item?.heroId ?? '')
    if (!id || id === '0') continue

    if (!heroes.has(id)) {
      heroes.set(id, { heroId: id, name: heroMap[id] || `英雄${id}`, count: 0, win: 0, lose: 0, gradeSum: 0, graded: 0 })
    }

    const entry = heroes.get(id)
    entry.count += 1
    if (toInt(item.gameresult) === 1) entry.win += 1
    else if (toInt(item.gameresult) === 2) entry.lose += 1

    const grade = Number(item.gradeGame)
    if (Number.isFinite(grade) && grade > 0) {
      entry.gradeSum += grade
      entry.graded += 1
    }
  }

  return [...heroes.values()]
    .map(entry => ({
      ...entry,
      winRate: entry.win + entry.lose > 0 ? Math.round((entry.win / (entry.win + entry.lose)) * 100) : 0,
      avgGrade: entry.graded > 0 ? (entry.gradeSum / entry.graded).toFixed(1) : ''
    }))
    .sort((a, b) => b.count - a.count || b.winRate - a.winRate)
}

/**
 * 汇总一个区间的战绩。
 *
 * @param {Array<object>} battles 归档里已按区间过滤的战绩，倒序
 * @param {object} [options]
 * @param {number} [options.fromSec] 区间起点，透传给 summarizeSession 算段位星数与巅峰分
 * @param {Record<string,string>} [options.heroMap] heroId -> 英雄名
 * @returns {object} 给模板用的汇总结果
 */
export function summarizeReport (battles = [], { fromSec = 0, heroMap = {} } = {}) {
  const list = Array.isArray(battles) ? battles : []
  const win = list.filter(item => toInt(item?.gameresult) === 1).length
  const lose = list.filter(item => toInt(item?.gameresult) === 2).length
  const decided = win + lose

  // 段位星数与巅峰分直接复用推送那套：它的口径是「dtEventTime >= since 到最新」，
  // 和日报/周报的「区间起点到现在」完全一致
  const session = summarizeSession(list, fromSec)

  const modes = new Map()
  let totalSec = 0
  let mvp = 0
  let loseMvp = 0
  let best = null

  for (const item of list) {
    const mode = resolveMode(item?.mapName)
    if (!modes.has(mode)) modes.set(mode, { name: mode, count: 0, win: 0 })
    const entry = modes.get(mode)
    entry.count += 1
    if (toInt(item.gameresult) === 1) entry.win += 1

    totalSec += toInt(item.usedTime)
    mvp += toInt(item.mvpcnt)
    loseMvp += toInt(item.losemvp)

    const grade = Number(item.gradeGame)
    if (Number.isFinite(grade) && grade > 0 && (!best || grade > Number(best.gradeGame))) best = item
  }

  const heroes = rankHeroes(list, heroMap)

  return {
    count: list.length,
    win,
    lose,
    // 逃跑/未结算的局不算进胜率分母，否则胜率会被莫名拉低
    winRate: decided > 0 ? Math.round((win / decided) * 100) : 0,
    modes: [...modes.values()].sort((a, b) => b.count - a.count),
    heroes,
    topHero: heroes[0] || null,
    best: best
      ? {
          grade: best.gradeGame,
          heroName: heroMap[String(best.heroId)] || `英雄${best.heroId}`,
          kda: `${toInt(best.killcnt)}/${toInt(best.deadcnt)}/${toInt(best.assistcnt)}`,
          win: toInt(best.gameresult) === 1,
          mapName: best.mapName || ''
        }
      : null,
    mvp,
    loseMvp,
    streak: maxStreak(list),
    byDay: groupByDay(list),
    byHour: groupByHour(list),
    totalSec,
    // 用 formatOnlineDuration 而不是 formatDuration：后者是给单局用的「15分16秒」，
    // 汇总动辄好几百分钟，得进到小时（实测真实数据 415 分钟）
    totalTimeText: formatOnlineDuration(totalSec),
    // 段位星数 / 巅峰分，字段名沿用 summarizeSession
    stars: {
      jobFrom: session.jobFrom,
      starFrom: session.starFrom,
      jobNumFrom: session.jobNumFrom,
      jobTo: session.jobTo,
      starTo: session.starTo,
      jobNumTo: session.jobNumTo
    },
    // 键名必须是 scoreFrom/scoreTo：formatScoreDelta 读的是这两个名字，
    // 之前写成 { from, to } 它取到 undefined，巅峰分那行从来没出现过
    score: { scoreFrom: session.scoreFrom, scoreTo: session.scoreTo }
  }
}

/** 英雄名映射的薄封装，让 app 只依赖 reportStore 一个模块 */
export { getHeroNameMap }

/* ------------------------------------------------------------------ 模板数据 */

/**
 * 官网英雄头像。heroId 就是官网的 ename，头像路径是固定规律
 * （实测 519 / 558 / 166 都是 200），所以不用把 heroIcon 那串 URL 存进归档——
 * 一条 URL 80 字节，一千场就是 80KB，白占一倍体积。
 */
export function heroIconUrl (heroId) {
  const id = String(heroId ?? '').trim()
  return id ? `https://game.gtimg.cn/images/yxzj/img201606/heroimg/${id}/${id}.jpg` : ''
}

const MD = ts => {
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
const WEEKDAY = ts => `周${'日一二三四五六'[new Date(ts * 1000).getDay()]}`

/** 胜率的色调档位。55% 以上算好、45% 以下算差，中间不着色 */
function rateTone (rate, count) {
  if (!count) return ''
  if (rate >= 55) return 'good'
  if (rate < 45) return 'bad'
  return ''
}

/**
 * 把 summarizeReport 的结果转成模板变量。
 *
 * 放在这里而不是 app 里，是因为这全是纯计算、能脱机测，
 * 而 apps/*.js 里 `extends plugin` 依赖 Yunzai 注入的全局，import 就崩。
 *
 * @param {object} report summarizeReport 的返回
 * @param {object} opts
 * @param {'daily'|'weekly'} opts.kind
 * @param {number} opts.fromSec 区间起点
 * @param {number} opts.nowMs 生成时刻
 * @param {number} [opts.coveredFrom] 归档实际覆盖到的最早时刻
 * @param {boolean} [opts.truncated] 翻页撞了上限、区间起点没够着
 * @param {string} [opts.roleName] 玩家名
 * @param {string} [opts.roleIcon] 头像 URL
 * @param {number} [opts.heroLimit] 英雄榜最多列几个
 */
export function buildReportView (report, {
  kind = 'daily',
  fromSec = 0,
  nowMs = Date.now(),
  coveredFrom = 0,
  truncated = false,
  roleName = '',
  roleIcon = '',
  heroLimit = 0
} = {}) {
  const isWeekly = kind === 'weekly'
  const nowSec = Math.floor(nowMs / 1000)
  const limit = heroLimit || (isWeekly ? 8 : 5)

  const star = formatStarChange(report.stars)
  const score = formatScoreDelta(report.score)
  const changeLines = [star, score]
    .filter(Boolean)
    .map(item => ({ text: `${item.icon} ${item.text}`.trim(), tone: item.tone }))

  // 英雄榜的条形长度按「场次占最多那个的比例」，第一名铺满
  const topCount = report.heroes[0]?.count || 1
  const heroes = report.heroes.slice(0, limit).map((h, idx) => ({
    ...h,
    rank: idx + 1,
    icon: heroIconUrl(h.heroId),
    barWidth: Math.max(6, Math.round((h.count / topCount) * 100)),
    wrClass: rateTone(h.winRate, h.count)
  }))

  const facts = []
  if (report.streak.count >= 2) {
    facts.push({
      key: report.streak.type === 'win' ? '最长连胜' : '最长连败',
      val: `${report.streak.count} 连${report.streak.type === 'win' ? '胜' : '败'}`,
      tone: report.streak.type === 'win' ? 'gold' : 'bad'
    })
  }
  if (report.best) {
    facts.push({
      key: '最佳一局',
      val: `${report.best.grade} 分 · ${report.best.heroName} · ${report.best.kda}`,
      tone: 'gold'
    })
  }
  if (report.mvp > 0 || report.loseMvp > 0) {
    // 败方 MVP 单独说：那是「输了但打得好」，混进 MVP 数里会虚高
    const parts = []
    if (report.mvp > 0) parts.push(`${report.mvp} 次`)
    if (report.loseMvp > 0) parts.push(`败方 ${report.loseMvp} 次`)
    facts.push({ key: 'MVP', val: parts.join(' · '), tone: 'gold' })
  }
  if (report.modes.length) {
    facts.push({
      key: '模式分布',
      val: report.modes.map(m => `${m.name} ${m.count}`).join(' · '),
      tone: ''
    })
  }
  if (report.count > 0) {
    facts.push({ key: '场均时长', val: formatOnlineDuration(Math.round(report.totalSec / report.count)) || '—', tone: '' })
  }
  if (isWeekly && report.byDay.length) {
    const busiest = report.byDay.reduce((a, b) => (b.count > a.count ? b : a))
    facts.push({ key: '最勤快的一天', val: `${busiest.date} 打了 ${busiest.count} 局`, tone: '' })
  }
  // 奇数个 fact 会在两列布局里留一个空格子，补一条把它填满
  if (facts.length % 2 === 1) {
    facts.push({ key: '统计范围', val: isWeekly ? '本周至今' : '今日', tone: '' })
  }

  // 活跃时段：24 格，按最高的那小时归一
  const maxHour = Math.max(...report.byHour, 1)
  const peakHour = report.byHour.indexOf(maxHour)
  const hourBars = report.byHour.map((count, hour) => ({
    label: hour % 3 === 0 ? String(hour) : '',
    height: count > 0 ? Math.max(6, Math.round((count / maxHour) * 100)) : 0,
    peak: count === maxHour && count > 0
  }))

  const rangeText = isWeekly
    ? `${MD(fromSec)} - ${MD(nowSec)}`
    : `${MD(fromSec)} ${WEEKDAY(fromSec)}`

  // 覆盖范围如实标注：首次查周报时库是空的，翻页有上限，重度玩家一周 200 场可能盖不住。
  // 不标的话图上「本周 140 场」会被当成全部，实际是被截断的
  const covered = truncated && coveredFrom > fromSec
    ? `数据覆盖自 ${MD(coveredFrom)}（更早的还没归档）`
    : ''

  return {
    title: isWeekly ? '战绩周报' : '战绩日报',
    isWeekly,
    rangeText,
    subText: new Date(nowMs).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    roleName: roleName || '召唤师',
    roleIcon,
    count: report.count,
    win: report.win,
    lose: report.lose,
    winRate: report.winRate,
    winRateClass: rateTone(report.winRate, report.count),
    totalTimeText: report.totalTimeText || '—',
    changeLines,
    byDay: report.byDay,
    byDayJson: JSON.stringify(report.byDay),
    heroes,
    heroTotal: report.heroes.length,
    facts,
    hourBars,
    peakHourText: report.count ? `${peakHour} 点最活跃` : '',
    footText: covered || `王者插件 · ${isWeekly ? '周报' : '日报'}生成于 ${new Date(nowMs).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  }
}
