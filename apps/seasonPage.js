import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ApiService, readYamlFile, Button, parsePerfArgs, seasonNo, AT_HEAD, stripAtText, resolveTargetUserId, shouldQuote } from '#utils'
import { PluginData, PluginPath } from '#components'
import { summarizeProfile } from '../utils/profileSummary.js'
import { getHeroNameMap } from '../utils/pushStore.js'
import { buildSeasonFallback, privacyScope } from '../utils/seasonFallback.js'

const BRANCH_NAME = { 1: '对抗路', 2: '中路', 3: '发育路', 4: '打野', 5: '游走' }
// 分路五维雷达颜色（与场次统计的分路配色对应）
const LANE_COLORS = { 1: '#f0932b', 2: '#6ab0f5', 3: '#57c98a', 4: '#c97bdb', 5: '#e0708a' }
// 五维雷达满分（万分制，与整体对战资料保持一致）
const RADAR_MAX = 12000
// 巅峰赛分路配色（与排位那套分路错开，一眼能分出是哪一半数据）
const MASTER_BRANCH_COLORS = { 0: '#f5d76e', 1: '#f0932b', 2: '#6ab0f5', 3: '#57c98a', 4: '#c97bdb', 5: '#e0708a' }

export class SeasonPage extends plugin {
  constructor() {
    super({
      name: '查询王者赛季表现',
      dsc: '赛季表现',
      event: 'message',
      priority: 1,
      rule: [
        { reg: `${AT_HEAD}#排位表现\\s*(.*)$`, fnc: 'rankPage' },
        // #赛季表现 是同一个赛季的完整表现：排位 + 巅峰一起出，不是两个赛季
        { reg: `${AT_HEAD}#赛季表现\\s*(.*)$`, fnc: 'seasonAll' }
      ]
    })
  }

  rankPage(e) {
    return this.seasonPage(e, '排位')
  }

  seasonAll(e) {
    return this.seasonPage(e, '赛季')
  }

  /**
   * @param {object} e
   * @param {'排位'|'赛季'} mode 排位=只出排位那半；赛季=同一赛季的排位 + 巅峰都出
   */
  async seasonPage(e, mode = '排位') {
    // 赛季模式在排位数据下面再挂一段巅峰赛，数据同在这次 seasonpage 响应里，不额外请求
    const withMaster = mode === '赛季'
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint)
    const userData = readYamlFile(path.join(PluginData, 'UserData.yaml')) || {}
    const input = stripAtText(e.msg).replace(new RegExp(`^#${mode}表现\\s*`), '').trim()
    const userInfo = userData[userId]
    const args = parsePerfArgs(input)
    // 不带 s 的小数字也当赛季号，#排位表现40 与 #排位表现s40 等价
    const wantSeason = args.season ?? args.count

    let campId = args.campId || userInfo?.ids?.[userInfo.current ?? 0]

    if (!campId) {
      await e.reply([
        segment.image(path.join(PluginPath, 'resources', 'img', '营地ID获取.png')),
        Button.bind()
      ], shouldQuote())
      return
    }

    let profileData
    try {
      profileData = await ApiService.getProfile(campId, String(userId))
    } catch (err) {
      await e.reply(ApiService.formatUserFacingError(err, { isMaster: Boolean(e.isMaster), scene: '赛季表现查询异常' }))
      return
    }

    const roleId = profileData?.data?.targetRoleId
    if (!roleId) {
      await e.reply('获取角色信息失败，请稍后再试')
      return
    }

    // 先用 seasonId=0 拿赛季列表（seasonId 不等于赛季号：46=S44、9=S7，只能按 seasonName 匹配）
    let firstRes
    try {
      firstRes = await ApiService.getSeasonpage(roleId, String(userId), 0)
    } catch (err) {
      await e.reply(ApiService.formatUserFacingError(err, { isMaster: Boolean(e.isMaster), scene: '赛季表现查询异常' }))
      return
    }

    const history = firstRes?.data?.historyList || []
    if (!history.length) {
      // 对方可能只是关了赛季表现的隐私开关（-30408/-10110），主页和战绩照旧能读，
      // 这时别回「暂无赛季数据」误导人，先用主页 + 最近一页排位战绩降级出图
      const scope = privacyScope(firstRes?.returnCode)
      const fallback = await this.buildFallbackView(campId, userId, profileData, scope)
      if (fallback) {
        const img = await puppeteer.screenshot('SeasonPage', {
          tplFile: 'plugins/GloryOfKings-Plugin/resources/html/SeasonPage.html',
          _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
          ...fallback,
          titleLabel: `${mode}表现`
        })
        // 降级时拿不到赛季列表，历史赛季按钮没有可跳的赛季号
        await e.reply([img, Button.performance(campId, mode, '')], shouldQuote())
        return
      }
      await e.reply(scope ? `对方隐藏了${scope}，赛季表现查不到` : '暂无赛季数据')
      return
    }

