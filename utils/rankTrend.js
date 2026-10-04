/**
 * 段位趋势的数据整理（纯计算，不发任何请求）。
 *
 * 数据源和 utils/scoreTrend.js 一样是本地归档库（BattleArchive.json，保留 35 天），
 * 但口径完全不同：巅峰趋势看的是一条连续刻度（巅峰分），段位看的是**离散阶梯**。
 *
 * ## 实测口径，别再猜（2026-08-27 在 413 场归档上核对）
 *
 * ### 1. 每一场都带段位快照，娱乐局也带，但**只取排位局**
 * `roleJobName` / `roleJob` / `stars` 三个字段在**所有模式**里都有值——排位赛、巅峰赛、
 * 无限乱斗、火焰山大战、10v10 一场不漏（413/413）。它是「打这局时你的段位」的快照，
 * 不是这局的产物。
 *
 * 早先版本图上画全部场次（想把「这几天在摸鱼」画成水平段），实测出来的问题是：
 * 巅峰赛和娱乐局一晚上能打十几把，段位一格不动，折线被这些水平点拖长，
 * 真正的升降星挤成图右边的几格。所以口径改成**只认 mapName 含「排位」的场次**，
 * 和 scoreTrend 只认「巅峰」是同一个道理——影响这条曲线的场次才画进这条曲线。
 *
 * ### 2. 段位高低不能直接比 `roleJob` 编号
 * 编号在同一大段内是单调的（实测 52334903：星耀 22 → 23 → 24，每次升段星数重置为 1），
 * 但**王者段的编号是 16，比星耀的 22~25 小**：
 *
 * | 段位名 | roleJob | stars 实测范围 |
 * |---|---|---|
 * | 倔强青铜II | 2 | 1 |
 * | 荣耀黄金III | 19 | 2 |
 * | 永恒钻石V | 20（另有 12，见第 4 点） | 1~4 |
 * | 至尊星耀V / III / II | 22~23 / 22~24 / 23~25 | 0~5 |
 * | 最强/非凡/绝世/至圣/荣耀王者 | **16** | 5~97（累积，不重置） |
 *
 * 所以「星耀 → 王者」这个最该报喜的时刻，编号是 25 → 16，**看着像掉了 9 段**。
 * pushStore 的 formatStarChange 里那句「编号下降可能是赛季重置（实测 26→16）」
 * 记的就是这个现象，它当时被当成了不可判定的情况。这里改用大段位名做主序解决：
 *
 *   高低 = 大段位层级（青铜1 … 星耀6、王者7） → roleJob 编号 → stars
 *
 * ### 3. 段位名的粒度比编号粗，两者不是一一对应
 * 「至尊星耀III」下面出现过编号 22/23/24，而编号 23 在别的号上叫「至尊星耀V」或「至尊星耀II」。
 * 也就是说 `roleJobName` 不足以定位小段（它更像营地当前显示的称号，王者段内还随星数换称号：
 * 5~13 星叫非凡王者、27~48 星叫绝世/至圣王者、46 星以上叫荣耀王者）。
 * 结论：**名字只用来显示和定大段，小段一律看编号。**
 *
 * ### 4. 同一个营地 ID 的归档里可能混进两个角色
 * 实测 1630945798 在 20 分钟内出现编号 12 和 20 交替，两边都叫「永恒钻石V」——
 * 一个营地账号名下可以有多个游戏角色，归档是按 campId 分桶的，
 * 而战绩列表里**没有任何角色标识字段**（`userId` 恒为 "0"，全 60+ 字段找过一遍），
 * 所以切了角色的记录会混进同一个桶，没法在数据层分开。
 * 处理方式是画图时把编号跳变 ≥ JUMP_TOLERANCE 的地方断开成独立线段并如实标注，
 * 而不是画成一条从天上掉下来的直线。
 */

/** 默认看多少天 */
export const RANK_TREND_DEFAULT_DAYS = 14
/**
 * 想凑够多少场排位局。
 *
 * 只取排位局之后，「近 14 天」对不常打排位的号可能只有三五场，图上没什么可看。
 * 所以天数只是首选窗口：窗口内不足这个数就放宽到全库最近这么多场（见 pickRankWindow），
 * 调用方也据此决定要不要现拉几页补上。
 */
