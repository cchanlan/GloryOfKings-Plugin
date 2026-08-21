import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ApiService, readYamlFile, Button, parsePerfArgs, seasonNo, AT_HEAD, stripAtText, resolveTargetUserId, shouldQuote } from '#utils'
import { PluginData, PluginPath } from '#components'

// branchType：0=全部分路 1=对抗路 2=中路 3=发育路 4=打野 5=游走
const BRANCH_NAME = { 0: '全部', 1: '对抗路', 2: '中路', 3: '发育路', 4: '打野', 5: '游走' }
const BRANCH_COLORS = {
  0: '#f5d76e', 1: '#f0932b', 2: '#6ab0f5', 3: '#57c98a', 4: '#c97bdb', 5: '#e0708a'
}

// 五维雷达满分（万分制，与赛季表现保持一致）
const RADAR_MAX = 12000

export class PeakPerformance extends plugin {
  constructor() {
    super({
      name: '查询王者巅峰表现',
      dsc: '巅峰赛五维全分路数据',
      event: 'message',
      priority: 1,
      rule: [{ reg: `${AT_HEAD}#巅峰表现\\s*(.*)$`, fnc: 'peakPerformance' }]
    })
  }

  async peakPerformance(e) {
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint)
    const userData = readYamlFile(path.join(PluginData, 'UserData.yaml')) || {}
    const input = stripAtText(e.msg).replace(/^#巅峰表现\s*/, '').trim()
    const userInfo = userData[userId]
    const args = parsePerfArgs(input)
    // 不带 s 的小数字也当赛季号，#巅峰表现40 与 #巅峰表现s40 等价
    const wantSeason = args.season ?? args.count

    const campId = args.campId || userInfo?.ids?.[userInfo.current ?? 0]

    if (!campId) {
      await e.reply([
        segment.image(path.join(PluginPath, 'resources', 'img', '营地ID获取.png')),
        Button.bind()
      ], shouldQuote())
      return
    }

    // 头部信息：昵称、头像、区服
    let profileData
    try {
      profileData = await ApiService.getProfile(campId, String(userId))
    } catch (err) {
      await e.reply(ApiService.formatUserFacingError(err, { isMaster: Boolean(e.isMaster), scene: '巅峰表现查询异常' }))
      return
    }

    const roleId = profileData?.data?.targetRoleId
    if (!roleId) {
      await e.reply('获取角色信息失败，请稍后再试')
      return
    }

    const roleData = (profileData.data.roleList || []).find(r => r.roleId === roleId) || {}
    const roleName = roleData.roleName || '召唤师'
    const roleIcon = roleData.roleIcon || ''
    const serverName = roleData.roleText || roleData.areaName || '王者荣耀'
    const who = { roleId, userId, campId, roleName, roleIcon, serverName }

    // 指定赛季走赛季汇总（getFightData 只有近30天/近30场，取不到历史赛季）
    if (wantSeason) return this.renderSeason(e, who, wantSeason)

    // 全部分路 + 5 条分路 + 赛季页（巅峰英雄/上分趋势），一次性并发拉取
    const branchTypes = [0, 1, 2, 3, 4, 5]
    let results
    let seasonData = null
    let history = []
    try {
      const [fightResults, sData] = await Promise.all([
        Promise.all(
          branchTypes.map(bt => ApiService.getFightData(roleId, String(userId), { gameBattleType: 10, branchType: bt }))
        ),
        (async () => {
          try {
            const first = await ApiService.getSeasonpage(roleId, String(userId), 0)
            const list = first?.data?.historyList || []
            const sid = list[0]?.seasonId
            if (!sid) return null
            return { res: await ApiService.getSeasonpage(roleId, String(userId), sid), list }
          } catch { return null }
        })()
      ])
      results = fightResults
      seasonData = sData?.res?.data || null
      history = sData?.list || []
    } catch (err) {
      await e.reply(ApiService.formatUserFacingError(err, { isMaster: Boolean(e.isMaster), scene: '巅峰表现查询异常' }))
      return
    }

    // 上分趋势：seasonpage 只返回一条 gameTrend，其 score 字段即巅峰分（=headCard.masterScore）。
    // 排位星数 totalRankStar 对巅峰玩家恒为满值，不能用来画趋势。
    const ri = seasonData?.behavior?.rankInfo || {}
    const trend = (ri.gameTrend || []).slice().reverse().map(t => ({
      score: Number(t.score) || 0,
      jobName: t.jobName || '',
      jobColor: t.jobColor || '#f5d76e',
      time: t.time
    }))

    // 常用英雄：巅峰赛英雄在 behavior.masterInfo.heros，rankInfo.heros 是排位英雄，勿混用。
    const mi = seasonData?.behavior?.masterInfo || {}
    const heros = (mi.heros || []).slice(0, 3).map(h => ({
      heroName: h.heroName,
      heroIcon: h.heroIcon,
      winRate: Math.round((h.winRate || 0) * 100) + '%',
      gameCnt: h.gameCnt
    }))

    const branchList = results
      .map((res, i) => this.buildBranch(branchTypes[i], res?.data?.battleDataSelf))
      .filter(Boolean)

    const overall = branchList.find(b => b.type === 0)
    const lanes = branchList.filter(b => b.type !== 0 && b.gameCnt > 0)

    if (!overall || overall.gameCnt === 0) {
      await e.reply('暂无巅峰赛数据，可能是近30天未参与巅峰赛或对方隐藏了战绩')
      return
    }

    const honor = [
      { val: overall.raw.mvp || 0, key: '全场最佳' },
      { val: overall.raw.loseMvp || 0, key: '败方最佳' },
      { val: overall.raw.threeKill || 0, key: '三连决胜' },
      { val: overall.raw.fourKill || 0, key: '四连超凡' },
      { val: overall.raw.fiveKill || 0, key: '五连绝世' },
      { val: overall.raw.godLike || 0, key: '超神' },
      { val: overall.raw.goldMedal || 0, key: '金牌' },
      { val: overall.raw.sliverMedal || 0, key: '银牌' }
    ]
    const hasHonor = honor.some(h => h.val > 0)

    const branches = lanes.map(l => ({
      name: l.name,
      color: l.color,
      gameCnt: l.gameCnt,
      winNum: Number(l.raw.winNum) || 0,
      loseNum: Number(l.raw.loseNum) || 0,
      winRate: l.winRate
    }))

    const branch = lanes.length > 0
      ? lanes.reduce((a, b) => a.gameCnt >= b.gameCnt ? a : b).name
      : '—'

    const img = await puppeteer.screenshot('PeakPerformance', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/PeakPerformance.html',
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      roleName,
      roleIcon,
      serverName,
      seasonLabel: '巅峰表现 · 近30天',
      subLabel: '',
      stats: [
        { val: overall.gameCnt, key: '巅峰赛场次' },
        { val: overall.winRate, key: `胜率（${overall.raw.winNum || 0}胜${overall.raw.loseNum || 0}负）` },
        { val: overall.avgScore, key: '平均得分' }
      ],
      gameCnt: overall.gameCnt,
      winRate: overall.winRate,
      winNum: overall.raw.winNum || 0,
      loseNum: overall.raw.loseNum || 0,
      avgScore: overall.avgScore,
      branch,
      honor,
      hasHonor,
      branches,
      hasBranches: branches.length > 0,
      branchesJson: JSON.stringify(branches),
      lanes,
      hasLanes: lanes.length > 0,
      hasOverallRadar: true,
      overallJson: JSON.stringify(overall),
      lanesJson: JSON.stringify(lanes),
      trend,
      trendJson: JSON.stringify(trend),
      heros
    })