    const target = wantSeason
      ? history.find(h => seasonNo(h.seasonName) === wantSeason)
      : history[0]
    if (!target) {
      await e.reply(`未找到 S${wantSeason} 的赛季记录，可查询：${history.map(h => h.seasonName).join(' / ')}`)
      return
    }
    // 历史赛季只有段位/分路/英雄，没有五维（battleStats 为 null）和上分趋势（gameTrend 为空）
    const isCurrent = target.seasonId === history[0].seasonId

    let seasonRes
    try {
      seasonRes = await ApiService.getSeasonpage(roleId, String(userId), target.seasonId)
    } catch (err) {
      await e.reply(ApiService.formatUserFacingError(err, { isMaster: Boolean(e.isMaster), scene: '赛季表现查询异常' }))
      return
    }

    const data = seasonRes?.data
    if (!data) {
      await e.reply('获取赛季数据失败，请稍后再试')
      return
    }

    // 分路五维：seasonpage 不含分路五维，需对每条分路单独拉取 getFightData（排位赛 gameBattleType=3）。
    // 该接口只有近30天/近30场两种周期，无法按赛季取，所以只在当前赛季展示。
    const laneTypes = [1, 2, 3, 4, 5]
    let laneResults = []
    if (isCurrent) {
      try {
        laneResults = await Promise.all(
          laneTypes.map(bt => ApiService.getFightData(roleId, String(userId), { gameBattleType: 3, branchType: bt })
            .catch(() => null))
        )
      } catch {
        laneResults = []
      }
    }
    const lanes = laneResults
      .map((res, i) => this.buildLane(laneTypes[i], res?.data?.battleDataSelf))
      .filter(l => l && l.gameCnt > 0)

    const hc = data.headCard || {}
    const bs = data.battleStats || {}
    const ri = data.behavior?.rankInfo || {}
    // historyList 里该赛季的排位汇总（胜场/连胜/金银牌），历史赛季拿不到 battleStats 时用它兜底
    const ti = target.rankInfo || {}
    const BRANCH_COLORS = ['#f5d76e', '#f0932b', '#6ab0f5', '#57c98a', '#c97bdb']
    // 没打过的分路营地也会给一条 0 场，列出来只是「0场（0胜0负）胜率0%」的噪音，直接滤掉
    const branches = (ri.branches || []).filter(b => Number(b.gameCnt) > 0).map((b, i) => ({
      name: b.branchName || BRANCH_NAME[b.branchType] || b.branchType,
      winNum: b.winNum,
      loseNum: b.loseNum,
      winRate: b.winRate,
      gameCnt: b.gameCnt,
      color: BRANCH_COLORS[i % BRANCH_COLORS.length]
    }))
    const totalGames = branches.reduce((s, b) => s + b.gameCnt, 0)
    const totalWins = branches.reduce((s, b) => s + b.winNum, 0)
    const fallbackGameCnt = hc.gameCnt || totalGames
    const fallbackWinRate = hc.winRate
      ? Math.round(hc.winRate * 100) + '%'
      : (totalGames ? Math.round(totalWins / totalGames * 100) + '%' : '0%')

    const heros = (ri.heros || []).slice(0, 3).map(h => ({
      heroName: h.heroName,
      heroIcon: h.heroIcon,
      winRate: Math.round((h.winRate || 0) * 100) + '%',
      gameCnt: h.gameCnt
    }))

    // 雷达图五维 (万分制 → 百分制)
    const radarMax = 12000
    const radar = [
      { label: '输出', value: bs.hurtHero || 0 },
      { label: '生存', value: bs.survive || 0 },
      { label: '团战', value: bs.battle || 0 },
      { label: '发育', value: bs.grow || 0 },
      { label: 'KDA', value: bs.kda || 0 }
    ].map(r => ({ ...r, pct: Math.min(r.value / radarMax, 1) }))