export const RANK_TREND_TARGET_POINTS = 10
/** 折线最多画多少个点，超了等距抽稀（首尾必留） */
const MAX_POINTS = 60
/**
 * 编号跳变多少算「不是正常升降段」。
 * 正常打一晚上最多升降 1~2 个小段；跳 3 段以上要么是切了角色（见文件头第 4 点）、
 * 要么是赛季重置，两种都不该连成一条线。
 */
const JUMP_TOLERANCE = 3

const toInt = value => {
  const num = Number(value)
  return Number.isFinite(num) ? Math.trunc(num) : 0
}

/**
 * 大段位层级表，低 → 高。测试顺序有讲究：
 * 「荣耀黄金III」和「荣耀王者」都含「荣耀」，黄金必须排在王者前面先命中；
 * 王者那条只认「王者」二字，好把最强/非凡/绝世/至圣/荣耀/传奇王者一网打尽。
 */
const RANK_BANDS = [
  { test: /青铜/, band: 1, short: '青铜' },
  { test: /白银/, band: 2, short: '白银' },
  { test: /黄金/, band: 3, short: '黄金' },
  { test: /铂金|白金/, band: 4, short: '铂金' },
  { test: /钻石/, band: 5, short: '钻石' },
  { test: /星耀/, band: 6, short: '星耀' },
  { test: /王者/, band: 7, short: '王者' }
]

/** 段位名 → 大段位层级。认不出来时返回 0，参与排序时会被当成最低（但仍然照常画点） */
export function rankBand (jobName) {
  const name = String(jobName || '').trim()
  return RANK_BANDS.find(item => item.test.test(name))?.band || 0
}

/** 段位名 → 「星耀」这种两字简称，图上做分层标签用 */
export function rankBandShort (jobName) {
  const name = String(jobName || '').trim()
  return RANK_BANDS.find(item => item.test.test(name))?.short || (name.slice(0, 2) || '未知')
}

/** 是不是王者段。王者段的 stars 是累积值（实测到 97 星），跟别的段不是一个量纲 */
export function isKingBand (jobName) {
  return rankBand(jobName) === 7
}

/** 排位赛才改变段位。巅峰赛改的是巅峰分，娱乐模式什么都不改 */
export function isRankedBattle (item) {
  return String(item?.mapName || '').includes('排位')
}

/**
 * 从归档里挑出区间内的**排位局**，正序（旧 → 新）。
 *
 * 只认排位赛：巅峰赛和娱乐局虽然也带段位快照，但一格都不会动，画进来只是把真实的
 * 升降星挤扁（文件头第 1 点）。没有段位名的场次同样扔掉——那种记录连大段都定不了。
 *
 * @param {Array<object>} battles loadArchive 的返回（倒序）
 * @param {number} fromSec 区间起点（秒）
 * @returns {Array<object>} 正序
 */
export function pickRankBattles (battles = [], fromSec = 0) {
  const from = toInt(fromSec)
  return (Array.isArray(battles) ? battles : [])
    .filter(item => (
      isRankedBattle(item) &&
      toInt(item?.dtEventTime) >= from &&
      String(item?.roleJobName || '').trim() &&
      toInt(item?.roleJob) > 0
    ))
    .slice()
    .sort((a, b) => toInt(a.dtEventTime) - toInt(b.dtEventTime))
}

/**
 * 取「要画的那一窗排位局」：先按天数窗口取，窗口内不足 target 场就放宽成全库最近 target 场。
 *
 * 为什么要放宽：排位局本来就是少数（实测 48 场里只有 15 场排位），按 14 天取常常只剩
 * 三五场，画出来的阶梯图看不出走势。用户要的是「最近这些排位打成什么样」，
 * 窗口是手段不是目的；放宽了就在图上如实标出来，别让人以为真是近 N 天的数据。
 *
 * @returns {{list: Array<object>, relaxed: boolean}} relaxed=true 表示突破了天数窗口
 */
