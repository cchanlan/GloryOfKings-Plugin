import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ApiService, readYamlFile, Button, parsePerfArgs, AT_HEAD, stripAtText, resolveTargetUserId } from '#utils'
import { PluginData, PluginPath } from '#components'

// 默认一屏放几个赛季总结。营地那边是全部赛季无限滚动，这里默认按 3 个赛季控制图片长度，
// 指令后可跟数量（#全部排位表现5）或 all（#全部排位表现all）覆盖
const SEASON_LIMIT = 3
const SEASON_LIMIT_MAX = 30

// 段位配色。roleJob 是段位 ID 不是等级（17=荣耀黄金IV 却比 16=最强王者 大），只能按段位名判断
const JOB_COLORS = [
  [/王者/, '#f5d76e'],
  [/星耀/, '#c97bdb'],
  [/钻石/, '#6ab0f5'],
  [/铂金|白金/, '#57c98a'],
  [/黄金/, '#f0932b'],
  [/白银/, '#c3cddd'],
  [/青铜/, '#b07d5a']
]

export class AllSeasonPerformance extends plugin {
  constructor() {
    super({
      name: '查询王者全部赛季表现',
      dsc: '全部赛季的排位/巅峰历史数据',
      event: 'message',
      priority: 1,
      rule: [
        { reg: `${AT_HEAD}#全部排位表现\\s*(.*)$`, fnc: 'allRank' },
        { reg: `${AT_HEAD}#全部巅峰表现\\s*(.*)$`, fnc: 'allPeak' }
      ]
    })
  }

  allRank(e) {
    return this.render(e, '排位')
  }

  allPeak(e) {
    return this.render(e, '巅峰')
  }

  async render(e, mode) {
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint)
    const userData = readYamlFile(path.join(PluginData, 'UserData.yaml')) || {}
    const input = stripAtText(e.msg).replace(new RegExp(`^#全部${mode}表现\\s*`), '').trim()
    const userInfo = userData[userId]
    const args = parsePerfArgs(input)

    const campId = args.campId || userInfo?.ids?.[userInfo.current ?? 0]

    if (!campId) {
      await e.reply([
        segment.image(path.join(PluginPath, 'resources', 'img', '营地ID获取.png')),
        Button.bind()
      ], true)
      return
    }

    const scene = `全部${mode}表现查询异常`
    let profileData
    try {
      profileData = await ApiService.getProfile(campId, String(userId))
    } catch (err) {
      await e.reply(ApiService.formatUserFacingError(err, { isMaster: Boolean(e.isMaster), scene }))
      return
    }

    const roleId = profileData?.data?.targetRoleId
    if (!roleId) {
      await e.reply('获取角色信息失败，请稍后再试')
      return
    }

    // seasonId=0 时 headCard 是「全赛季」汇总（最高段位、最高巅峰分、王者印记数、总场次/胜率/分路偏好），
    // historyList 则带齐每个赛季的 rankInfo（排位）与 masterInfo（巅峰），一次请求就够，不用逐赛季拉。
    let res
    try {
      res = await ApiService.getSeasonpage(roleId, String(userId), 0)
    } catch (err) {
      await e.reply(ApiService.formatUserFacingError(err, { isMaster: Boolean(e.isMaster), scene }))
      return
    }

    const data = res?.data
    const history = data?.historyList
    if (!data || !history?.length) {
      await e.reply('暂无赛季数据')
      return
    }

    const currentSeasonId = history[0].seasonId
    const all = history.map(s => this.buildSeason(s, mode, currentSeasonId)).filter(Boolean)
    const played = all.filter(s => s.games > 0)

    if (!played.length) {
      await e.reply(mode === '巅峰' ? '暂无巅峰赛数据，可能是从未参与巅峰赛或对方隐藏了战绩' : '暂无排位赛数据')
      return
    }

    // all 取全部，数字取最近 N 个（上限 30，防止图片过长），都没写按默认 3 个
    const limit = args.all
      ? played.length
      : Math.min(Math.max(args.count || SEASON_LIMIT, 1), SEASON_LIMIT_MAX)
    const seasons = played.slice(0, limit)
    // 趋势图用全部有数据的赛季（从旧到新），只有总结卡片受 SEASON_LIMIT 限制
    const trend = played.slice().reverse().map(s => ({
      label: s.seasonName,
      value: mode === '巅峰' ? s.masterScore : s.star,
      tip: mode === '巅峰' ? String(s.masterScore) : `${s.shortJobName} ${s.rankingStar}星`
    }))