    // 上分趋势
    // 单调星数 = totalRankStar（跨段累计，星耀IV=80…最强王者=100，每段+5，但到王者封顶100）
    //          + stars（当前段位内累计：星耀段0~5，王者段无小段则一路累加）。
    // 两者相加才是全局单调递增的真实星数，既能画出钻石→王者的跨段爬升，王者段内涨星也有起伏。
    const trend = (ri.gameTrend || []).slice().reverse().map(t => ({
      star: (Number(t.totalRankStar) || 0) + (Number(t.stars) || 0),
      stars: t.stars,
      jobName: t.jobName,
      jobColor: t.jobColor || '#f5d76e',
      time: t.time
    }))

    const honor = isCurrent
      ? [
          { val: bs.mvp || 0, key: '全场最佳' },
          { val: bs.loseMvp || 0, key: '败方最佳' },
          { val: bs.threeKill || 0, key: '三连决胜' },
          { val: bs.fourKill || 0, key: '四连超凡' },
          { val: bs.fiveKill || 0, key: '五连绝世' },
          { val: bs.godLike || 0, key: '超神' }
        ]
      // 历史赛季没有 battleStats，改用 historyList 里该赛季的排位汇总
      : [
          { val: Number(ti.totalWinCnt) || 0, key: '胜场' },
          { val: Math.max((Number(ti.totalCnt) || 0) - (Number(ti.totalWinCnt) || 0), 0), key: '负场' },
          { val: Number(ti.maxContinuousWinCnt) || 0, key: '最高连胜' },
          { val: Number(ti.goldCnt) || 0, key: '金牌' },
          { val: Number(ti.silverCnt) || 0, key: '银牌' }
        ]
    const hasHonor = honor.some(h => h.val > 0)
    const hasBattleStats = radar.some(r => r.value > 0)
    // 巅峰赛那半：#赛季表现 才拼，数据同在这份响应里（behavior.masterInfo + historyList 的 masterInfo）
    const master = withMaster ? this.buildMaster(data, target) : null

