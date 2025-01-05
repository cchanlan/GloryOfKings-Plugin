import fs from 'fs'
import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginData } from '#components'
import { 
  ApiService, 
  readYamlFile, 
  getFilePath, 
  readJsonFile, 
  writeJsonFile,
  logger,
  monitor,
  cache 
} from '#utils'

export class QueryGameStats extends plugin {
  constructor() {
    super({
      name: 'queryGameStats',
      dsc: '查询战绩',
      event: 'message',
      priority: 1,
      rule: [
        {
          reg: /^#查询战绩(\d+)?/,
          fnc: 'queryGameStats'
        }
      ]
    })
  }

  async queryGameStats(e) {
    monitor.startTimer('queryGameStats')
    try {
      const userFilePath = path.join(PluginData, 'UserData.yaml')
      const ID = readYamlFile(userFilePath)?.[e.user_id]

      if (!ID) {
        await e.reply(segment.image('https://gitee.com/Tloml-Starry/resources/raw/master/resources/img/example/王者营地ID获取.png'))
        return
      }

      const index = Number(e.msg.match(/#查询战绩(\d+)?/)?.[1]) || false
      
      // 尝试从缓存获取战绩列表
      const cacheKey = `battleList:${ID}`
      let battleList = cache.get(cacheKey)
      
      if (!battleList) {
        battleList = await this.fetchBattleList(e, ID)
        if (battleList?.data?.list?.length) {
          cache.set(cacheKey, battleList, 300) // 缓存5分钟
        }
      }
      
      if (!battleList?.data?.list?.length) {
        return e.reply(battleList?.invisDes || '未获取到战绩数据')
      }

      writeJsonFile(path.join(PluginData, 'BattleList.json'), battleList.data)

      if (index) {
        return await this.handleDetailedStats(e, battleList.data.list[index - 1])
      }

      return await this.handleBattleList(e, battleList.data)
    } catch (error) {
      logger.error(`查询战绩出错: ${error.message}`)
      return e.reply('查询战绩时发生错误，请稍后重试')
    } finally {
      monitor.endTimer('queryGameStats')
    }
  }

  async fetchBattleList(e, ID) {
    let { OpenID, Token } = await ApiService.getPublicTokenAndOpenID()
    const body = { lastTime: 0, recommendPrivacy: 0, apiVersion: 5, friendUserId: ID, option: 0 }
    
    let response = await ApiService.post('/game/morebattlelist', body, { 
      ssoopenid: OpenID, 
      ssotoken: Token 
    })

    if (response.returnCode === -30003) {
      const loginData = await this.getUserLoginData(e)
      if (!loginData) return null

      response = await ApiService.post('/game/morebattlelist', body, {
        ssoopenid: loginData.ssoOpenId,
        ssotoken: loginData.ssoToken
      })

      if (response.returnCode === -30003) {
        await e.reply('登录状态失效，请重新扫码登录')
        return null
      }
    }

    return response
  }

  async getUserLoginData(e) {
    const loginFilePath = getFilePath(e.user_id)
    if (!fs.existsSync(loginFilePath)) {
      await e.reply('查询失败，公共Token失效\r且未找到您的登录信息，请先扫码登录。\r发送【#营地扫码】')
      return null
    }
    return readJsonFile(loginFilePath)
  }

  async handleDetailedStats(e, battleDetails) {
    const response = await this.fetchBattleDetails(battleDetails)
    if (!response) return

    writeJsonFile(path.join(PluginData, 'BattleDetails.json'), response.data)

    const { head, battle, redTeam, blueTeam, redRoles, blueRoles } = response.data
    if (!head?.acntCamp) {
      return e.reply('查询失败，疑似不可查询战绩模式')
    }

    const myTeamColor = head.acntCamp === redTeam.acntCamp ? '红' : '蓝'
    const enemyTeamColor = myTeamColor === '红' ? '蓝' : '红'
    const data = {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordDetails.html',
      ...this.extractTeamData(myTeamColor, head, battle, redTeam, blueTeam, redRoles, blueRoles),
      myTeamColor,
      enemyTeamColor
    }

    const image = await puppeteer.screenshot('QueryGameRecordDetails', data)
    await e.reply(image)
  }

  extractTeamData(myTeamColor, head, battle, redTeam, blueTeam, redRoles, blueRoles) {
    const isBlue = myTeamColor === '蓝'
    const myTeam = isBlue ? blueTeam : redTeam
    const enemyTeam = isBlue ? redTeam : blueTeam
    const myRoles = isBlue ? blueRoles : redRoles
    const enemyRoles = isBlue ? redRoles : blueRoles

    return {
      gameResult: head.gameResult ? '胜利' : '失败',
      gameResultEn: head.gameResult ? 'VICTORY' : 'DEFEAT',
      tips: head.tips,
      mapName: head.mapName,
      startTime: battle.startTime,
      usedTime: Math.floor(battle.usedTime / 60),
      matchDesc: head.matchDesc,
      myEconomyRate: (myTeam.money / (myTeam.money + enemyTeam.money)) * 100,
      myMoney: myTeam.money > 1000 ? `${(myTeam.money / 1000).toFixed(1)}k` : myTeam.money,
      myTowerCnt: myTeam.towerCnt,
      enemyMoney: enemyTeam.money > 1000 ? `${(enemyTeam.money / 1000).toFixed(1)}k` : enemyTeam.money,
      enemyTowerCnt: enemyTeam.towerCnt,
      myBdragon1: myTeam.bdragon1,
      myBdragon2: myTeam.bdragon2,
      myBdragon3: myTeam.bdragon3,
      myLdragon1: myTeam.ldragon1,
      myLdragon2: myTeam.ldragon2,
      enemyBdragon1: enemyTeam.bdragon1,
      enemyBdragon2: enemyTeam.bdragon2,
      enemyBdragon3: enemyTeam.bdragon3,
      enemyLdragon1: enemyTeam.ldragon1,
      enemyLdragon2: enemyTeam.ldragon2,
      myKillDeadAssistCnt: `${myTeam.killCnt}/${myTeam.deadCnt}/${myTeam.assistCnt}`,
      enemyKillDeadAssistCnt: `${enemyTeam.killCnt}/${enemyTeam.deadCnt}/${enemyTeam.assistCnt}`,
      myRoles,
      enemyRoles
    }
  }

  getGameResult(result) {
    return result === 1 ? '胜利' : result === 2 ? '失败' : result
  }

  getTags(item) {
    const tags = []
    const descTags = ['实力局', '翻盘局', '暴走局', '尽力局']
    const evaluateTags = {
      'https://camp.qq.com/battle/common/evaluateV3/gold_warrior.png': '金牌战士',
      'https://camp.qq.com/battle/common/evaluateV3/gold_mage.png': '金牌法师',
      'https://camp.qq.com/battle/common/evaluateV3/gold_support.png': '金牌辅助',
      'https://camp.qq.com/battle/common/evaluateV3/silver_warrior.png': '银牌战士',
      'https://camp.qq.com/battle/common/evaluateV3/silver_mage.png': '银牌法师',
      'https://camp.qq.com/battle/common/evaluateV3/silver_support.png': '银牌辅助'
    }
    const mvpTags = ['https://camp.qq.com/battle/common/mvpV3/svp.png', 'https://camp.qq.com/battle/common/mvpV3/mvp.png']

    if (descTags.includes(item.desc)) tags.push(item.desc)
    if (evaluateTags[item.evaluateUrlV2]) tags.push(evaluateTags[item.evaluateUrlV2])
    if (mvpTags.includes(item.mvpUrlV2)) tags.push('MVP')

    return tags
  }

  calculateWinningStreak(results) {
    let maxStreak = 0
    let currentStreak = 0

    for (let result of results) {
      if (result === '失败') {
        break
      }
      if (result === '胜利') {
        currentStreak++
        if (currentStreak > maxStreak) {
          maxStreak = currentStreak
        }
      }
    }

    return maxStreak
  }

  async handleBattleList(e, battleData) {
    const data = battleData.list.map(item => ({
      gameTpye: item.mapName,
      gameTime: item.gametime,
      gameDuration: `${Math.floor(item.usedTime / 60)}分${item.usedTime % 60}秒`,
      killCnt: item.killcnt,
      deadCnt: item.deadcnt,
      assistCnt: item.assistcnt,
      gameResult: this.getGameResult(item.gameresult),
      heroIcon: item.heroIcon,
      desc: item.desc,
      tags: this.getTags(item),
      gradeGame: item.gradeGame
    }))

    const image = await puppeteer.screenshot('QueryGameRecordList', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html',
      data,
      roleJobName: battleData.list[0].roleJobName,
      winningStreak: this.calculateWinningStreak(data.map(item => item.gameResult))
    })

    await e.reply(image)
  }

  async fetchBattleDetails(battleDetails) {
    try {
      let { OpenID, Token } = await ApiService.getPublicTokenAndOpenID()
      const body = {
        gameSeq: battleDetails.gameSeq,
        battleType: battleDetails.battleType,
        apiVersion: 5
      }
      
      let response = await ApiService.post('/game/battledetail', body, {
        ssoopenid: OpenID,
        ssotoken: Token
      })

      if (response.returnCode === -30003) {
        const loginData = await this.getUserLoginData(e)
        if (!loginData) return null

        response = await ApiService.post('/game/battledetail', body, {
          ssoopenid: loginData.ssoOpenId,
          ssotoken: loginData.ssoToken
        })

        if (response.returnCode === -30003) {
          await e.reply('登录状态失效，请重新扫码登录')
          return null
        }
      }

      return response
    } catch (error) {
      logger.error(`获取战绩详情失败: ${error.message}`, {
        battleDetails: JSON.stringify(battleDetails)
      })
      return null
    }
  }
}
