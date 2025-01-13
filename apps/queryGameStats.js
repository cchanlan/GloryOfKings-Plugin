import fs from 'fs'
import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginData, Config } from '#components'
import { ApiService, readYamlFile, getFilePath, readJsonFile, writeJsonFile, monitor } from '#utils'

const { battleResultCron } = Config.getConfig('config')
export class QueryGameStats extends plugin {
  constructor () {
    super({
      name: 'queryGameStats',
      dsc: '查询战绩',
      event: 'message',
      priority: 1,
      rule: [
        {
          reg: '^#?(查询|王者)战绩\\s*(.*)$',
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
      cron: battleResultCron,
      log: false
    }
  }

  async loadUserDataAndSettings () {
    try {
      const { userFilePath, settingsFilePath } = {
        userFilePath: path.join(PluginData, 'UserData.yaml'),
        settingsFilePath: path.join(PluginData, 'gameStatsPushSettings.yaml')
      }

      const userData = readYamlFile(userFilePath) || {}
      const settingsData = readYamlFile(settingsFilePath) || {}

      return { userData, settingsData }
    } catch (error) {
      logger.error('加载用户数据和设置失败:', error)
      return { userData: {}, settingsData: {} }
    }
  }

  async processBattleRecord (userId, latestBattle, groupId) {
    try {
      const response = await this.fetchBattleDetails(latestBattle)

      if (!this.validateBattleResponse(response)) {
        logger.debug(`用户 ${userId} 的战斗详情数据无效`)
        return
      }

      const { head, battle, redTeam, blueTeam, redRoles, blueRoles } = response.data
      const myTeamColor = head.acntCamp === redTeam.acntCamp ? '红' : '蓝'
      const data = this.prepareBattleData(myTeamColor, head, battle, redTeam, blueTeam, redRoles, blueRoles)

      const image = await puppeteer.screenshot('QueryGameRecordDetails', data)
      const playerName = this.getPlayerName(head, redRoles, blueRoles, latestBattle)
      await Bot.pickGroup(groupId).sendMsg([
        `${playerName} 的最新战绩`,
        image
      ])
    } catch (error) {
      logger.error(`处理战斗记录失败 (用户 ${userId}):`, error)
    }
  }

  validateBattleResponse (response) {
    if (!response?.data) return false
    const { head, battle, redTeam, blueTeam, redRoles, blueRoles } = response.data
    return head?.acntCamp && battle && redTeam && blueTeam && redRoles && blueRoles
  }

  prepareBattleData (myTeamColor, head, battle, redTeam, blueTeam, redRoles, blueRoles) {
    return {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordDetails.html',
      ...this.extractTeamData(myTeamColor, head, battle, redTeam, blueTeam, redRoles, blueRoles),
      myTeamColor,
      enemyTeamColor: myTeamColor === '红' ? '蓝' : '红'
    }
  }

  async pushGameStats () {
    try {
      logger.debug('开始推送战绩...')
      const { userData, settingsData } = await this.loadUserDataAndSettings()

      for (const [userId, groupId] of Object.entries(settingsData)) {
        if (!this.shouldProcessUser(userId, groupId, userData)) continue

        const userInfo = userData[userId]
        if (!userInfo || !userInfo.ids || !userInfo.ids.length) {
          logger.debug(`用户 ${userId} 未绑定ID`)
          continue
        }
        const ID = userInfo.ids[userInfo.current]

        await this.processUserBattles(userId, ID, groupId)
      }
    } catch (error) {
      logger.error('推送战绩时发生错误:', error)
    }
  }

  shouldProcessUser (userId, groupId, userData) {
    if (!groupId) {
      logger.debug(`用户 ${userId} 未开启战绩推送`)
      return false
    }

    const userInfo = userData[userId]
    if (!userInfo || !userInfo.ids || !userInfo.ids.length) {
      logger.debug(`用户 ${userId} 未绑定ID`)
      return false
    }

    return true
  }

  async processUserBattles (userId, ID, groupId) {
    try {
      const response = await this.fetchBattleList({ user_id: userId }, ID)
      if (!this.validateBattleList(response)) {
        logger.debug(`用户 ${userId} 没有新的战斗记录`)
        return
      }

      const latestBattle = response.data.list[0]
      if (await this.isNewBattle(userId, latestBattle)) {
        await this.processBattleRecord(userId, latestBattle, groupId)
        await this.updateLastBattle(userId, latestBattle)
      }
    } catch (error) {
      logger.error(`处理用户 ${userId} 的战斗时发生错误:`, error)
    }
  }

  // 切换战绩推送状态的函数
  async toggleGameStatsPush (e) {
    let userId = (e.at && e.isMaster) ? e.at : e.user_id
    const { group_id: groupId, isGroup } = e // 获取群组 ID 和检查是否为群组消息
    if (!isGroup) return e.reply('只支持群内使用', true)

    logger.debug(`用户 ${userId} 请求切换战绩推送状态...`)

    // 定义用户数据和设置文件的路径
    const { userFilePath, settingsFilePath } = {
      userFilePath: path.join(PluginData, 'UserData.yaml'), // 用户数据文件路径
      settingsFilePath: path.join(PluginData, 'gameStatsPushSettings.yaml') // 设置文件路径
    }

    // 读取用户数据和设置数据
    const { userData, settingsData } = {
      userData: readYamlFile(userFilePath), // 读取用户数据
      settingsData: readYamlFile(settingsFilePath) // 读取设置数据
    }

    // 修改检查用户数据的方式
    const userInfo = userData[userId]
    if (!userInfo || !userInfo.ids || !userInfo.ids.length) {
      await e.reply(segment.image('https://gitee.com/Tloml-Starry/resources/raw/master/resources/img/example/王者营地ID获取.png'))
      return
    }

    const isEnabled = /^#开启/.test(e.msg) // 检查是否开启推送
    settingsData[userId] = isEnabled ? groupId : null // 更新设置数据

    fs.writeFileSync(settingsFilePath, JSON.stringify(settingsData, null, 2)) // 写入设置文件
    await e.reply(`战绩推送已${isEnabled ? '开启' : '关闭'}。`) // 回复用户
    logger.debug(`用户 ${userId} 的战绩推送状态已${isEnabled ? '开启' : '关闭'}`)
  }

  // 查询战绩的函数
  async queryGameStats (e) {
    let userId = (e.at && !e.atme) ? e.at : e.user_id

    logger.debug(`用户 ${userId} 请求查询战绩...`)
    const userFilePath = path.join(PluginData, 'UserData.yaml')
    const allUserData = readYamlFile(userFilePath)

    let index = Number(e.msg.replace(/^#?(查询|王者)战绩\s*/, '')) || false

    let ID
    if (index > 9999) {
      ID = index
    } else {
      const userInfo = allUserData[userId]
      if (!userInfo || !userInfo.ids || !userInfo.ids.length) {
        logger.debug(`用户 ${userId} 未绑定ID`)
        await e.reply(segment.image('https://gitee.com/Tloml-Starry/resources/raw/master/resources/img/example/王者营地ID获取.png'))
        return
      }
      ID = userInfo.ids[userInfo.current]
    }

    const moreBattleListData = await ApiService.getMoreBattleList(ID)

    if (!moreBattleListData.data) { // 如果战绩数据不可用
      logger.debug(`用户 ${userId} 的战绩数据不可用，发送提示...`)
      await e.reply(`ID: ${ID}，查询失败`) // 回复用户
      return
    }

    if (moreBattleListData.data.list.length === 0) { // 如果没有战斗记录
      return e.reply(moreBattleListData.invisDes) // 回复用户
    }

    // 写入战斗列表数据
    writeJsonFile(path.join(PluginData, 'BattleList.json'), moreBattleListData.data)

    if (index && index < 9999) {
      const battleDetails = moreBattleListData.data.list[index - 1] // 获取战斗详情
      const { battleType, gameSvrId: gameSvr, relaySvrId: relaySvr, battleDetailUrl, gameSeq } = battleDetails // 解构战斗详情

      // 获取目标角色 ID
      const targetRoleId = battleDetailUrl.includes('&toAppRoleId=')
        ? battleDetailUrl.substring(battleDetailUrl.indexOf('&toAppRoleId=') + 13, battleDetailUrl.indexOf('&toGameRoleId='))
        : null

      // 获取战斗详情数据
      const battledetailData = await ApiService.getBattledetail(ID, battleType, gameSvr, relaySvr, targetRoleId, gameSeq) // 使用 getBattledetail 方法

      // 写入战斗详情数据
      writeJsonFile(path.join(PluginData, 'BattleDetails.json'), battledetailData.data)

      const { head, battle, redTeam, blueTeam, redRoles, blueRoles } = battledetailData.data // 解构战斗详情
      if (!head || !head.acntCamp) { // 如果战斗详情不完整
        return e.reply('查询失败，疑似不可查询战绩模式') // 回复用户
      }
      const myTeamColor = head.acntCamp === redTeam.acntCamp ? '红' : '蓝' // 确定我的阵营颜色
      const enemyTeamColor = myTeamColor === '红' ? '蓝' : '红' // 确定敌方阵营颜色

      const us = this.extractTeamData(myTeamColor, head, battle, redTeam, blueTeam, redRoles, blueRoles) // 提取团队数据

      const data = {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordDetails.html', // 模板文件路径
        ...us, // 团队数据
        myTeamColor, // 我的阵营颜色
        enemyTeamColor // 敌方阵营颜色
      }

      // 截图并生成战斗记录详情图像
      const inventoryImage = await puppeteer.screenshot('QueryGameRecordDetails', data)
      await e.reply(inventoryImage) // 回复用户
      return
    }

    // 处理战斗列表数据
    const data = moreBattleListData.data.list.map(item => ({
      gameTpye: item.mapName, // 游戏类型
      gameTime: item.gametime, // 游戏时间
      gameDuration: `${Math.floor(item.usedTime / 60)}分${item.usedTime % 60}秒`, // 游戏时长
      killCnt: item.killcnt, // 击杀数
      deadCnt: item.deadcnt, // 死亡数
      assistCnt: item.assistcnt, // 助攻数
      gameResult: this.getGameResult(item.gameresult), // 游戏结果
      heroIcon: item.heroIcon, // 英雄图标
      desc: item.desc, // 描述
      tags: this.getTags(item), // 标签
      gradeGame: item.gradeGame // 等级游戏
    }))

    // 截图并生成战斗记录列表图像
    const inventoryImage = await puppeteer.screenshot('QueryGameRecordList', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html', // 模板文件路径
      data, // 数据
      roleJobName: moreBattleListData.data.list[0].roleJobName, // 角色职业名称
      winningStreak: this.calculateWinningStreak(data.map(item => item.gameResult)) // 计算连胜
    })

    await e.reply(inventoryImage) // 回复用户
  }

  // 获取战斗列表的函数
  async fetchBattleList (e, ID) {
    let { OpenID, Token } = await ApiService.getPublicTokenAndOpenID() // 获取公共 Token 和 OpenID
    const body = { lastTime: 0, recommendPrivacy: 0, apiVersion: 5, friendUserId: ID, option: 0 } // 请求体

    // 发送请求获取战斗列表
    const response = await ApiService.post('/game/morebattlelist', body, {
      ssoopenid: OpenID,
      ssotoken: Token
    })

    const errorCodes = [1, -30003, '-30314', -10107, -51001]
    if (errorCodes.includes(response.returnCode)) {
      logger.debug('[王者战绩列表]获取数据失败，API返回:', JSON.stringify(response, null, 2))
      return false
    }

    return response // 返回响应
  }

  // 获取用户登录数据的函数
  async getUserLoginData (e) {
    const loginFilePath = getFilePath(e.user_id) // 获取登录文件路径
    if (!fs.existsSync(loginFilePath)) { // 如果文件不存在
      await e.reply('查询失败，公共Token失效\r且未找到您的登录信息，请先扫码登录。\r发送【#营地扫码】') // 回复用户
      return null // 返回 null
    }
    return readJsonFile(loginFilePath) // 读取并返回登录数据
  }

  // 处理详细战绩的函数
  async handleDetailedStats (e, battleDetails) {
    try {
      monitor.startTimer('fetchBattleDetails') // 开始计时
      const response = await this.fetchBattleDetails(battleDetails) // 获取战斗详情

      if (!response) { // 如果获取战斗详情失败
        return e.reply('获取战绩详情失败，请稍后重试') // 回复用户
      }

      writeJsonFile(path.join(PluginData, 'BattleDetails.json'), response.data) // 写入战斗详情数据

      const { head, battle, redTeam, blueTeam, redRoles, blueRoles } = response.data // 解构战斗详情
      if (!head?.acntCamp) { // 如果战斗详情不完整
        return e.reply('查询失败，疑似不可查询战绩模式') // 回复用户
      }

      const myTeamColor = head.acntCamp === redTeam.acntCamp ? '红' : '蓝' // 确定我的阵营颜色
      const enemyTeamColor = myTeamColor === '红' ? '蓝' : '红' // 确定敌方阵营颜色
      const data = {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordDetails.html', // 模板文件路径
        ...this.extractTeamData(myTeamColor, head, battle, redTeam, blueTeam, redRoles, blueRoles), // 提取团队数据
        myTeamColor, // 我的阵营颜色
        enemyTeamColor // 敌方阵营颜色
      }

      // 截图并生成战斗记录详情图像
      const image = await puppeteer.screenshot('QueryGameRecordDetails', data)
      await e.reply(image) // 回复用户
    } catch (error) {
      return e.reply('处理战绩详情时发生错误，请稍后重试') // 回复用户
    }
  }

  // 提取团队数据的函数
  extractTeamData (myTeamColor, head, battle, redTeam, blueTeam, redRoles, blueRoles) {
    const isBlue = myTeamColor === '蓝' // 检查是否为蓝队
    const myTeam = isBlue ? blueTeam : redTeam // 确定我的团队
    const enemyTeam = isBlue ? redTeam : blueTeam // 确定敌方团队
    const myRoles = isBlue ? blueRoles : redRoles // 确定我的角色
    const enemyRoles = isBlue ? redRoles : blueRoles // 确定敌方角色

    return {
      gameResult: head.gameResult ? '胜利' : '失败', // 游戏结果
      gameResultEn: head.gameResult ? 'VICTORY' : 'DEFEAT', // 英文游戏结果
      tips: head.tips, // 提示信息
      mapName: head.mapName, // 地图名称
      startTime: battle.startTime, // 开始时间
      usedTime: Math.floor(battle.usedTime / 60), // 使用时间（分钟）
      matchDesc: head.matchDesc, // 匹配描述
      myEconomyRate: (myTeam.money / (myTeam.money + enemyTeam.money)) * 100, // 经济比率
      myMoney: myTeam.money > 1000 ? `${(myTeam.money / 1000).toFixed(1)}k` : myTeam.money, // 我的经济
      myTowerCnt: myTeam.towerCnt, // 我的塔数
      enemyMoney: enemyTeam.money > 1000 ? `${(enemyTeam.money / 1000).toFixed(1)}k` : enemyTeam.money, // 敌方经济
      enemyTowerCnt: enemyTeam.towerCnt, // 敌方塔数
      myBdragon1: myTeam.bdragon1, // 我的 B 龙
      myBdragon2: myTeam.bdragon2, // 我的 B 龙
      myBdragon3: myTeam.bdragon3, // 我的 B 龙
      myLdragon1: myTeam.ldragon1, // 我的 L 龙
      myLdragon2: myTeam.ldragon2, // 我的 L 龙
      enemyBdragon1: enemyTeam.bdragon1, // 敌方 B 龙
      enemyBdragon2: enemyTeam.bdragon2, // 敌方 B 龙
      enemyBdragon3: enemyTeam.bdragon3, // 敌方 B 龙
      enemyLdragon1: enemyTeam.ldragon1, // 敌方 L 龙
      enemyLdragon2: enemyTeam.ldragon2, // 敌方 L 龙
      myKillDeadAssistCnt: `${myTeam.killCnt}/${myTeam.deadCnt}/${myTeam.assistCnt}`, // 我的击杀/死亡/助攻数
      enemyKillDeadAssistCnt: `${enemyTeam.killCnt}/${enemyTeam.deadCnt}/${enemyTeam.assistCnt}`, // 敌方击杀/死亡/助攻数
      myRoles, // 我的角色
      enemyRoles // 敌方角色
    }
  }

  // 获取游戏结果的函数
  getGameResult (result) {
    return result === 1 ? '胜利' : result === 2 ? '失败' : result // 返回游戏结果
  }

  // 获取标签的函数
  getTags (item) {
    const tags = [] // 初始化标签数组
    const descTags = ['实力局', '翻盘局', '暴走局', '尽力局'] // 描述标签
    const evaluateTags = { // 评价标签
      'https://camp.qq.com/battle/common/evaluateV3/gold_warrior.png': '金牌战士',
      'https://camp.qq.com/battle/common/evaluateV3/gold_mage.png': '金牌法师',
      'https://camp.qq.com/battle/common/evaluateV3/gold_support.png': '金牌辅助',
      'https://camp.qq.com/battle/common/evaluateV3/silver_warrior.png': '银牌战士',
      'https://camp.qq.com/battle/common/evaluateV3/silver_mage.png': '银牌法师',
      'https://camp.qq.com/battle/common/evaluateV3/silver_support.png': '银牌辅助'
    }
    const mvpTags = ['https://camp.qq.com/battle/common/mvpV3/svp.png', 'https://camp.qq.com/battle/common/mvpV3/mvp.png'] // MVP 标签

    if (descTags.includes(item.desc)) tags.push(item.desc) // 如果包含描述标签，添加到标签数组
    if (evaluateTags[item.evaluateUrlV2]) tags.push(evaluateTags[item.evaluateUrlV2]) // 如果包含评价标签，添加到标签数组
    if (mvpTags.includes(item.mvpUrlV2)) tags.push('MVP') // 如果包含 MVP 标签，添加到标签数组

    return tags // 返回标签数组
  }

  // 计算连胜的函数
  calculateWinningStreak (results) {
    let maxStreak = 0 // 最大连胜
    let currentStreak = 0 // 当前连胜

    for (let result of results) { // 遍历结果
      if (result === '失败') { // 如果结果为失败
        break // 结束循环
      }
      if (result === '胜利') { // 如果结果为胜利
        currentStreak++ // 当前连胜加一
        if (currentStreak > maxStreak) { // 如果当前连胜大于最大连胜
          maxStreak = currentStreak // 更新最大连胜
        }
      }
    }

    return maxStreak // 返回最大连胜
  }

  // 处理战斗列表的函数
  async handleBattleList (e, battleData) {
    const data = battleData.list.map(item => ({ // 处理战斗数据
      gameTpye: item.mapName, // 游戏类型
      gameTime: item.gametime, // 游戏时间
      gameDuration: `${Math.floor(item.usedTime / 60)}分${item.usedTime % 60}秒`, // 游戏时长
      killCnt: item.killcnt, // 击杀数
      deadCnt: item.deadcnt, // 死亡数
      assistCnt: item.assistcnt, // 助攻数
      gameResult: this.getGameResult(item.gameresult), // 游戏结果
      heroIcon: item.heroIcon, // 英雄图标
      desc: item.desc, // 描述
      tags: this.getTags(item), // 标签
      gradeGame: item.gradeGame // 等级游戏
    }))

    // 截图并生成战斗记录列表图像
    const image = await puppeteer.screenshot('QueryGameRecordList', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html', // 模板文件路径
      data, // 数据
      roleJobName: battleData.list[0].roleJobName, // 角色职业名称
      winningStreak: this.calculateWinningStreak(data.map(item => item.gameResult)) // 计算连胜
    })

    await e.reply(image) // 回复用户
  }

  // 获取战斗详情的函数
  async fetchBattleDetails (battleDetails) {
    try {
      const { OpenID, Token } = await ApiService.getPublicTokenAndOpenID() // 获取公共 Token 和 OpenID
      const body = {
        gameSeq: battleDetails.gameSeq, // 游戏序列号
        battleType: battleDetails.battleType, // 战斗类型
        gameSvr: battleDetails.gameSvrId, // 游戏服务器 ID
        relaySvr: battleDetails.relaySvrId, // 中继服务器 ID
        recommendPrivacy: 0, // 推荐隐私设置
        apiVersion: 5 // API 版本
      }

      // 获取目标角色 ID
      if (battleDetails.battleDetailUrl?.includes('&toAppRoleId=')) {
        body.targetRoleId = battleDetails.battleDetailUrl.substring(
          battleDetails.battleDetailUrl.indexOf('&toAppRoleId=') + 13,
          battleDetails.battleDetailUrl.indexOf('&toGameRoleId=')
        )
      }

      // 发送请求获取战斗详情
      const response = await ApiService.post('/game/battledetail', body, {
        ssoopenid: OpenID,
        ssotoken: Token
      })

      const errorCodes = [1, -30003, '-30314', -10107, -51001]
      if (errorCodes.includes(response.returnCode)) {
        logger.debug('[王者战绩详情]获取数据失败，API返回:', JSON.stringify(response, null, 2))
        return false
      }

      // 定义默认数据
      const defaultData = {
        head: {
          acntCamp: 1, // 账户阵营
          gameResult: 0, // 游戏结果
          tips: '', // 提示信息
          mapName: '王者峡谷', // 地图名称
          matchDesc: '排位赛' // 匹配描述
        },
        battle: {
          startTime: new Date().toISOString(), // 开始时间
          usedTime: 0 // 使用时间
        },
        redTeam: {
          acntCamp: 1, // 红队阵营
          money: 0, // 红队经济
          towerCnt: 0, // 红队塔数
          killCnt: 0, // 红队击杀数
          deadCnt: 0, // 红队死亡数
          assistCnt: 0, // 红队助攻数
          bdragon1: 0, // 红队 B 龙
          bdragon2: 0, // 红队 B 龙
          bdragon3: 0, // 红队 B 龙
          ldragon1: 0, // 红队 L 龙
          ldragon2: 0 // 红队 L 龙
        },
        blueTeam: {
          acntCamp: 2, // 蓝队阵营
          money: 0, // 蓝队经济
          towerCnt: 0, // 蓝队塔数
          killCnt: 0, // 蓝队击杀数
          deadCnt: 0, // 蓝队死亡数
          assistCnt: 0, // 蓝队助攻数
          bdragon1: 0, // 蓝队 B 龙
          bdragon2: 0, // 蓝队 B 龙
          bdragon3: 0, // 蓝队 B 龙
          ldragon1: 0, // 蓝队 L 龙
          ldragon2: 0 // 蓝队 L 龙
        },
        redRoles: [], // 红队角色
        blueRoles: [] // 蓝队角色
      }

      // 合并默认数据和响应数据
      response.data = {
        ...defaultData,
        ...response.data,
        head: { ...defaultData.head, ...response.data?.head },
        battle: { ...defaultData.battle, ...response.data?.battle },
        redTeam: { ...defaultData.redTeam, ...response.data?.redTeam },
        blueTeam: { ...defaultData.blueTeam, ...response.data?.blueTeam },
        redRoles: response.data?.redRoles || [], // 红队角色
        blueRoles: response.data?.blueRoles || [] // 蓝队角色
      }

      return response // 返回响应
    } catch (error) {
      return null // 返回 null
    }
  }

  // 新增：验证战斗列表响应
  validateBattleList (response) {
    if (!response?.data?.list?.length) return false
    return true
  }

  // 新增：检查是否为新战斗
  async isNewBattle (userId, latestBattle) {
    try {
      const lastBattleFile = path.join(PluginData, `lastBattle_${userId}.json`)
      if (!fs.existsSync(lastBattleFile)) return true

      const lastBattle = readJsonFile(lastBattleFile)
      return lastBattle.gameSeq !== latestBattle.gameSeq
    } catch (error) {
      logger.error(`检查新战斗时发生错误 (用户 ${userId}):`, error)
      return false
    }
  }

  // 新增：更新最后一场战斗记录
  async updateLastBattle (userId, battle) {
    try {
      const lastBattleFile = path.join(PluginData, `lastBattle_${userId}.json`)
      writeJsonFile(lastBattleFile, battle)
    } catch (error) {
      logger.error(`更新最后战斗记录时发生错误 (用户 ${userId}):`, error)
    }
  }

  // 新增：获取玩家昵称
  getPlayerName (head, redRoles, blueRoles, battleDetails) {
    try {
      // 1. 首先尝试从 analyseUrl 获取昵称
      if (battleDetails?.analyseUrl) {
        const roleNameMatch = battleDetails.analyseUrl.match(/roleName=([^&]+)/)
        if (roleNameMatch) {
          return decodeURIComponent(roleNameMatch[1])
        }
      }

      // 2. 如果没有 analyseUrl,则从阵营和角色列表获取
      const playerCamp = head?.acntCamp
      if (!playerCamp) return '玩家'

      const allRoles = [...redRoles, ...blueRoles]
      const playerRole = allRoles.find(role => role.acntCamp === playerCamp)

      return playerRole?.name || '玩家'
    } catch (error) {
      logger.error('获取玩家昵称失败:', error)
      return '玩家'
    }
  }
}
