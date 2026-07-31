import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ApiService, readYamlFile } from '#utils'
import { PluginData, PluginPath } from '#components'

const BRANCH_NAME = { 1: '对抗路', 2: '中路', 3: '发育路', 4: '打野', 5: '游走' }
// 分路五维雷达颜色（与场次统计的分路配色对应）
const LANE_COLORS = { 1: '#f0932b', 2: '#6ab0f5', 3: '#57c98a', 4: '#c97bdb', 5: '#e0708a' }
// 五维雷达满分（万分制，与整体对战资料保持一致）
const RADAR_MAX = 12000

export class SeasonPage extends plugin {
  constructor() {
    super({
      name: '查询王者赛季表现',
      dsc: '赛季表现',
      event: 'message',
      priority: 1,
      rule: [{ reg: '^#排位表现\\s*(.*)$', fnc: 'seasonPage' }]
    })
  }

  async seasonPage(e) {
    const userId = (e.at && !e.atme) ? e.at : e.user_id
    const userData = readYamlFile(path.join(PluginData, 'UserData.yaml')) || {}
    const input = e.msg.replace(/^#排位表现\s*/, '').trim()
    const userInfo = userData[userId]

    let campId = input && /^\d+$/.test(input) ? input
      : userInfo?.ids?.[userInfo.current ?? 0]

    if (!campId) {
      await e.reply(segment.image(path.join(PluginPath, 'resources', 'img', '营地ID获取.png')), true)
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

    // 分路五维：seasonpage 不含分路五维，需对每条分路单独拉取 getFightData（排位赛 gameBattleType=3）
    const laneTypes = [1, 2, 3, 4, 5]
    let laneResults = []
    try {
      laneResults = await Promise.all(
        laneTypes.map(bt => ApiService.getFightData(roleId, String(userId), { gameBattleType: 3, branchType: bt })
          .catch(() => null))
      )
    } catch {
      laneResults = []
    }
    const lanes = laneResults
      .map((res, i) => this.buildLane(laneTypes[i], res?.data?.battleDataSelf))
      .filter(l => l && l.gameCnt > 0)

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
      trend,
      lanes,
      hasLanes: lanes.length > 0,
      lanesJson: JSON.stringify(lanes)
    })

    await e.reply(img, true)
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