export function pickRankWindow (battles = [], fromSec = 0, target = RANK_TREND_TARGET_POINTS) {
  const inRange = pickRankBattles(battles, fromSec)
  if (inRange.length >= target) return { list: inRange, relaxed: false }

  const all = pickRankBattles(battles, 0)
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

/** 「至尊星耀III 4星」这种完整标签 */
export function rankLabel (point) {
  if (!point?.jobName) return '未知段位'
  return `${point.jobName} ${point.stars}星`
}

/** 「星耀III 4★」这种短标签，图上的 y 轴刻度用，太长会顶出去 */
function shortLabel (point) {
  if (!point?.jobName) return '未知'
  const tail = point.jobName.match(/(I{1,3}|IV|V)$/)?.[1] || ''
  return `${rankBandShort(point.jobName)}${tail} ${point.stars}★`
}

/**
 * 一场战绩里的段位快照。
 *
 * `value` 是可比较的高低标量，三级排序压成一个数：大段位层级 → roleJob 编号 → stars。
 * 权重拉开到互不干扰：编号实测最大 26（占 1e4 档），星数王者段实测到 97（占 1e0 档）。
 * 为什么必须以大段位名为主序而不是直接比编号，见文件头第 2 点。
 *
 * 注意 value **不能直接当画图的 y 值**：跨大段差 1e7，一张图里混了两个大段就被压成两条
 * 贴边直线。画图另用离散刻度（见 buildRankTrendView 里的 levels）。
 */
export function rankPoint (item) {
  const jobName = String(item?.roleJobName || '').trim()
  const jobNum = toInt(item?.roleJob)
  const stars = toInt(item?.stars)
  const band = rankBand(jobName)

  return {
    jobName,
    jobNum,
    stars,
    band,
    value: band * 1e7 + jobNum * 1e4 + stars,
    time: toInt(item?.dtEventTime),
    ranked: isRankedBattle(item),
    win: toInt(item?.gameresult) === 1,
    heroId: String(item?.heroId || ''),
    mode: String(item?.mapName || '').trim()
  }
}

/**
 * 相邻两点之间是不是「不可比」的跳变（切了游戏角色 / 赛季重置）。
 *
 * - 大段跨 2 级以上：一晚上从钻石打到王者不可能，是切角色或赛季重置
 * - 同一大段内编号跳 JUMP_TOLERANCE 以上：实测 1630945798 的 12 ↔ 20（文件头第 4 点）
 *
 * 「星耀 → 王者」是 band 6→7、差 1，不断开——那正是最该连起来报喜的一段。
 * 编号只在两边都有值时才比：一边取不到编号（0）时硬减会把 0 ↔ 20 当成跳 20 段。
 *
 * 折线在这里断开，单场推送的段位文案也在这里放弃比较
 * （pushStore.formatScoreChange）——同一个判据只该有一份。
 *
 * @param {{band:number, jobNum:number}} prev 更早的一点
 * @param {{band:number, jobNum:number}} next 更晚的一点
 */
export function isRankJump (prev, next) {
  if (!prev || !next) return false
  const bandGap = Math.abs(next.band - prev.band)
  if (bandGap >= 2) return true
  if (bandGap !== 0) return false
  if (!prev.jobNum || !next.jobNum) return false
  return Math.abs(next.jobNum - prev.jobNum) >= JUMP_TOLERANCE
}

/**
 * 区间首尾之间怎么描述这段变化。分三种口径，因为段位不是一条连续刻度：
 *
 * 1. 大段和小段都没变 → 说星数差（「+3 星」），这是最常见的情形
 * 2. 同一大段内换了小段 → 说段数差（「+2 段」），星数在升段时会重置，相减没有意义
 * 3. 跨了大段 → 说大段名（「星耀 → 王者」），这是最该报喜的一句，别把它压成数字
 */
function describeDelta (first, last) {
  if (!first || !last) return { text: '—', cls: 'flat' }

  if (last.band !== first.band) {
    return {
      text: `${rankBandShort(first.jobName)} → ${rankBandShort(last.jobName)}`,
      cls: last.band > first.band ? 'up' : 'down'
    }
  }

  if (last.jobNum !== first.jobNum) {
    const diff = last.jobNum - first.jobNum
    return { text: `${signed(diff)} 段`, cls: diff > 0 ? 'up' : 'down' }
  }

  const diff = last.stars - first.stars
  if (!diff) return { text: '持平', cls: 'flat' }
  return { text: `${signed(diff)} 星`, cls: diff > 0 ? 'up' : 'down' }
}

/**
 * 升段 / 降段各发生了几次，以及涨星 / 掉星各几次。只看排位局：别的模式不改变段位。
 *
 * 王者段必须看涨星掉星：王者段的 band 恒 7、roleJob 编号恒 16（文件头第 2 点），
 * 段位全靠累积星数体现，只统计升降段的话王者玩家看到的永远是 0 / 0。
 */
function countSteps (points) {
  let up = 0
  let down = 0
  let starUp = 0
  let starDown = 0

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    // 跳变处不算：那是切角色或赛季重置，不是打上去的
    if (isRankJump(prev, cur)) continue

    if (cur.value > prev.value) starUp++
    else if (cur.value < prev.value) starDown++

    if (cur.band !== prev.band) {
      cur.band > prev.band ? up++ : down++
    } else if (cur.jobNum !== prev.jobNum) {
      cur.jobNum > prev.jobNum ? up++ : down++
    }
  }

  return { up, down, starUp, starDown }
}

