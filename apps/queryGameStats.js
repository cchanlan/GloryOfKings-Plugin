import fs from 'fs'
import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginData } from '#components'
import { ApiService, readYamlFile, getFilePath, readJsonFile, writeJsonFile, monitor } from '#utils'

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
        },
        {
          reg: /^#(开启|关闭)王者战绩推送$/,
          fnc: 'toggleGameStatsPush'
        }
      ]
    })
    this.task = {
      name: '王者战绩推送',
      fnc: () => this.pushGameStats(),
      cron: '0 */1 * * * *',
      log: false
    }
  }

  async pushGameStats() {
    try {
      const { userFilePath, settingsFilePath } = {
        userFilePath: path.join(PluginData, 'UserData.yaml'),
        settingsFilePath: path.join(PluginData, 'gameStatsPushSettings.yaml')
      }

      const { userData, settingsData } = {
        userData: readYamlFile(userFilePath),
        settingsData: readYamlFile(settingsFilePath)
      }

      for (const userId of Object.keys(settingsData)) {
        if (!settingsData[userId]) {
          continue
        }

        const ID = userData[userId]
        if (!ID) {
          continue
        }

        const { OpenID, Token } = await ApiService.getPublicTokenAndOpenID()
        
        let response = await this.fetchBattleList({ user_id: userId }, ID)
        
        if (!response || !response.data || !response.data.list || response.data.list.length === 0) {
          continue
        }

        const lastBattleFile = path.join(PluginData, 'lastBattle', `${userId}.json`)
        let lastBattle = {}
        if (fs.existsSync(lastBattleFile)) {
          lastBattle = readJsonFile(lastBattleFile)
        }

        const latestBattle = response.data.list[0]
        
        if (lastBattle.gameSeq === latestBattle.gameSeq) {
          continue
        }

        const battleDetails = latestBattle
        const response2 = await this.fetchBattleDetails(battleDetails, { user_id: userId })
        
        if (!response2 || !response2.data) {
          continue
        }

        const { head, battle, redTeam, blueTeam, redRoles, blueRoles } = response2.data
        
        if (!head || !battle || !redTeam || !blueTeam || !redRoles || !blueRoles) {
          continue
        }

        if (!head.acntCamp) {
          continue
        }

        if (head.acntCamp !== redTeam.acntCamp && head.acntCamp !== blueTeam.acntCamp) {
          continue
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
        
        const groupId = settingsData[userId]
        if (groupId) {
          const playerTeam = myTeamColor === '红' ? redRoles : blueRoles
          const playerRole = playerTeam.find(role => role.acntCamp === head.acntCamp)
          const playerName = playerRole?.name || '玩家'
          
          Bot.pickGroup(groupId).sendMsg([
            `${playerName} 的最新战绩`,
            image
          ])
        }

        if (!fs.existsSync(path.join(PluginData, 'lastBattle'))) {
          fs.mkdirSync(path.join(PluginData, 'lastBattle'), { recursive: true })
        }
        writeJsonFile(lastBattleFile, {
          gameSeq: latestBattle.gameSeq,
          timestamp: Date.now()
        })
      }
    } catch (error) {
      // Silent error handling
    }
  }

  async toggleGameStatsPush(e) {
    let userId = e.user_id
    let groupId = e.group_id
    const { isGroup } = e
    if (!isGroup) return false

    const { userFilePath, settingsFilePath } = {
      userFilePath: path.join(PluginData, 'UserData.yaml'),
      settingsFilePath: path.join(PluginData, 'gameStatsPushSettings.yaml')
    }

    const { userData, settingsData } = {
      userData: readYamlFile(userFilePath),
      settingsData: readYamlFile(settingsFilePath)
    }

    if (!userData[userId]) {
      await e.reply(segment.image('https://gitee.com/Tloml-Starry/resources/raw/master/resources/img/example/王者营地ID获取.png'))
      return
    }

    const isEnabled = /^#开启/.test(e.msg)
    settingsData[userId] = isEnabled ? groupId : null

    fs.writeFileSync(settingsFilePath, JSON.stringify(settingsData, null, 2))
    await e.reply(`战绩推送已${isEnabled ? '开启' : '关闭'}。`)
  }

  async queryGameStats(e) {
    const userFilePath = path.join(PluginData, 'UserData.yaml')
    const allUserData = readYamlFile(userFilePath)
    const ID = allUserData[e.user_id]

    if (!ID) {
      await e.reply(segment.image('https://gitee.com/Tloml-Starry/resources/raw/master/resources/img/example/王者营地ID获取.png'))
      return
    }

    const { OpenID, Token } = await ApiService.getPublicTokenAndOpenID()

    let index = Number(e.msg.match(/#查询战绩(\d+)?/)[1]) || false

    let response_ = await ApiService.post('/game/morebattlelist', {
      lastTime: 0,
      recommendPrivacy: 0,
      apiVersion: 5,
      friendUserId: ID,
      option: 0
    }, {
      ssoopenid: OpenID,
      ssotoken: Token
    })

    if (response_.returnCode === 0) {
      await e.reply(`ID: ${ID},召唤师隐藏了战绩，无法查看`)
      return
    }

    if (response_.returnCode === -30003) {
      const loginFilePath = getFilePath(e.user_id)
      if (!fs.existsSync(loginFilePath)) {
        await e.reply('公共Token&OpenID失效. \r且未找到您的登录信息，请先扫码登录。\r发送【#营地扫码】')
        return
      }

      const userData = readJsonFile(loginFilePath)
      const { ssoOpenId, ssoToken } = userData
      response_ = await ApiService.post('/game/morebattlelist', {
        lastTime: 0,
        recommendPrivacy: 0,
        apiVersion: 5,
        friendUserId: ID,
        option: 0
      }, {
        ssoopenid: ssoOpenId,
        ssotoken: ssoToken
      })

      if (response_.returnCode === -30003) {
        e.reply('登陆状态失效，请重新扫码登录')
        return
      }
    }

    if (response_.data.list.length === 0) {
      return e.reply(response_.invisDes)
    }

    writeJsonFile(path.join(PluginData, 'BattleList.json'), response_.data)

    if (index) {
      const battleDetails = response_.data.list[index - 1]
      const { battleType, gameSvrId: gameSvr, relaySvrId: relaySvr, battleDetailUrl, gameSeq } = battleDetails

      const targetRoleId = battleDetailUrl.includes('&toAppRoleId=')
        ? battleDetailUrl.substring(battleDetailUrl.indexOf('&toAppRoleId=') + 13, battleDetailUrl.indexOf('&toGameRoleId='))
        : null

      let response = await ApiService.post('/game/battledetail', {
        recommendPrivacy: 0,
        battleType,
        gameSvr,
        relaySvr,
        targetRoleId,
        gameSeq
      }, {
        ssoopenid: OpenID,
        ssotoken: Token
      })

      if (response.returnCode === -30003 || response.returnCode === '-30314') {
        response = await ApiService.post('/game/battledetail', {
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

        if (response.returnCode !== 0) {
          return e.reply(response.returnMsg)
        }
      }

      writeJsonFile(path.join(PluginData, 'BattleDetails.json'), response.data)

      const { head, battle, redTeam, blueTeam, redRoles, blueRoles } = response.data
      if (!head || !head.acntCamp) {
        return e.reply('查询失败，疑似不可查询战绩模式');
      }
      const myTeamColor = head.acntCamp === redTeam.acntCamp ? '红' : '蓝'
      const enemyTeamColor = myTeamColor === '红' ? '蓝' : '红'

      const us = this.extractTeamData(myTeamColor, head, battle, redTeam, blueTeam, redRoles, blueRoles)

      const data = {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordDetails.html',
        ...us,
        myTeamColor,
        enemyTeamColor
      }

      const inventoryImage = await puppeteer.screenshot('QueryGameRecordDetails', data)
      await e.reply(inventoryImage)
      return
    }

    const data = response_.data.list.map(item => ({
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

    const inventoryImage = await puppeteer.screenshot('QueryGameRecordList', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html',
      data,
      roleJobName: response_.data.list[0].roleJobName,
      winningStreak: this.calculateWinningStreak(data.map(item => item.gameResult))
    })

    await e.reply(inventoryImage)
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
    try {
      monitor.startTimer('fetchBattleDetails')
      const response = await this.fetchBattleDetails(battleDetails, e)
      const duration = monitor.endTimer('fetchBattleDetails')

      if (!response) {
        return e.reply('获取战绩详情失败，请稍后重试')
      }

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
    } catch (error) {
      return e.reply('处理战绩详情时发生错误，请稍后重试')
    }
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

  async fetchBattleDetails(battleDetails, e) {
    try {
      let { OpenID, Token } = await ApiService.getPublicTokenAndOpenID()
      const body = {
        gameSeq: battleDetails.gameSeq,
        battleType: battleDetails.battleType,
        gameSvr: battleDetails.gameSvrId,
        relaySvr: battleDetails.relaySvrId,
        recommendPrivacy: 0,
        apiVersion: 5
      }

      if (battleDetails.battleDetailUrl?.includes('&toAppRoleId=')) {
        body.targetRoleId = battleDetails.battleDetailUrl.substring(
          battleDetails.battleDetailUrl.indexOf('&toAppRoleId=') + 13,
          battleDetails.battleDetailUrl.indexOf('&toGameRoleId=')
        )
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

      if (response.returnCode !== 0) {
        return null
      }

      if (!response || !response.data) {
        return null
      }

      const defaultData = {
        head: {
          acntCamp: 1,
          gameResult: 0,
          tips: '',
          mapName: '王者峡谷',
          matchDesc: '排位赛'
        },
        battle: {
          startTime: new Date().toISOString(),
          usedTime: 0
        },
        redTeam: {
          acntCamp: 1,
          money: 0,
          towerCnt: 0,
          killCnt: 0,
          deadCnt: 0,
          assistCnt: 0,
          bdragon1: 0,
          bdragon2: 0,
          bdragon3: 0,
          ldragon1: 0,
          ldragon2: 0
        },
        blueTeam: {
          acntCamp: 2,
          money: 0,
          towerCnt: 0,
          killCnt: 0,
          deadCnt: 0,
          assistCnt: 0,
          bdragon1: 0,
          bdragon2: 0,
          bdragon3: 0,
          ldragon1: 0,
          ldragon2: 0
        },
        redRoles: [],
        blueRoles: []
      }

      response.data = {
        ...defaultData,
        ...response.data,
        head: { ...defaultData.head, ...response.data?.head },
        battle: { ...defaultData.battle, ...response.data?.battle },
        redTeam: { ...defaultData.redTeam, ...response.data?.redTeam },
        blueTeam: { ...defaultData.blueTeam, ...response.data?.blueTeam },
        redRoles: response.data?.redRoles || [],
        blueRoles: response.data?.blueRoles || []
      }

      return response
    } catch (error) {
      return null
    }
  }
}
