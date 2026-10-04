/**
 * 「排位表现」拿不到赛季数据时的降级取数。
 *
 * 营地的赛季表现有独立的隐私开关，关掉之后：
 *   · /game/seasonpage    → -30408（返回文案写的是「召唤师隐藏了个人战绩」）
 *   · /game/getfightdata  → -10110「召唤师隐藏了赛季表现」
 * 但同一个号的主页和战绩列表照旧能读——实测 roleId 120016331（营地 52334903）：
 * seasonpage/getfightdata 被拒，而 /game/koh/profile 与战绩列表都 returnCode=0，
 * 列表里 30 场全是排位赛，带 gameresult / heroId / mvpcnt / losemvp / gradeGame。
 * 所以「暂无赛季数据」这句是误报，用主页摘要 + 最近一页战绩能拼出一张能看的降级卡。
 *
 * 拿不到的三块（分路场次、五维雷达、上分趋势）整块不渲染，不硬凑：
 *   · 分路只存在于单场详情里（列表项的 branchEvaluate 只是金/银评价档位），
 *     30 场就要 30 次详情请求，稳撞 -30107 频控；
 *   · 五维只有 seasonpage/getfightdata 给，正好都是被隐藏的那两个接口；
 *   · 段位趋势要 totalRankStar 才能跨段可比，列表项只有段内 stars（且 roleJob 语义分新旧体系）。
 */

import { resolveMode, rankHeroes, heroIconUrl } from './reportStore.js'

/**
 * 隐私类业务错误码 → 对方关掉的是哪个开关。
 * -30408 营地给的文案是「隐藏了个人战绩」，但同一个号的战绩列表照旧能读（实测 invisible=false），
 * 关掉的其实是赛季表现那个开关，所以按端点语义翻译，不照抄营地文案免得把人往「战绩也看不了」带。
 */
const PRIVACY_SCOPES = {
  '-30408': '赛季表现',
  '-10110': '赛季表现',
  '-10107': '主页'
}

const toInt = value => {
  const num = Number(value)
  return Number.isFinite(num) ? Math.trunc(num) : 0
}

/** 是不是「对方设了隐私」而不是「接口坏了」 */
export function privacyScope (returnCode) {
  return PRIVACY_SCOPES[String(toInt(returnCode))] || ''
}

/** 最长连胜（列表是从新到旧，只数长度不看方向） */
function maxWinStreak (battles) {
  let best = 0
  let run = 0
  for (const item of battles) {
    if (toInt(item.gameresult) === 1) run += 1
    else run = 0
    if (run > best) best = run
  }
  return best
}

/**
 * 用主页摘要 + 最近一页战绩拼降级视图，字段与 SeasonPage.html 主路径同构。
 *
 * @param {object} params
 * @param {object} params.summary summarizeProfile 的结果
 * @param {Array<object>} params.battles 战绩列表（getMoreBattleList 的 data.list）
 * @param {Record<string,string>} [params.heroMap] heroId → 英雄名
 * @param {string} [params.scope] 对方隐藏的是哪一项，写进副标题
 * @returns {object|null} 一场排位都没有时返回 null（这时确实无从降级）
 */
export function buildSeasonFallback ({ summary, battles = [], heroMap = {}, scope = '' }) {
  const ranked = battles.filter(item => resolveMode(item.mapName) === '排位赛')
  if (!ranked.length) return null

  const win = ranked.filter(item => toInt(item.gameresult) === 1).length
  const lose = ranked.filter(item => toInt(item.gameresult) === 2).length
  const decided = win + lose
  const graded = ranked.filter(item => Number(item.gradeGame) > 0)
  const avgGrade = graded.length
    ? (graded.reduce((sum, item) => sum + Number(item.gradeGame), 0) / graded.length).toFixed(1)
    : 0

  const heros = rankHeroes(ranked, heroMap).slice(0, 3).map(hero => ({
    heroName: hero.name,
    heroIcon: heroIconUrl(hero.heroId),
    winRate: `${hero.winRate}%`,
    gameCnt: hero.count
  }))

  const honor = [
    { val: win, key: '胜场' },
    { val: lose, key: '负场' },
    { val: maxWinStreak(ranked), key: '最高连胜' },
    { val: ranked.reduce((sum, item) => sum + toInt(item.mvpcnt), 0), key: '全场最佳' },
    { val: ranked.reduce((sum, item) => sum + toInt(item.losemvp), 0), key: '败方最佳' },
    { val: avgGrade, key: '场均评分' }
  ]

  return {
    roleName: summary?.roleName || '',
    roleIcon: summary?.roleIcon || '',
    serverName: summary?.areaName || '',
    jobName: summary?.rank?.name || '未定级',
    rankingStar: summary?.rank?.star || 0,
    jobLabel: '当前段位',
    // 巅峰分 0 是「这赛季没打巅峰赛」，交给模板的 `|| '—'` 显示成无数据
    masterScore: summary?.peak || 0,
    masterRank: '',
    score: '',
    winRate: decided ? `${Math.round((win / decided) * 100)}%` : '0%',
    gameCnt: ranked.length,
    branch: '—',
    seasonName: '近期',
    subLabel: `${scope ? `对方隐藏了${scope}` : '赛季数据取不到'} · 改用主页与最近 ${ranked.length} 场排位`,
    heros,
    honor,
    hasHonor: true,
    // 分路 / 五维 / 上分趋势这三块降级拿不到，全部留空让模板整块跳过
    totalGames: ranked.length,
    branches: [],
    branchesJson: '[]',
    radar: [],
    radarJson: '[]',
    trend: [],
    trendJson: '[]',
    hasBattleStats: false,
    lanes: [],
    hasLanes: false,
    lanesJson: '[]'
  }
}
