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

/** 本月 1 号 00:00 的时间戳（秒） */
export function monthStart (nowMs = Date.now()) {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  d.setDate(1)
  return Math.floor(d.getTime() / 1000)
}

/**
 * 月报的推送日闸门。
 *
 * 月报口径是「本月至今」（monthStart 起），所以只有月末那天推出来的才是完整的一个月。
 * cron 没法表达「每月最后一天」——2 月 28/29、其余月 30/31 都不一样，
 * 默认配置只能写成 28-31 号每晚触发，再由这里挑出真正的最后一天。
 *
 * 只在 28 号及以后设闸：这样把 cron 改成「每天」的人仍能每天收到本月进度，
 * 月末几天才收敛成一次，不至于同一份数据连推四天。
 *
 * @returns {boolean} 今天该不该推月报
 */
export function isMonthlyPushDay (nowMs = Date.now()) {
  const d = new Date(nowMs)
  if (d.getDate() < 28) return true
  const next = new Date(d)
  next.setDate(d.getDate() + 1)
  return next.getMonth() !== d.getMonth()
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

/* ------------------------------------------------------------------ 群汇总 */

/**
 * 一个成员这段时间的「涨跌」，供群榜的进步榜/掉分榜排序。
 *
 * 只拿**巅峰分**做可比的数值：巅峰分是一条全服连续刻度，谁涨 30 谁掉 20 直接可比。
 * 段位星数不行——星耀的 1 星和最强王者的 1 星难度差着量级，跨人相减没有意义，
 * 所以段位那边只产出「升没升段」这个布尔性质的结论（rankUpText），不参与数值排序。
 *
 * @param {object} report summarizeReport 的结果
 * @returns {{scoreDelta:number|null, scoreText:string, rankUpText:string}}
 *   scoreDelta 为 null 表示这段时间没打巅峰赛（或分数没动），不该进这两个榜
 */
function pickProgress (report) {
  const delta = formatScoreDelta(report?.score)
  const from = toInt(report?.score?.scoreFrom)
  const to = toInt(report?.score?.scoreTo)

  // 段位：只报「升段」这一种结论。formatStarChange 的 tone 已经把
  // 「同名段跨小段」「赛季重置导致编号下降」这些坑判过了，别在这里重写判据
  const star = formatStarChange(report?.stars)
  const jobFrom = String(report?.stars?.jobFrom || '')
  const jobTo = String(report?.stars?.jobTo || '')

  return {
    scoreDelta: delta ? to - from : null,
    scoreText: delta ? delta.text : '',
    rankUpText: star?.tone === 'up' && jobFrom && jobTo && jobFrom !== jobTo
      ? `${jobFrom} → ${jobTo}`
      : ''
  }
}

/**
 * 把多个成员的 summarizeReport 结果聚成一份群榜。
 *
 * 不做成「把战绩混一起再 summarizeReport」：段位星数那套（summarizeSession）
 * 是单人口径，混着算出来的星数变化没有任何意义；群榜要的是「谁打得多、谁胜率高」，
 * 逐人汇总再排行就够了。
 *
 * @param {Array<{name:string, icon:string, report:object}>} members
 * @returns {object} 给 buildGroupView 用的聚合结果
 */
export function summarizeGroup (members = []) {
  const rows = members
    .filter(m => m?.report?.count > 0)
    .map(m => ({
      name: m.name || '召唤师',
      icon: m.icon || '',
      count: m.report.count,
      win: m.report.win,
      lose: m.report.lose,
      winRate: m.report.winRate,
      totalSec: m.report.totalSec,
      totalTimeText: m.report.totalTimeText,
      mvp: m.report.mvp,
      loseMvp: m.report.loseMvp,
      topHero: m.report.topHero
        ? { heroId: m.report.topHero.heroId, name: m.report.topHero.name, count: m.report.topHero.count }
        : null,
      streak: m.report.streak || { type: '', count: 0 },
      // 进步榜/掉分榜要用的两个量，口径见 pickProgress
      ...pickProgress(m.report)
    }))
    .sort((a, b) => b.count - a.count || b.winRate - a.winRate)

  const totalCount = rows.reduce((s, r) => s + r.count, 0)
  const totalWin = rows.reduce((s, r) => s + r.win, 0)
  const totalLose = rows.reduce((s, r) => s + r.lose, 0)
  const decided = totalWin + totalLose

  // 所有成员的战绩合起来算活跃时段 / 每日分布——这是「群」的作息，单人的没意义
  const allBattles = members.flatMap(m => m.battles || [])

  // 全群英雄合计。直接合并各成员 report.heroes 而不是拿 allBattles 重跑 rankHeroes：
  // 英雄名已经在 summarizeReport 那边解析过了，这样 summarizeGroup 就不用再接一份 heroMap
  const heroTotals = new Map()
  for (const m of members) {
    for (const h of m?.report?.heroes || []) {
      const id = String(h?.heroId ?? '')
      if (!id) continue
      if (!heroTotals.has(id)) {
        heroTotals.set(id, { heroId: id, name: h.name, count: 0, win: 0, lose: 0, users: 0 })
      }
      const entry = heroTotals.get(id)
      entry.count += h.count || 0
      entry.win += h.win || 0
      entry.lose += h.lose || 0
      // 有多少个人玩过这个英雄，用来说明「全群都在玩」还是「某一个人在刷」
      entry.users += 1
    }
  }

  const heroes = [...heroTotals.values()]
    .map(entry => ({
      ...entry,
      winRate: entry.win + entry.lose > 0 ? Math.round((entry.win / (entry.win + entry.lose)) * 100) : 0
    }))
    .sort((a, b) => b.count - a.count || b.winRate - a.winRate)

  return {
    rows,
    memberCount: rows.length,
    count: totalCount,
    win: totalWin,
    lose: totalLose,
    winRate: decided > 0 ? Math.round((totalWin / decided) * 100) : 0,
    totalSec: rows.reduce((s, r) => s + r.totalSec, 0),
    mvp: rows.reduce((s, r) => s + r.mvp, 0),
    heroes,
    byDay: groupByDay(allBattles),
    byHour: groupByHour(allBattles),
    // 各榜的头名，没有就是 null，模板自己兜底
    topGrinder: rows[0] || null, // 肝帝：场次最多
    topWinner: rows.length ? [...rows].sort((a, b) => b.win - a.win)[0] : null, // 胜场王
    topRate: rows.filter(r => r.count >= 3).sort((a, b) => b.winRate - a.winRate)[0] || null, // 胜率王（≥3 场防一场 100% 刷榜）
    topMvp: rows.filter(r => r.mvp > 0).sort((a, b) => b.mvp - a.mvp)[0] || null,
    topLoseMvp: rows.filter(r => r.loseMvp > 0).sort((a, b) => b.loseMvp - a.loseMvp)[0] || null, // 尽力局长
    // 最长连败也值一个称号，群里就爱看这个
    topStreak: rows.filter(r => r.streak?.type === 'win' && r.streak.count >= 3)
      .sort((a, b) => b.streak.count - a.streak.count)[0] || null,
    // 巅峰分涨得最多 / 掉得最多。只认巅峰分（口径见 pickProgress），
    // 没人打巅峰赛时两个都是 null，称号栏自动不占位
    topRise: rows.filter(r => Number(r.scoreDelta) > 0)
      .sort((a, b) => b.scoreDelta - a.scoreDelta)[0] || null,
    topDrop: rows.filter(r => Number(r.scoreDelta) < 0)
      .sort((a, b) => a.scoreDelta - b.scoreDelta)[0] || null,
    // 升段的人。段位跨段没法和别人比数值，所以不排序，谁先升到就先列谁
    topRankUp: rows.filter(r => r.rankUpText)[0] || null
  }
}

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
  const isMonthly = kind === 'monthly'
  const nowSec = Math.floor(nowMs / 1000)
  const limit = heroLimit || (isWeekly ? 8 : isMonthly ? 10 : 5)

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
  if ((isWeekly || isMonthly) && report.byDay.length) {
    const busiest = report.byDay.reduce((a, b) => (b.count > a.count ? b : a))
    facts.push({ key: '最勤快的一天', val: `${busiest.date} 打了 ${busiest.count} 局`, tone: '' })
  }
  // 奇数个 fact 会在两列布局里留一个空格子，补一条把它填满
  if (facts.length % 2 === 1) {
    facts.push({ key: '统计范围', val: isMonthly ? '本月至今' : isWeekly ? '本周至今' : '今日', tone: '' })
  }

  // 活跃时段：24 格，按最高的那小时归一
  const maxHour = Math.max(...report.byHour, 1)
  const peakHour = report.byHour.indexOf(maxHour)
  const hourBars = report.byHour.map((count, hour) => ({
    label: hour % 3 === 0 ? String(hour) : '',
    height: count > 0 ? Math.max(6, Math.round((count / maxHour) * 100)) : 0,
    peak: count === maxHour && count > 0
  }))

  const rangeText = isWeekly || isMonthly
    ? `${MD(fromSec)} - ${MD(nowSec)}`
    : `${MD(fromSec)} ${WEEKDAY(fromSec)}`

  // 覆盖范围如实标注：首次查周报时库是空的，翻页有上限，重度玩家一周 200 场可能盖不住。
  // 不标的话图上「本周 140 场」会被当成全部，实际是被截断的
  const covered = truncated && coveredFrom > fromSec
    ? `数据覆盖自 ${MD(coveredFrom)}（更早的还没归档）`
    : ''

  return {
    title: isMonthly ? '战绩月报' : isWeekly ? '战绩周报' : '战绩日报',
    isWeekly,
    isMonthly,
    // 每日趋势图：周报/月报都有多天数据才画，日报只有一天画了也是一根孤柱
    showDayChart: (isWeekly || isMonthly) && report.byDay.length > 1,
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
    footText: covered || `王者插件 · ${isMonthly ? '月报' : isWeekly ? '周报' : '日报'}生成于 ${new Date(nowMs).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  }
}

/* ------------------------------------------------------------------ 群模板数据 */

/**
 * 把 summarizeGroup 的结果转成群榜模板变量。
 * @param {object} group summarizeGroup 的返回
 * @param {object} opts
 * @param {'daily'|'weekly'|'monthly'} opts.kind
 * @param {number} opts.fromSec 区间起点
 * @param {number} opts.nowMs 生成时刻
 * @param {string} [opts.groupName] 群名（取不到就用群号）
 * @param {number} [opts.coveredFrom] 覆盖边界（取所有成员水位的最大值——最差的那个）
 * @param {boolean} [opts.truncated] 有成员翻页撞上限
 * @param {number} [opts.rowLimit] 排行榜最多列几个人，超出的只计入合计
 * @param {number} [opts.heroLimit] 群英雄榜最多列几个
 * @param {number} [opts.scanned] 实际扫了几个绑定成员（含没打的），用于「N 人有对局 / 共扫 M 人」
 */
export function buildGroupView (group, {
  kind = 'daily',
  fromSec = 0,
  nowMs = Date.now(),
  groupName = '',
  coveredFrom = 0,
  truncated = false,
  rowLimit = 15,
  heroLimit = 6,
  scanned = 0
} = {}) {
  const isWeekly = kind === 'weekly'
  const isMonthly = kind === 'monthly'
  const nowSec = Math.floor(nowMs / 1000)
  const label = isMonthly ? '月报' : isWeekly ? '周报' : '日报'

  const topCount = group.rows[0]?.count || 1
  const rows = group.rows.slice(0, rowLimit).map((r, idx) => ({
    ...r,
    rank: idx + 1,
    topHeroIcon: r.topHero ? heroIconUrl(r.topHero.heroId) : '',
    barWidth: Math.max(6, Math.round((r.count / topCount) * 100)),
    wrClass: rateTone(r.winRate, r.count),
    // 前三名给金银铜色调，模板按 rankClass 上色
    rankClass: idx === 0 ? 'gold' : idx === 1 ? 'silver' : idx === 2 ? 'bronze' : '',
    // 连胜/连败徽标，3 连起才值得标
    streakText: r.streak?.count >= 3 ? `${r.streak.count}连${r.streak.type === 'win' ? '胜' : '败'}` : '',
    streakClass: r.streak?.type === 'win' ? 'gold' : 'bad'
  }))

  // 称号栏：只列存在的，空的不占位
  const awards = []
  const award = (key, row, fmt) => row && awards.push({ key, val: fmt(row), icon: row.icon })
  award('肝帝', group.topGrinder, r => `${r.name} · ${r.count} 场`)
  award('胜场王', group.topWinner, r => `${r.name} · ${r.win} 胜`)
  award('胜率王', group.topRate, r => `${r.name} · ${r.winRate}%（${r.count} 场）`)
  award('MVP 收割机', group.topMvp, r => `${r.name} · ${r.mvp} 次`)
  award('尽力局长', group.topLoseMvp, r => `${r.name} · 败方 MVP ${r.loseMvp} 次`)
  award('连胜之星', group.topStreak, r => `${r.name} · ${r.streak.count} 连胜`)
  award('上分之王', group.topRise, r => `${r.name} · 巅峰分 +${r.scoreDelta}`)
  award('血亏之王', group.topDrop, r => `${r.name} · 巅峰分 ${r.scoreDelta}`)
  award('升段之星', group.topRankUp, r => `${r.name} · ${r.rankUpText}`)

  const heroTop = group.heroes?.[0]?.count || 1
  const heroes = (group.heroes || []).slice(0, heroLimit).map((h, idx) => ({
    ...h,
    rank: idx + 1,
    icon: heroIconUrl(h.heroId),
    barWidth: Math.max(6, Math.round((h.count / heroTop) * 100)),
    wrClass: rateTone(h.winRate, h.count)
  }))

  const maxHour = Math.max(...group.byHour, 1)
  const peakHour = group.byHour.indexOf(maxHour)
  const hourBars = group.byHour.map((count, hour) => ({
    label: hour % 3 === 0 ? String(hour) : '',
    height: count > 0 ? Math.max(6, Math.round((count / maxHour) * 100)) : 0,
    peak: count === maxHour && count > 0
  }))

  const rangeText = isWeekly || isMonthly
    ? `${MD(fromSec)} - ${MD(nowSec)}`
    : `${MD(fromSec)} ${WEEKDAY(fromSec)}`

  const covered = truncated && coveredFrom > fromSec
    ? `数据覆盖自 ${MD(coveredFrom)}（更早的还没归档）`
    : ''

  return {
    title: `群战绩${label}`,
    label,
    // 「本日 / 本周 / 本月称号」的量词。别拿 label 拼，那会拼出「本日报称号」
    unit: isMonthly ? '月' : isWeekly ? '周' : '日',
    isWeekly,
    isMonthly,
    showDayChart: (isWeekly || isMonthly) && group.byDay.length > 1,
    rangeText,
    subText: new Date(nowMs).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    groupName: groupName || '本群',
    memberCount: group.memberCount,
    // 扫了几个人：群里绑定了但这段时间没打的不上榜，图上要说清分母
    scannedText: scanned > group.memberCount ? `${group.memberCount} / ${scanned} 人有对局` : `${group.memberCount} 人上榜`,
    count: group.count,
    win: group.win,
    lose: group.lose,
    winRate: group.winRate,
    winRateClass: rateTone(group.winRate, group.count),
    totalTimeText: formatOnlineDuration(group.totalSec) || '—',
    avgCount: group.memberCount > 0 ? (group.count / group.memberCount).toFixed(1) : '0',
    mvp: group.mvp || 0,
    rows,
    rowsHidden: Math.max(0, group.rows.length - rows.length),
    awards,
    heroes,
    heroTotal: (group.heroes || []).length,
    byDay: group.byDay,
    byDayJson: JSON.stringify(group.byDay),
    hourBars,
    peakHourText: group.count ? `${peakHour} 点最活跃` : '',
    footText: covered || `王者插件 · 群${label}生成于 ${new Date(nowMs).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  }
}