    // 近30天口径下把上一赛季（history[1]）作为历史赛季入口
    await e.reply([img, Button.performance(campId, '巅峰', seasonNo(history[1]?.seasonName) || '')], shouldQuote())
  }

  /**
   * 指定赛季的巅峰表现。
   * 数据源是 seasonpage：headCard.masterScore 是该赛季巅峰分，behavior.masterInfo 给分路场次和常用英雄，
   * historyList 里对应赛季的 masterInfo 给胜场/连胜/金银牌/评分。五维雷达只有近30天口径，赛季模式不展示。
   */
  async renderSeason(e, who, wantSeason) {
    const { roleId, userId, campId, roleName, roleIcon, serverName } = who
    const scene = '巅峰表现查询异常'

    let firstRes
    try {
      firstRes = await ApiService.getSeasonpage(roleId, String(userId), 0)
    } catch (err) {
      await e.reply(ApiService.formatUserFacingError(err, { isMaster: Boolean(e.isMaster), scene }))
      return
    }

    const history = firstRes?.data?.historyList || []
    if (!history.length) {
      await e.reply('暂无赛季数据')
      return
    }

    const target = history.find(h => seasonNo(h.seasonName) === wantSeason)
    if (!target) {
      await e.reply(`未找到 S${wantSeason} 的赛季记录，可查询：${history.map(h => h.seasonName).join(' / ')}`)
      return
    }

    let seasonRes
    try {
      seasonRes = await ApiService.getSeasonpage(roleId, String(userId), target.seasonId)
    } catch (err) {
      await e.reply(ApiService.formatUserFacingError(err, { isMaster: Boolean(e.isMaster), scene }))
      return
    }

    const data = seasonRes?.data || {}
    const hc = data.headCard || {}
    const mi = data.behavior?.masterInfo || {}
    const ti = target.masterInfo || {}

    const games = Number(ti.totalCnt) || Number(mi.totalGameCnt) || 0
    if (!games) {
      await e.reply(`${target.seasonName} 暂无巅峰赛数据，可能是该赛季未参与巅峰赛或对方隐藏了战绩`)
      return
    }

    const wins = Number(ti.totalWinCnt) || 0
    const winRate = ti.winRate
      ? Math.round(ti.winRate * 100) + '%'
      : (games ? Math.round(wins / games * 100) + '%' : '0%')

    const branches = (mi.branches || [])
      .filter(b => Number(b.gameCnt) > 0)
      .map(b => ({
        name: BRANCH_NAME[b.branchType] || String(b.branchType),
        color: BRANCH_COLORS[b.branchType] || '#f5d76e',
        gameCnt: Number(b.gameCnt) || 0,
        winNum: Number(b.winNum) || 0,
        loseNum: Number(b.loseNum) || 0,
        winRate: b.winRate || '0%'
      }))
    const branch = branches.length
      ? branches.reduce((a, b) => a.gameCnt >= b.gameCnt ? a : b).name
      : '—'

    const heros = (mi.heros || []).slice(0, 3).map(h => ({
      heroName: h.heroName,
      heroIcon: h.heroIcon,
      winRate: Math.round((h.winRate || 0) * 100) + '%',
      gameCnt: h.gameCnt
    }))

    // S44 起对局评分改百分制，之前是 10 分制，跨赛季不可比，旧赛季标一下口径
    const avgScore = Number(ti.averageScore) || 0
    const scoreKey = avgScore > 0 && avgScore <= 20 ? '平均得分 · 旧10分制' : '平均得分'

    const honor = [
      { val: wins, key: '胜场' },
      { val: Math.max(games - wins, 0), key: '负场' },
      { val: Number(ti.goldCnt) || 0, key: '金牌' },
      { val: Number(ti.silverCnt) || 0, key: '银牌' }
    ]

    const img = await puppeteer.screenshot('PeakPerformance', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/PeakPerformance.html',
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      roleName,
      roleIcon,
      serverName,
      seasonLabel: `${target.seasonName} 巅峰表现`,
      subLabel: '按赛季统计 · 无五维数据',
      stats: [
        { val: hc.masterScore || Number(ti.masterScore) || '—', key: '巅峰赛积分' },
        { val: games, key: '巅峰赛场次' },
        { val: winRate, key: `胜率（${wins}胜${Math.max(games - wins, 0)}负）` },
        { val: avgScore || '—', key: scoreKey },
        { val: Number(ti.maxContinuousWinCnt) || 0, key: '最高连胜' },
        { val: branch, key: '分路偏好' }
      ],
      gameCnt: games,
      winRate,
      winNum: wins,
      loseNum: Math.max(games - wins, 0),
      avgScore: avgScore || '—',
      branch,
      honor,
      hasHonor: honor.some(h => h.val > 0),
      branches,
      hasBranches: branches.length > 0,
      branchesJson: JSON.stringify(branches),
      lanes: [],
      hasLanes: false,
      hasOverallRadar: false,
      overallJson: 'null',
      lanesJson: '[]',
      trend: [],
      trendJson: '[]',
      heros
    })

    const prevSeason = seasonNo(history[history.indexOf(target) + 1]?.seasonName) || ''
    await e.reply([img, Button.performance(campId, '巅峰', prevSeason)], shouldQuote())
  }

  /** 把单条分路的 battleDataSelf 整理成模板需要的结构 */
  buildBranch(type, self) {
    if (!self) return null
    const winNum = Number(self.winNum) || 0
    const loseNum = Number(self.loseNum) || 0
    const gameCnt = winNum + loseNum

    let winRate = typeof self.winRate === 'string' && self.winRate.trim()
      ? self.winRate.trim()
      : (gameCnt ? Math.round((winNum / gameCnt) * 100) + '%' : '0%')

    // 五维（万分制）→ 归一化占比，供雷达绘制
    const radar = [
      { label: '输出', value: Number(self.hurtHero) || 0 },
      { label: 'KDA', value: Number(self.kda) || 0 },
      { label: '发育', value: Number(self.grow) || 0 },
      { label: '团战', value: Number(self.battle) || 0 },
      { label: '生存', value: Number(self.survive) || 0 }
    ].map(r => ({ ...r, pct: Math.min(r.value / RADAR_MAX, 1) }))

    return {
      type,
      name: BRANCH_NAME[type] || String(type),
      color: BRANCH_COLORS[type] || '#f5d76e',
      gameCnt,
      winRate,
      avgScore: Number(self.avgScore) || 0,
      radar,
      raw: self
    }
  }
}
