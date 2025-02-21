import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginData } from '#components'
import { ApiService, readYamlFile, writeJsonFile } from '#utils'

export class QueryGameStats extends plugin {
  constructor() {
    super({
      name: 'queryGameStats',
      dsc: '查询战绩',
      event: 'message',
      priority: 1,
      rule: [{
        reg: '^#?(查询|王者)战绩\\s*(.*)$',
        fnc: 'queryGameStats'
      }]
    })
  }

  async queryGameStats(e) {
    const userId = (e.at && !e.atme) ? e.at : e.user_id
    logger.debug(`用户 ${userId} 请求查询战绩...`)

    const userData = readYamlFile(path.join(PluginData, 'UserData.yaml'))
    const input = e.msg.replace(/^#?(查询|王者)战绩\s*/, '')
    const index = Number(input) || false

    let ID = index > 9999 ? index : this.getUserID(userData[userId], userId)
    if (!ID) {
      await e.reply(segment.image('https://gitee.com/Tloml-Starry/resources/raw/master/resources/img/example/王者营地ID获取.png'))
      return
    }

    const { data: battleList } = await ApiService.getMoreBattleList(ID)
    if (!battleList?.list?.length) {
      await e.reply(battleList?.invisDes || `ID: ${ID}，查询失败`)
      return
    }

    writeJsonFile(path.join(PluginData, 'BattleList.json'), battleList)

    if (index && index < 9999) {
      const battle = battleList.list[index - 1]
      const detail = await this.getBattleDetail(ID, battle)
      return detail && e.reply(await this.generateDetailImage(detail))
    }

    const processedData = battleList.list.map(item => ({
      gameTpye: item.mapName,
      gameTime: item.gametime,
      gameDuration: `${~~(item.usedTime / 60)}分${item.usedTime % 60}秒`,
      ...this.getBattleStats(item),
      heroIcon: item.heroIcon,
      desc: item.desc,
      tags: this.getTags(item),
      gradeGame: item.gradeGame
    }))

    e.reply(await puppeteer.screenshot('QueryGameRecordList', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html',
      data: processedData,
      roleJobName: battleList.list[0].roleJobName,
      winningStreak: this.calculateWinningStreak(processedData.map(d => d.gameResult))
    }))
  }

  getUserID(userInfo, userId) {
    if (!userInfo?.ids?.length) {
      logger.debug(`用户 ${userId} 未绑定ID`)
      return null
    }
    return userInfo.ids[userInfo.current]
  }

  async getBattleDetail(ID, battle) {
    const [battleType, gameSvr, relaySvr, gameSeq] =
      Object.values(battle).slice(0, 4) // 简化参数提取
    const targetRoleId = battle.battleDetailUrl.match(/toAppRoleId=(\d+)/)?.[1]

    const { data: detail } = await ApiService.getBattledetail(ID, battleType, gameSvr, relaySvr, targetRoleId, gameSeq)
    if (!detail?.head?.acntCamp) return null

    writeJsonFile(path.join(PluginData, 'BattleDetails.json'), detail)
    return detail
  }

  generateDetailImage = async ({ head, battle, redTeam, blueTeam, redRoles, blueRoles }) => {
    const isBlue = head.acntCamp === blueTeam.acntCamp
    const [myTeam, enemyTeam] = isBlue ? [blueTeam, redTeam] : [redTeam, blueTeam]
    const [myRoles, enemyRoles] = isBlue ? [blueRoles, redRoles] : [redRoles, blueRoles]

    return puppeteer.screenshot('QueryGameRecordDetails', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordDetails.html',
      gameResult: head.gameResult ? '胜利' : '失败',
      gameResultEn: head.gameResult ? 'VICTORY' : 'DEFEAT',
      myTeamColor: isBlue ? '蓝' : '红',
      enemyTeamColor: isBlue ? '红' : '蓝',
      ...this.getTeamData(myTeam, enemyTeam, myRoles, enemyRoles, head, battle)
    })
  }

  getBattleStats = ({ killcnt, deadcnt, assistcnt, gameresult }) => ({
    killCnt: killcnt,
    deadCnt: deadcnt,
    assistCnt: assistcnt,
    gameResult: { 1: '胜利', 2: '失败' }[gameresult] || gameresult
  })

  getTags = ({ desc, evaluateUrlV2, mvpUrlV2 }) => {
    const tags = []
    if (['实力局', '翻盘局', '暴走局', '尽力局'].includes(desc)) tags.push(desc)
    if (evaluateUrlV2) tags.push(this.evaluateMap[evaluateUrlV2])
    if (mvpUrlV2) tags.push('MVP')
    return tags
  }

  evaluateMap = {
    'https://camp.qq.com/battle/common/evaluateV3/gold_warrior.png': '金牌战士',
    'https://camp.qq.com/battle/common/evaluateV3/gold_mage.png': '金牌法师',
    'https://camp.qq.com/battle/common/evaluateV3/gold_support.png': '金牌辅助',
    'https://camp.qq.com/battle/common/evaluateV3/silver_warrior.png': '银牌战士',
    'https://camp.qq.com/battle/common/evaluateV3/silver_mage.png': '银牌法师',
    'https://camp.qq.com/battle/common/evaluateV3/silver_support.png': '银牌辅助'
  }

  getTeamData = (myTeam, enemyTeam, myRoles, enemyRoles, head, battle) => ({
    tips: head.tips,
    mapName: head.mapName,
    startTime: battle.startTime,
    usedTime: ~~(battle.usedTime / 60),
    matchDesc: head.matchDesc,
    myEconomyRate: (myTeam.money / (myTeam.money + enemyTeam.money)) * 100,
    myMoney: this.formatMoney(myTeam.money),
    myTowerCnt: myTeam.towerCnt,
    enemyMoney: this.formatMoney(enemyTeam.money),
    enemyTowerCnt: enemyTeam.towerCnt,
    myKillDeadAssistCnt: `${myTeam.killCnt}/${myTeam.deadCnt}/${myTeam.assistCnt}`,
    enemyKillDeadAssistCnt: `${enemyTeam.killCnt}/${enemyTeam.deadCnt}/${enemyTeam.assistCnt}`,
    myRoles, enemyRoles,
    ...this.getDragonStats(myTeam, enemyTeam)
  })

  formatMoney = money => money > 1000 ? `${(money / 1000).toFixed(1)}k` : money

  getDragonStats = (my, enemy) => ({
    myBdragon1: my.bdragon1, myBdragon2: my.bdragon2, myBdragon3: my.bdragon3,
    myLdragon1: my.ldragon1, myLdragon2: my.ldragon2,
    enemyBdragon1: enemy.bdragon1, enemyBdragon2: enemy.bdragon2, enemyBdragon3: enemy.bdragon3,
    enemyLdragon1: enemy.ldragon1, enemyLdragon2: enemy.ldragon2
  })

  calculateWinningStreak = results =>
    results.reduce(([max, current], result) =>
      result === '胜利'
        ? [Math.max(max, current + 1), current + 1]
        : result === '失败' ? [max, 0] : [max, current],
      [0, 0])[0]
}