    const hc = data.headCard || {}
    const img = await puppeteer.screenshot('AllSeasonPerformance', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/AllSeasonPerformance.html',
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      mode,
      modeLabel: mode === '巅峰' ? '巅峰赛' : '排位赛',
      isPeak: mode === '巅峰',
      roleName: hc.roleName || '召唤师',
      roleIcon: hc.roleIcon || '',
      serverName: hc.serverName || hc.areaName || '王者荣耀',
      topJob: hc.jobName ? `${hc.jobName}${hc.rankingStar ? ` ${hc.rankingStar}星` : ''}` : '—',
      topMasterScore: hc.masterScore || '—',
      wangzheCnt: hc.wangzheCnt || 0,
      totalGameCnt: hc.gameCnt || 0,
      totalWinRate: hc.winRate ? `${(hc.winRate * 100).toFixed(1)}%` : '—',
      branch: hc.branch || '—',
      seasonCnt: played.length,
      shownCnt: seasons.length,
      rangeText: seasons.length >= played.length
        ? `共 ${played.length} 个赛季有记录，已全部展示`
        : `共 ${played.length} 个赛季有记录，展示最近 ${seasons.length} 个`,
      seasons,
      trend,
      trendJson: JSON.stringify(trend)
    })

    await e.reply([img, Button.allPerformance(campId, mode)], true)
  }

  /** 把 historyList 里的一个赛季整理成模板需要的结构，无对应模式数据时返回 null */
  buildSeason(season, mode, currentSeasonId) {
    const info = mode === '巅峰' ? season.masterInfo : season.rankInfo
    if (!info) return null

    const games = Number(info.totalCnt) || 0
    const wins = Number(info.totalWinCnt) || 0
    const winRate = info.winRate
      ? `${Math.round(info.winRate * 100)}%`
      : (games ? `${Math.round((wins / games) * 100)}%` : '0%')

    return {
      seasonId: season.seasonId,
      seasonName: season.seasonName,
      isCurrent: season.seasonId === currentSeasonId,
      dateRange: `${this.fmtMonth(season.startTime)} - ${this.fmtMonth(season.endTime)}`,
      games,
      wins,
      winRate,
      streak: Number(info.maxContinuousWinCnt) || 0,
      gold: Number(info.goldCnt) || 0,
      silver: Number(info.silverCnt) || 0,
      avgScore: Number(info.averageScore) || 0,
      // S44 起对局评分换成百分制，之前是 10 分制（接口原样返回，营地 App 也是这个值），跨赛季不可比，给旧赛季标一下口径
      scoreLabel: (Number(info.averageScore) || 0) > 0 && Number(info.averageScore) <= 20
        ? '平均分数 · 旧10分制'
        : '平均分数',
      // 排位看段位，巅峰看积分
      jobName: info.jobName || '',
      shortJobName: info.shortJobName || info.jobName || '',
      rankingStar: Number(info.rankingStar) || 0,
      jobColor: this.jobColor(info.jobName),
      masterScore: Number(info.masterScore) || 0,
      // 排位段位跨段累计星数：totalRankStar 是段位基准，rankingStar 是段内星数，相加才全局单调
      star: (Number(info.totalRankStar) || 0) + (Number(info.rankingStar) || 0),
      heros: (info.heros || []).slice(0, 5).map(h => ({
        heroName: h.heroName,
        heroIcon: h.heroIcon,
        gameCnt: Number(h.gameCnt) || 0,
        winCnt: Number(h.winCnt) || 0,
        winRate: `${Math.round((Number(h.winRate) || 0) * 100)}%`
      }))
    }
  }

  fmtMonth(ts) {
    const d = new Date(Number(ts) * 1000)
    return Number.isNaN(d.getTime()) ? '—' : `${d.getFullYear()}.${d.getMonth() + 1}`
  }

  jobColor(jobName) {
    return (JOB_COLORS.find(([re]) => re.test(jobName || '')) || [, '#9aa7bd'])[1]
  }
}
