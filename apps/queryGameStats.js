import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginData } from '#components'
import { ApiService, readYamlFile, writeJsonFile } from '#utils'

export class QueryGameStats extends plugin {
  constructor() {
    super({
      name: '查询王者战绩',
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
      await e.reply(segment.image('https://raw.gitcode.com/Kevin1217/resources/files/master/resources/img/example/王者营地ID获取.png'))
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
      if (!battle) {
        await e.reply(`索引超出范围，当前最多可查询${battleList.list.length}场战绩`)
        return
      }

      const detail = await this.getBattleDetail(ID, battle)
      if (detail) {
        try {
          const img = await this.generateDetailImage(detail)
          await e.reply(img)
        } catch (err) {
          logger.error(`[战绩查询] 生成图片失败: ${err}`)
          await e.reply('生成战绩详情图片失败，请稍后再试')
        }
      } else {
        await e.reply('获取单场战绩详情失败')
      }
      return
    }

    const processedData = battleList.list.map(item => ({
      gameType: item.mapName,
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
    const { battleType, gameSvrId, relaySvrId, gameSeq, battleDetailUrl } = battle
    const targetRoleId = battleDetailUrl.match(/toAppRoleId=(\d+)/)?.[1]

    const { data: detail } = await ApiService.getBattledetail(ID, battleType, gameSvrId, relaySvrId, targetRoleId, gameSeq)


    if (!detail) {
      logger.error('[战绩查询] 获取战斗详情失败：接口返回空数据')
      return null
    }

    if (!detail?.head?.acntCamp) {
      logger.error('[战绩查询] 战斗详情数据不完整，缺少acntCamp字段')
      return null
    }

    writeJsonFile(path.join(PluginData, 'BattleDetails.json'), detail)

    logger.debug(`[战绩查询] 战斗详情数据已保存，数据大小：${JSON.stringify(detail).length}字节`)
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

  getTags = ({ desc, evaluateUrlV2, mvpUrlV2, evaluateUrlV3 }) => {
    const tags = []
    if (mvpUrlV2) tags.push('MVP')
    
    // 优先使用顶级标签 (evaluateUrlV3)，但仅当evaluateMap中有对应值时
    if (evaluateUrlV3 && this.evaluateMap[evaluateUrlV3]) {
      tags.push(this.evaluateMap[evaluateUrlV3])
    } else if (evaluateUrlV2 && this.evaluateMap[evaluateUrlV2]) {
      tags.push(this.evaluateMap[evaluateUrlV2])
    }
    
    if (desc && !tags.includes(desc)) tags.push(desc)
    return tags.filter(t => t)
  }

  evaluateMap = {
    // 原有的金牌/银牌标签
    'https://camp.qq.com/battle/common/evaluateV3/gold_warrior.png': '金牌战士',
    'https://camp.qq.com/battle/common/evaluateV3/gold_archer.png': '金牌射手',
    'https://camp.qq.com/battle/common/evaluateV3/silver_archer.png': '银牌射手',
    'https://camp.qq.com/battle/common/evaluateV3/gold_mage.png': '金牌法师',
    'https://camp.qq.com/battle/common/evaluateV3/gold_support.png': '金牌辅助',
    'https://camp.qq.com/battle/common/evaluateV3/silver_warrior.png': '银牌战士',
    'https://camp.qq.com/battle/common/evaluateV3/silver_archer.png': '银牌射手',
    'https://camp.qq.com/battle/common/evaluateV3/silver_mage.png': '银牌法师',
    'https://camp.qq.com/battle/common/evaluateV3/silver_support.png': '银牌辅助',
    // 顶级标签 evaluateUrlV3
    'https://game-1255653016.file.myqcloud.com/manage/custom_wzry_battledetail_tags/4b4f396f8e6d18bdf8bf699b8c5d9be4.png': '顶级中路',
    'https://game-1255653016.file.myqcloud.com/manage/custom_wzry_battledetail_tags/9eb904626303912a65d9b69bc8d88aa9.png': '顶级打野',
    'https://game-1255653016.file.myqcloud.com/manage/custom_wzry_battledetail_tags/5db4fef1bfc72dd2c5ae71b01ef3951b.png': '顶级对抗路',
    'https://game-1255653016.file.myqcloud.com/manage/custom_wzry_battledetail_tags/a8b5101bc81ae64cf96c67ed1ab21975.png': '顶级游走',
    'https://game-1255653016.file.myqcloud.com/manage/custom_wzry_battledetail_tags/926ba0111984464ad46e72dc93157fcd.png': '顶级发育路'
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
