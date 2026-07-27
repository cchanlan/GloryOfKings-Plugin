import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ApiService, readYamlFile } from '#utils'
import { PluginData } from '#components'

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
      rule: [{ reg: '^#巅峰表现\\s*(.*)$', fnc: 'peakPerformance' }]
    })
  }

  async peakPerformance(e) {
    const userId = (e.at && !e.atme) ? e.at : e.user_id
    const userData = readYamlFile(path.join(PluginData, 'UserData.yaml')) || {}
    const input = e.msg.replace(/^#巅峰表现\s*/, '').trim()
    const userInfo = userData[userId]

    const campId = input && /^\d+$/.test(input)
      ? input
      : userInfo?.ids?.[userInfo.current ?? 0]

    if (!campId) {
      await e.reply(segment.image('https://raw.gitcode.com/Kevin1217/resources/files/master/resources/img/example/王者营地ID获取.png'), true)
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

    // 全部分路 + 5 条分路 + 赛季页（巅峰英雄/上分趋势），一次性并发拉取
    const branchTypes = [0, 1, 2, 3, 4, 5]
    let results
    let seasonData = null
    try {
      const [fightResults, sData] = await Promise.all([
        Promise.all(
          branchTypes.map(bt => ApiService.getFightData(roleId, String(userId), { gameBattleType: 10, branchType: bt }))
        ),
        (async () => {
          try {
            const first = await ApiService.getSeasonpage(roleId, String(userId), 0)
            const sid = first?.data?.historyList?.[0]?.seasonId
            if (!sid) return null
            return ApiService.getSeasonpage(roleId, String(userId), sid)
          } catch { return null }
        })()
      ])
      results = fightResults
      seasonData = sData?.data || null
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

    const honor = {
      mvp: overall.raw.mvp || 0,
      loseMvp: overall.raw.loseMvp || 0,
      threeKill: overall.raw.threeKill || 0,
      fourKill: overall.raw.fourKill || 0,
      fiveKill: overall.raw.fiveKill || 0,
      godLike: overall.raw.godLike || 0,
      goldMedal: overall.raw.goldMedal || 0,
      sliverMedal: overall.raw.sliverMedal || 0
    }
    const hasHonor = Object.values(honor).some(v => v > 0)

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
      gameCnt: overall.gameCnt,
      winRate: overall.winRate,
      winNum: overall.raw.winNum || 0,
      loseNum: overall.raw.loseNum || 0,
      avgScore: overall.avgScore,
      branch,
      honor,
      hasHonor,
      branches,
      branchesJson: JSON.stringify(branches),
      lanes,
      hasLanes: lanes.length > 0,
      overallJson: JSON.stringify(overall),
      lanesJson: JSON.stringify(lanes),
      trend,
      trendJson: JSON.stringify(trend),
      heros
    })

    await e.reply(img, true)
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
