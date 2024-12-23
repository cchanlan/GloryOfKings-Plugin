import fs from 'fs'
import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ApiService, getFilePath, readJsonFile, writeJsonFile, readYamlFile } from '#utils'
import { PluginData } from '#components'

export class QueryGameStats extends plugin {
  constructor () {
    super({
      name: '查询战绩',
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

  async queryGameStats (e) {
    const userFilePath = path.join(PluginData, 'UserData.yaml')
    const allUserData = readYamlFile(userFilePath)
    const ID = allUserData[e.user_id]

    if (!ID) {
      return e.reply(segment.image('https://gitee.com/Tloml-Starry/resources/raw/master/resources/img/example/王者营地ID获取.png'))
    }

    // 获取 OpenID 和 Token
    let { OpenID, Token } = await ApiService.getPublicTokenAndOpenID()

    let index = this.extractBattleIndex(e.msg)

    // 封装请求逻辑
    const fetchBattleList = async (ssoOpenId, ssoToken) => {
      return ApiService.post('/game/morebattlelist', {
        lastTime: 0,
        recommendPrivacy: 0,
        apiVersion: 5,
        friendUserId: ID,
        option: 0
      }, {
        ssoopenid: ssoOpenId,
        ssotoken: ssoToken
      })
    }

    let response_ = await fetchBattleList(OpenID, Token)

    // 处理无效Token
    if (response_.returnCode === -30003) {
      const loginFilePath = getFilePath(e.user_id)
      if (!fs.existsSync(loginFilePath)) {
        return e.reply('公共Token&OpenID失效. \r且未找到您的登录信息，请先扫码登录。\r发送【#营地扫码】')
      }

      const userData = readJsonFile(loginFilePath)
      const { ssoOpenId, ssoToken } = userData
      response_ = await fetchBattleList(ssoOpenId, ssoToken)

      if (response_.returnCode === -30003) {
        return e.reply('登陆状态失效，请重新扫码登录')
      }
    }

    if (response_.data.list.length === 0) {
      return e.reply(response_.invisDes)
    }

    writeJsonFile(path.join(PluginData, 'BattleList.json'), response_.data)

    if (index) {
      await this.handleBattleDetails(e, response_.data.list[index - 1], OpenID, Token, ssoOpenId, ssoToken)
    } else {
      await this.handleBattleList(e, response_.data.list)
    }
  }

  // 提取战绩索引
  async extractBattleIndex (msg) {
    const match = msg.match(/#查询战绩(\d+)?/)
    return match ? Number(match[1]) || false : false
  }

  // 处理战斗详情
  async handleBattleDetails (e, battleDetails, OpenID, Token, ssoOpenId, ssoToken) {
    const { battleType, gameSvrId: gameSvr, relaySvrId: relaySvr, battleDetailUrl, gameSeq } = battleDetails

    const targetRoleId = battleDetailUrl.includes('&toAppRoleId=')
      ? battleDetailUrl.substring(battleDetailUrl.indexOf('&toAppRoleId=') + 13, battleDetailUrl.indexOf('&toGameRoleId='))
      : null

    let response = await this.fetchBattleDetail(OpenID, Token, battleType, gameSvr, relaySvr, targetRoleId, gameSeq)

    if (response.returnCode === -30003 || response.returnCode === '-30314') {
      response = await this.fetchBattleDetail(ssoOpenId, ssoToken, battleType, gameSvr, relaySvr, targetRoleId, gameSeq)

      if (response.returnCode !== 0) {
        return e.reply(response.returnMsg)
      }
    }

    writeJsonFile(path.join(PluginData, 'BattleDetails.json'), response.data)

    const { head, battle, redTeam, blueTeam, redRoles, blueRoles } = response.data
    const myTeamColor = head.acntCamp === redTeam.acntCamp ? '红' : '蓝'
    const enemyTeamColor = myTeamColor === '红' ? '蓝' : '红'

    const us = this.extractTeamData(myTeamColor, head, battle, redTeam, blueTeam, redRoles, blueRoles)

    const data = {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordDetails.html',
      ...us,
      myTeamColor,
      enemyTeamColor
    }

    const inventoryImage = puppeteer.screenshot('QueryGameRecordDetails', data)
    e.reply(inventoryImage)
  }

  // 封装获取战斗详情请求
  async fetchBattleDetail (ssoOpenId, ssoToken, battleType, gameSvr, relaySvr, targetRoleId, gameSeq) {
    return ApiService.post('/game/battledetail', {
      recommendPrivacy: 0,
      battleType,
      gameSvr,
      relaySvr,
      targetRoleId,
      gameSeq
    }, {
      ssoopenid: ssoOpenId,
      ssotoken: ssoToken
    })
  }

  // 处理战绩列表
  async handleBattleList (e, battleList) {
    const data = battleList.map(item => ({
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

    const inventoryImage = puppeteer.screenshot('QueryGameRecordList', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html',
      data,
      roleJobName: battleList[0].roleJobName,
      winningStreak: this.calculateWinningStreak(data.map(item => item.gameResult))
    })

    e.reply(inventoryImage)
  }

  async extractTeamData (myTeamColor, head, battle, redTeam, blueTeam, redRoles, blueRoles) {
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

  async getGameResult (result) {
    return result === 1 ? '胜利' : result === 2 ? '失败' : result
  }

  async getTags (item) {
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

  async calculateWinningStreak (results) {
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
}