/**
 * 最长连胜 / 连败。只传排位局进来——娱乐局的胜负和段位无关，混进来这个数字就没意义了。
 * 逃跑（gameresult 既不是 1 也不是 2）算断。
 */
function streaks (points) {
  let win = 0
  let lose = 0
  let curWin = 0
  let curLose = 0

  for (const p of points) {
    curWin = p.result === 1 ? curWin + 1 : 0
    curLose = p.result === 2 ? curLose + 1 : 0
    if (curWin > win) win = curWin
    if (curLose > lose) lose = curLose
  }

  return { win, lose }
}

/**
 * 把段位快照序列整理成模板数据。
 *
 * ## 为什么 y 轴用「离散刻度」而不是 rankPoint().value
 *
 * value 跨大段差 1e7，一张图里混了星耀和王者就被压成贴着上下边的两条直线，中间的
 * 升降星全看不见。段位本来就是阶梯量——「升一段」在体感上是等距的一格，不管是
 * 黄金升铂金还是星耀升王者。所以取区间内出现过的所有 value 去重升序，索引即 y 值，
 * 一格一档。代价是「从 5 星直接掉到 2 星」而 3、4 星没出现过时，图上只落一格；
 * 精确幅度看文案和逐日行，图只负责表达走向。
 *
 * @param {Array<object>} picked pickRankBattles 的返回（正序）
 * @param {object} [ctx]
 * @param {object} [ctx.heroMap] heroId → 英雄名（归档里只有 heroId）
 * @param {Function} [ctx.iconOf] heroId → 头像 URL，由调用方注入（同 scoreTrend，
 *   这个模块不碰网络和图源，脱机测时不用打桩）
 * @param {number} [ctx.days] 用户要看的天数，只用于文案
 * @param {boolean} [ctx.relaxed] 是否突破了天数窗口（pickRankWindow 的返回），只用于文案
 * @param {number} [ctx.recent] 「最近战况」列几场
 * @returns {object|null} 少于 2 场时返回 null（一个点画不出趋势）
 */