    const img = await puppeteer.screenshot('SeasonPage', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/SeasonPage.html',
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      titleLabel: `${mode}表现`,
      // 同一张图里排位和巅峰两段并存时，排位那几段的标题要带前缀，免得看不出是哪一半
      rankTag: withMaster ? '排位 · ' : '',
      hasMaster: !!master,
      masterStats: master?.stats || [],
      masterHeros: master?.heros || [],
      masterBranches: master?.branches || [],
      masterBranchesJson: JSON.stringify(master?.branches || []),
      masterTotalGames: master?.games || 0,
      roleName: hc.roleName,
      roleIcon: hc.roleIcon,
      serverName: hc.serverName,
      jobName: hc.jobName,
      jobLabel: isCurrent ? '当前段位' : '赛季最终段位',
      rankingStar: hc.rankingStar,
      masterScore: hc.masterScore,
      masterRank: hc.masterRank,
      score: hc.score,
      winRate: fallbackWinRate,
      gameCnt: fallbackGameCnt,
      branch: hc.branch,
      seasonName: target.seasonName || 'S44',
      subLabel: isCurrent ? '' : '历史赛季 · 无五维与上分趋势数据',
      heros,
      totalGames,
      honor,
      hasHonor,
      branchesJson: JSON.stringify(branches),
      // 无五维数据时连 canvas 都不渲染，脚本按空数组跳过绘制
      radarJson: JSON.stringify(hasBattleStats ? radar : []),
      trendJson: JSON.stringify(trend),
      hasBattleStats,
      branches,
      radar,
      trend,
      lanes,
      hasLanes: lanes.length > 0,
      lanesJson: JSON.stringify(lanes)
    })

    // 上一个赛季（history 是从新到旧），给按钮做历史赛季入口
    const prevSeason = seasonNo(history[history.indexOf(target) + 1]?.seasonName) || ''
    await e.reply([img, Button.performance(campId, mode, prevSeason)], shouldQuote())
  }

  /**
   * 同一赛季的巅峰赛那半数据。
   *
   * 两处来源要一起用：`behavior.masterInfo` 给这个赛季的巅峰常用英雄和分路场次（按 seasonId 请求就是该赛季的），
   * `historyList[i].masterInfo` 给巅峰分、总场次、胜场、连胜、金银牌、平均分。
   * 没打过巅峰赛的赛季（实测 S7）两边都是空，返回 null 让模板整段不渲染。
   */
  buildMaster(data, target) {
    const mi = data?.behavior?.masterInfo || {}
    const tmi = target?.masterInfo || {}
    const games = Number(tmi.totalCnt) || Number(mi.totalGameCnt) || 0
    if (!games) return null

    const wins = Number(tmi.totalWinCnt) || 0
    const loses = Math.max(games - wins, 0)
    const winRate = tmi.winRate
      ? `${Math.round(tmi.winRate * 100)}%`
      : (games ? `${Math.round((wins / games) * 100)}%` : '0%')

    const branches = (mi.branches || [])
      .filter(b => Number(b.gameCnt) > 0)
      .map(b => ({
        name: BRANCH_NAME[b.branchType] || String(b.branchType),
        color: MASTER_BRANCH_COLORS[b.branchType] || '#f5d76e',
        gameCnt: Number(b.gameCnt) || 0,
        winNum: Number(b.winNum) || 0,
        loseNum: Number(b.loseNum) || 0,
        winRate: b.winRate || '0%'
      }))
      .sort((a, b) => b.gameCnt - a.gameCnt)

    // S44 起对局评分改百分制，之前是 10 分制，跨赛季不可比，旧赛季的标一下口径
    const avgScore = Number(tmi.averageScore) || 0
    const scoreKey = avgScore > 0 && avgScore <= 20 ? '平均得分 · 旧10分制' : '平均得分'

    return {
      games,
      branches,
      stats: [
        // headCard.masterScore 才是该赛季展示用的巅峰分（historyList 里那个实测会更高，语义不明，只当兜底），
        // 与 #巅峰表现 同一口径，也避免同一张图里头部和这里两个数字打架
        { val: Number(data?.headCard?.masterScore) || Number(tmi.masterScore) || '—', key: '巅峰赛积分' },
        { val: games, key: '巅峰赛场次' },
        { val: winRate, key: `胜率（${wins}胜${loses}负）` },
        { val: avgScore || '—', key: scoreKey },
        { val: Number(tmi.maxContinuousWinCnt) || 0, key: '最高连胜' },
        { val: `${Number(tmi.goldCnt) || 0} / ${Number(tmi.silverCnt) || 0}`, key: '金牌 / 银牌' }
      ],
      heros: (mi.heros || []).slice(0, 3).map(h => ({
        heroName: h.heroName,
        heroIcon: h.heroIcon,
        winRate: `${Math.round((h.winRate || 0) * 100)}%`,
        gameCnt: h.gameCnt
      }))
    }
  }

  /**
   * 赛季数据取不到时的降级视图：主页摘要 + 最近一页排位战绩。
   * 战绩列表也读不到（或一场排位都没有）时返回 null，交给调用方回文案。
   */
  async buildFallbackView(campId, userId, profileData, scope) {
    const summary = summarizeProfile(profileData?.data)
    if (!summary) return null

    let battles = []
    try {
      const res = await ApiService.getMoreBattleList(campId, String(userId), { option: 0, lastTime: 0 })
      battles = res?.data?.list || []
    } catch (err) {
      logger.debug(`[王者赛季表现] 降级读战绩失败：${err.message}`)
      return null
    }
    // 英雄名要靠官网总表翻译，拉不到只是显示成「英雄151」，不该拦住出图
    const heroMap = await getHeroNameMap()
    return buildSeasonFallback({ summary, battles, heroMap, scope })
  }

  /** 把单条分路的 battleDataSelf 整理成模板需要的五维结构 */
  buildLane(type, self) {
    if (!self) return null
    const winNum = Number(self.winNum) || 0
    const loseNum = Number(self.loseNum) || 0
    const gameCnt = winNum + loseNum

    const winRate = typeof self.winRate === 'string' && self.winRate.trim()
      ? self.winRate.trim()
      : (gameCnt ? Math.round((winNum / gameCnt) * 100) + '%' : '0%')

    // 五维（万分制）→ 归一化占比，供雷达绘制，顺序与整体对战资料一致
    const radar = [
      { label: '输出', value: Number(self.hurtHero) || 0 },
      { label: '生存', value: Number(self.survive) || 0 },
      { label: '团战', value: Number(self.battle) || 0 },
      { label: '发育', value: Number(self.grow) || 0 },
      { label: 'KDA', value: Number(self.kda) || 0 }
    ].map(r => ({ ...r, pct: Math.min(r.value / RADAR_MAX, 1) }))

    return {
      type,
      name: BRANCH_NAME[type] || String(type),
      color: LANE_COLORS[type] || '#f5d76e',
      gameCnt,
      winRate,
      avgScore: Number(self.avgScore) || 0,
      radar
    }
  }
}
