import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ApiService, readYamlFile } from '#utils'
import { PluginData } from '#components'

const BRANCH_NAME = { 1: '对抗路', 2: '中路', 3: '发育路', 4: '打野', 5: '游走' }

export class SeasonPage extends plugin {
  constructor() {
    super({
      name: '查询王者赛季表现',
      dsc: '赛季表现',
      event: 'message',
      priority: 1,
      rule: [{ reg: '^#赛季表现\\s*(.*)$', fnc: 'seasonPage' }]
    })
  }

  async seasonPage(e) {
    const userId = (e.at && !e.atme) ? e.at : e.user_id
    const userData = readYamlFile(path.join(PluginData, 'UserData.yaml'))
    const input = e.msg.replace(/^#赛季表现\s*/, '').trim()
    const userInfo = userData[userId]

    let campId = input && /^\d+$/.test(input) ? input
      : userInfo?.ids?.[userInfo.current ?? 0]

    if (!campId) {
      await e.reply(segment.image('https://raw.gitcode.com/Kevin1217/resources/files/master/resources/img/example/王者营地ID获取.png'))
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

    // 先用 seasonId=0 拿当前赛季 ID
    let firstRes
    try {
      firstRes = await ApiService.getSeasonpage(roleId, String(userId), 0)
    } catch (err) {
      await e.reply(ApiService.formatUserFacingError(err, { isMaster: Boolean(e.isMaster), scene: '赛季表现查询异常' }))
      return
    }

    const currentSeasonId = firstRes?.data?.historyList?.[0]?.seasonId
    if (!currentSeasonId) {
      await e.reply('暂无赛季数据')
      return
    }

    let seasonRes
    try {
      seasonRes = await ApiService.getSeasonpage(roleId, String(userId), currentSeasonId)
    } catch (err) {
      await e.reply(ApiService.formatUserFacingError(err, { isMaster: Boolean(e.isMaster), scene: '赛季表现查询异常' }))
      return
    }

    const data = seasonRes?.data
    if (!data) {
      await e.reply('获取赛季数据失败，请稍后再试')
      return
    }

    const hc = data.headCard || {}
    const bs = data.battleStats || {}
    const ri = data.behavior?.rankInfo || {}
    const BRANCH_COLORS = ['#f5d76e', '#f0932b', '#6ab0f5', '#57c98a', '#c97bdb']
    const branches = (ri.branches || []).map((b, i) => ({
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
    const trend = (ri.gameTrend || []).slice().reverse().map(t => ({
      star: t.totalRankStar,
      jobName: t.jobName,
      jobColor: t.jobColor || '#f5d76e',
      time: t.time
    }))

    const honor = {
      mvp: bs.mvp || 0,
      loseMvp: bs.loseMvp || 0,
      threeKill: bs.threeKill || 0,
      fourKill: bs.fourKill || 0,
      fiveKill: bs.fiveKill || 0,
      godLike: bs.godLike || 0
    }
    const hasHonor = Object.values(honor).some(v => v > 0)

    const img = await puppeteer.screenshot('SeasonPage', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/SeasonPage.html',
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      roleName: hc.roleName,
      roleIcon: hc.roleIcon,
      serverName: hc.serverName,
      jobName: hc.jobName,
      rankingStar: hc.rankingStar,
      masterScore: hc.masterScore,
      masterRank: hc.masterRank,
      score: hc.score,
      winRate: fallbackWinRate,
      gameCnt: fallbackGameCnt,
      branch: hc.branch,
      seasonName: firstRes?.data?.historyList?.[0]?.seasonName || 'S44',
      heros,
      totalGames,
      honor,
      hasHonor,
      branchesJson: JSON.stringify(branches),
      radarJson: JSON.stringify(radar),
      trendJson: JSON.stringify(trend),
      hasBattleStats: radar.some(r => r.value > 0),
      branches,
      radar,
      trend
    })

    await e.reply(img)
  }
}