export function buildRankTrendView (picked = [], {
  heroMap = {},
  iconOf = () => '',
  days = RANK_TREND_DEFAULT_DAYS,
  relaxed = false,
  recent = 10
} = {}) {
  if (picked.length < 2) return null

  const all = picked.map(item => ({
    ...rankPoint(item),
    result: toInt(item.gameresult),
    kda: `${toInt(item.killcnt)}/${toInt(item.deadcnt)}/${toInt(item.assistcnt)}`
  }))
  // 进来的已经全是排位局（pickRankBattles 过滤过），留一道过滤是为了让「只有排位改变段位」
  // 这个前提在数据层写明：万一以后有人把别的模式喂进来，升降段统计不会跟着错
  const rankedOnly = all.filter(p => p.ranked)

  /**
   * 先给每一场标上「属于第几段折线」，跳变处开新段（文件头第 4 点）。
   * 抽稀之后再算段号是不行的：抽稀可能正好把跳变的那两场之一丢掉，跳变就凭空消失了。
   */
  let segIdx = 0
  all.forEach((p, i) => {
    if (i > 0 && isRankJump(all[i - 1], p)) segIdx += 1
    p.seg = segIdx
  })
  const segCount = segIdx + 1
  /**
   * 段位高低类的统计（区间变化 / 最高 / 最低）只看最后一段。
   * 跨角色比高低会得出荒谬结论——实测 1630945798 的编号 12 与 20 交替，
   * 直接拿首尾比会报「+8 段」，拿全区间取极值会出现「最高 2 星、最低 3 星」。
   * 场次、胜率、逐日这些「这个营地号打了多少」的统计仍然按全区间算。
   */
  const tail = all.filter(p => p.seg === segIdx)

  const first = all[0]
  const last = all[all.length - 1]
  const highest = tail.reduce((a, b) => (b.value > a.value ? b : a), tail[0])
  const lowest = tail.reduce((a, b) => (b.value < a.value ? b : a), tail[0])
  const delta = describeDelta(tail[0], last)
  const steps = countSteps(rankedOnly)

  // 折线点。抽稀后再建刻度表，刻度就只覆盖真的画出来的档位，不留空排
  const shown = thin(all)
  const levelValues = [...new Set(shown.map(p => p.value))].sort((a, b) => a - b)
  const levelOf = value => levelValues.indexOf(value)

  const trend = shown.map(p => ({
    level: levelOf(p.value),
    time: p.time,
    label: shortLabel(p),
    full: rankLabel(p),
    ranked: p.ranked,
    seg: p.seg
  }))

  // y 轴刻度：档位可能有十几档，全标会糊成一片，等距挑最多 5 档（首尾必留）
  const levels = thin(
    levelValues.map((value, index) => ({
      level: index,
      label: shortLabel(shown.find(p => p.value === value))
    })),
    5
  )

  // 逐日战况：一天一行。段位取当天最后一场的快照，变化和前一天的收盘比
  const byDay = new Map()
  for (const p of all) {
    const key = dayKey(p.time)
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key).push(p)
  }
  const dayList = [...byDay.entries()]
  const dayRows = dayList.map(([key, list], index) => {
    const dayEnd = list[list.length - 1]
    // 前一天的收盘快照。第一天没有前一天可比，就用当天第一场的快照当起点
    const base = index > 0 ? dayList[index - 1][1].slice(-1)[0] : list[0]
    // 跨了角色切换就别给数字了，「钻石 +8 段」这种结论比不给更糟
    const diff = isRankJump(base, dayEnd) ? { text: '—', cls: 'flat' } : describeDelta(base, dayEnd)
    const ranked = list.filter(p => p.ranked)
    return {
      date: key.slice(5).replace('-', '/'),
      count: list.length,
      rankedCount: ranked.length,
      win: ranked.filter(p => p.result === 1).length,
      lose: ranked.filter(p => p.result === 2).length,
      label: shortLabel(dayEnd),
      deltaText: diff.text,
      deltaClass: diff.cls
    }
  }).reverse()

  // 最近几场：倒序列出，变化是这一场自己造成的（和上一场的快照比）。
  // 段位快照是「打这局时的段位」而不是这局的结果（文件头第 1 点），所以严格说
  // 这里的差值是「上一场之后到这一场之前」的变化，对连续对局来说就是上一场的战果
  const recentRows = all.slice(-recent).map((p, i, arr) => {
    const idx = all.length - arr.length + i
    const prev = idx > 0 ? all[idx - 1] : null
    const diff = prev && !isRankJump(prev, p) ? describeDelta(prev, p) : { text: '—', cls: 'flat' }
    return {
      heroName: heroMap[p.heroId] || `英雄${p.heroId}`,
      heroIcon: iconOf(p.heroId),
      resultText: p.result === 1 ? '胜' : (p.result === 2 ? '负' : '—'),
      resultClass: p.result === 1 ? 'win' : (p.result === 2 ? 'lose' : 'flat'),
      kda: p.kda,
      mode: p.mode || '对局',
      ranked: p.ranked,
      label: shortLabel(p),
      deltaText: diff.text,
      deltaClass: diff.cls,
      timeText: `${mdText(p.time)} ${hmText(p.time)}`
    }
  }).reverse()

  // 模式分布：只取排位局之后这里剩的是「排位赛 单排 / 双排 / 五排」这类开黑形态，
  // 能看出是单排硬打上去的还是被人带的
  const byMode = new Map()
  for (const p of all) {
    const key = p.mode || '其它'
    if (!byMode.has(key)) byMode.set(key, { mode: key, count: 0, win: 0, ranked: p.ranked })
    const row = byMode.get(key)
    row.count += 1
    if (p.result === 1) row.win += 1
  }
  const modeRows = [...byMode.values()]
    .sort((a, b) => b.count - a.count)
    .map(row => ({
      ...row,
      winRate: row.count ? Math.round((row.win / row.count) * 100) : 0
    }))

  const rWin = rankedOnly.filter(p => p.result === 1).length
  const rLose = rankedOnly.filter(p => p.result === 2).length
  const played = rWin + rLose
  const winRate = played ? Math.round((rWin / played) * 1000) / 10 : 0
  const streak = streaks(rankedOnly)
  const spanDays = Math.max(1, Math.round((last.time - first.time) / 86400 * 10) / 10)

  return {
    count: all.length,
    rankedCount: rankedOnly.length,
    win: rWin,
    lose: rLose,
    winRate,
    winRateClass: winRate >= 50 ? 'good' : 'bad',
    startLabel: rankLabel(tail[0]),
    currentLabel: rankLabel(last),
    currentShort: shortLabel(last),
    peakLabel: rankLabel(highest),
    lowLabel: rankLabel(lowest),
    isKing: isKingBand(last.jobName),
    // 王者段的 stars 是跨子段累积的，直接把星数摆出来比段位名更有信息量
    starText: `${last.stars} 星`,
    deltaText: delta.text,
    deltaClass: delta.cls,
    upSteps: steps.up,
    downSteps: steps.down,
    starUpCount: steps.starUp,
    starDownCount: steps.starDown,
    // 王者段没有小段可升，升降段恒 0，展示时改用涨星掉星
    stepText: steps.up || steps.down ? `升 ${steps.up} / 降 ${steps.down} 段` : '未升降段',
    starStepText: `+${steps.starUp} / -${steps.starDown}`,
    maxWinStreak: streak.win,
    maxLoseStreak: streak.lose,
    spanDays,
    rangeText: `${mdText(first.time)} ~ ${mdText(last.time)}`,
    // 用户要 days 天，库里只有 spanDays 天，两个都说清楚（口径同 scoreTrend）。
    // 放宽过窗口时一律说实际覆盖：#段位趋势 2 拿到的 10 场可能横跨 4.8 天，
    // 这时写「近 2 天」会和旁边的日期区间自相矛盾
    coverText: !relaxed && spanDays >= days ? `近 ${days} 天` : `实际覆盖 ${spanDays} 天`,
    trend,
    levels,
    // 断点如实交代：这多半是同一个营地账号下切了游戏角色（文件头第 4 点），
    // 不说清楚用户会以为图画错了
    segCount,
    segNote: segCount > 1
      ? `检测到 ${segCount - 1} 处段位跳变，已断成 ${segCount} 段（多为切换游戏角色或赛季重置）；区间变化与最高最低只统计最后一段`
      : '',
    dayRows,
    recentRows,
    modeRows
  }
}
