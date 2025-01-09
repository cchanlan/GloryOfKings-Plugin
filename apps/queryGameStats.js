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

  // 新增方法：加载用户数据和设置数据
  async loadUserDataAndSettings() {
    const { userFilePath, settingsFilePath } = {
      userFilePath: path.join(PluginData, 'UserData.yaml'), // 用户数据文件路径
      settingsFilePath: path.join(PluginData, 'gameStatsPushSettings.yaml') // 设置文件路径
    }

    // 读取用户数据和设置数据
    const { userData, settingsData } = {
      userData: readYamlFile(userFilePath), // 读取用户数据
      settingsData: readYamlFile(settingsFilePath) // 读取设置数据
    }

    return { userData, settingsData };
  }

  // 新增方法：发送消息到群组
  async sendGroupMessage(groupId, playerName, image) {
    if (groupId) { // 如果群组 ID 存在
      Bot.pickGroup(groupId).sendMsg([
        `${playerName} 的最新战绩`, // 消息内容
        image // 附加的图像
      ]);
    }
  }

  // 新增方法：处理战斗记录
  async processBattleRecord(userId, ID, latestBattle) {
    const { settingsData } = await this.loadUserDataAndSettings(); // 获取设置数据
    const response2 = await this.fetchBattleDetails(latestBattle, { user_id: userId }); // 获取战斗详情
    
    if (!response2 || !response2.data) { // 如果获取战斗详情失败
      return; // 跳过该用户
    }

    const { head, battle, redTeam, blueTeam, redRoles, blueRoles } = response2.data; // 解构战斗详情
    
    if (!head || !battle || !redTeam || !blueTeam || !redRoles || !blueRoles) { // 如果战斗详情不完整
      return; // 跳过该用户
    }

    if (!head.acntCamp) { // 如果没有账户阵营信息
      return; // 跳过该用户
    }

    // 检查用户的阵营是否与战斗阵营匹配
    if (head.acntCamp !== redTeam.acntCamp && head.acntCamp !== blueTeam.acntCamp) {
      return; // 跳过该用户
    }

    const myTeamColor = head.acntCamp === redTeam.acntCamp ? '红' : '蓝'; // 确定我的阵营颜色
    const enemyTeamColor = myTeamColor === '红' ? '蓝' : '红'; // 确定敌方阵营颜色
    const data = {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordDetails.html', // 模板文件路径
      ...this.extractTeamData(myTeamColor, head, battle, redTeam, blueTeam, redRoles, blueRoles), // 提取团队数据
      myTeamColor, // 我的阵营颜色
      enemyTeamColor // 敌方阵营颜色
    };

    // 截图并生成战斗记录详情图像
    const image = await puppeteer.screenshot('QueryGameRecordDetails', data);
    const groupId = settingsData[userId]; // 获取用户的群组 ID
    const playerTeam = myTeamColor === '红' ? redRoles : blueRoles; // 获取玩家所在的团队角色
    const playerRole = playerTeam.find(role => role.acntCamp === head.acntCamp); // 查找玩家角色
    const playerName = playerRole?.name || '玩家'; // 获取玩家名称

    // 发送消息到群组
    await this.sendGroupMessage(groupId, playerName, image);
  }

  // 更新推送战绩的函数
  async pushGameStats() {
    try {
      console.debug('开始推送战绩...');
      const { userData, settingsData } = await this.loadUserDataAndSettings(); // 加载用户数据和设置数据

      // 遍历设置数据中的用户 ID
      for (const userId of Object.keys(settingsData)) {
        if (!settingsData[userId]) { // 如果用户未开启推送
          console.debug(`用户 ${userId} 未开启战绩推送，跳过...`);
          continue; // 跳过该用户
        }

        const ID = userData[userId]; // 获取用户 ID
        if (!ID) { // 如果用户 ID 未找到
          console.debug(`用户 ${userId} 的 ID 未找到，跳过...`); 
          continue; // 跳过该用户
        }
        
        // 获取用户的战斗列表
        let response = await this.fetchBattleList({ user_id: userId }, ID);
        
        // 如果没有新的战斗记录
        if (!response || !response.data || !response.data.list || response.data.list.length === 0) {
          console.debug(`用户 ${userId} 没有新的战斗记录，跳过...`);
          continue; // 跳过该用户
        }

        const latestBattle = response.data.list[0]; // 获取最新的战斗记录
        const lastBattleFile = path.join(PluginData, 'lastBattle', `${userId}.json`);
        let lastBattle = {}; // 初始化上一次战斗记录
        if (fs.existsSync(lastBattleFile)) { // 如果文件存在
          lastBattle = readJsonFile(lastBattleFile); // 读取上一次战斗记录
        }

        // 如果最新战斗记录的序列号与上一次相同，跳过
        if (lastBattle.gameSeq === latestBattle.gameSeq) {
          continue;
        }

        // 处理战斗记录
        await this.processBattleRecord(userId, ID, latestBattle);

        // 如果上一次战斗记录文件夹不存在，则创建
        if (!fs.existsSync(path.join(PluginData, 'lastBattle'))) {
          fs.mkdirSync(path.join(PluginData, 'lastBattle'), { recursive: true }); // 创建文件夹
        }
        // 写入最新战斗记录
        writeJsonFile(lastBattleFile, {
          gameSeq: latestBattle.gameSeq, // 最新战斗序列号
          timestamp: Date.now() // 当前时间戳
        });
      }
    } catch (error) {
      console.error('推送战绩时发生错误:', error);
    }
  }

  // 切换战绩推送状态的函数
  async toggleGameStatsPush(e) {
    let userId = e.user_id // 获取用户 ID
    let groupId = e.group_id // 获取群组 ID
    const { isGroup } = e // 检查是否为群组消息
    if (!isGroup) return false // 如果不是群组消息，返回

    console.debug(`用户 ${userId} 请求切换战绩推送状态...`);

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

    if (!userData[userId]) { // 如果用户 ID 未找到
      console.debug(`用户 ${userId} 的 ID 未找到，发送提示...`);
      await e.reply(segment.image('https://gitee.com/Tloml-Starry/resources/raw/master/resources/img/example/王者营地ID获取.png')) // 发送提示图像
      return
    }

    const isEnabled = /^#开启/.test(e.msg) // 检查是否开启推送
    settingsData[userId] = isEnabled ? groupId : null // 更新设置数据

    fs.writeFileSync(settingsFilePath, JSON.stringify(settingsData, null, 2)) // 写入设置文件
    await e.reply(`战绩推送已${isEnabled ? '开启' : '关闭'}。`) // 回复用户
    console.debug(`用户 ${userId} 的战绩推送状态已${isEnabled ? '开启' : '关闭'}`);
  }

  // 查询战绩的函数
  async queryGameStats(e) {
    console.debug(`用户 ${e.user_id} 请求查询战绩...`);
    const userFilePath = path.join(PluginData, 'UserData.yaml'); // 用户数据文件路径
    const allUserData = readYamlFile(userFilePath); // 读取所有用户数据
    const ID = allUserData[e.user_id]; // 获取用户 ID

    if (!ID) { // 如果用户 ID 未找到
      console.debug(`用户 ${e.user_id} 的 ID 未找到，发送提示...`);
      await e.reply(segment.image('https://gitee.com/Tloml-Starry/resources/raw/master/resources/img/example/王者营地ID获取.png')); // 发送提示图像
      return;
    }

    let index = Number(e.msg.match(/#查询战绩(\d+)?/)[1]) || false; // 获取查询的战绩索引

    // 获取更多战斗列表数据
    const moreBattleListData = await ApiService.getMoreBattleList(ID); // 使用 getMoreBattleList 方法

    if (!moreBattleListData.data) { // 如果战绩数据不可用
      console.debug(`用户 ${e.user_id} 的战绩数据不可用，发送提示...`);
      await e.reply(`ID: ${ID}，查询失败`); // 回复用户
      return;
    }

    if (moreBattleListData.data.list.length === 0) { // 如果没有战斗记录
      return e.reply(moreBattleListData.invisDes); // 回复用户
    }

    // 写入战斗列表数据
    writeJsonFile(path.join(PluginData, 'BattleList.json'), moreBattleListData.data);

    if (index) { // 如果索引存在
      const battleDetails = moreBattleListData.data.list[index - 1]; // 获取战斗详情
      const { battleType, gameSvrId: gameSvr, relaySvrId: relaySvr, battleDetailUrl, gameSeq } = battleDetails; // 解构战斗详情

      // 获取目标角色 ID
      const targetRoleId = battleDetailUrl.includes('&toAppRoleId=') 
        ? battleDetailUrl.substring(battleDetailUrl.indexOf('&toAppRoleId=') + 13, battleDetailUrl.indexOf('&toGameRoleId=')) 
        : null;

      // 获取战斗详情数据
      const battledetailData = await ApiService.getBattledetail(ID, battleType, gameSvr, relaySvr, targetRoleId, gameSeq); // 使用 getBattledetail 方法

      // 写入战斗详情数据
      writeJsonFile(path.join(PluginData, 'BattleDetails.json'), battledetailData.data);

      const { head, battle, redTeam, blueTeam, redRoles, blueRoles } = battledetailData.data; // 解构战斗详情
      if (!head || !head.acntCamp) { // 如果战斗详情不完整
        return e.reply('查询失败，疑似不可查询战绩模式'); // 回复用户
      }
      const myTeamColor = head.acntCamp === redTeam.acntCamp ? '红' : '蓝'; // 确定我的阵营颜色
      const enemyTeamColor = myTeamColor === '红' ? '蓝' : '红'; // 确定敌方阵营颜色

      const us = this.extractTeamData(myTeamColor, head, battle, redTeam, blueTeam, redRoles, blueRoles); // 提取团队数据

      const data = {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordDetails.html', // 模板文件路径
        ...us, // 团队数据
        myTeamColor, // 我的阵营颜色
        enemyTeamColor // 敌方阵营颜色
      };

      // 截图并生成战斗记录详情图像
      const inventoryImage = await puppeteer.screenshot('QueryGameRecordDetails', data);
      await e.reply(inventoryImage); // 回复用户
      return;
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
    }));

    // 截图并生成战斗记录列表图像
    const inventoryImage = await puppeteer.screenshot('QueryGameRecordList', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html', // 模板文件路径
      data, // 数据
      roleJobName: moreBattleListData.data.list[0].roleJobName, // 角色职业名称
      winningStreak: this.calculateWinningStreak(data.map(item => item.gameResult)) // 计算连胜
    });

    await e.reply(inventoryImage); // 回复用户
  }

  // 获取战斗列表的函数
  async fetchBattleList(e, ID) {
    let { OpenID, Token } = await ApiService.getPublicTokenAndOpenID() // 获取公共 Token 和 OpenID
    const body = { lastTime: 0, recommendPrivacy: 0, apiVersion: 5, friendUserId: ID, option: 0 } // 请求体

    // 发送请求获取战斗列表
    let response = await ApiService.post('/game/morebattlelist', body, {
      ssoopenid: OpenID,
      ssotoken: Token
    })

    if (response.returnCode === -30003) { // 如果登录状态失效
      const loginData = await this.getUserLoginData(e) // 获取用户登录数据
      if (!loginData) return null // 如果未找到登录数据，返回 null

      // 重新发送请求获取战斗列表
      response = await ApiService.post('/game/morebattlelist', body, {
        ssoopenid: loginData.ssoOpenId,
        ssotoken: loginData.ssoToken
      })

      if (response.returnCode === -30003) { // 如果登录状态仍然失效
        await e.reply('登录状态失效，请重新扫码登录') // 回复用户
        return null // 返回 null
      }
    }

    return response // 返回响应
  }

  // 获取用户登录数据的函数
  async getUserLoginData(e) {
    const loginFilePath = getFilePath(e.user_id) // 获取登录文件路径
    if (!fs.existsSync(loginFilePath)) { // 如果文件不存在
      await e.reply('查询失败，公共Token失效\r且未找到您的登录信息，请先扫码登录。\r发送【#营地扫码】') // 回复用户
      return null // 返回 null
    }
    return readJsonFile(loginFilePath) // 读取并返回登录数据
  }

  // 处理详细战绩的函数
  async handleDetailedStats(e, battleDetails) {
    try {
      monitor.startTimer('fetchBattleDetails') // 开始计时
      const response = await this.fetchBattleDetails(battleDetails, e) // 获取战斗详情
      const duration = monitor.endTimer('fetchBattleDetails') // 结束计时

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
  extractTeamData(myTeamColor, head, battle, redTeam, blueTeam, redRoles, blueRoles) {
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
  getGameResult(result) {
    return result === 1 ? '胜利' : result === 2 ? '失败' : result // 返回游戏结果
  }

  // 获取标签的函数
  getTags(item) {
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
  calculateWinningStreak(results) {
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
  async handleBattleList(e, battleData) {
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
  async fetchBattleDetails(battleDetails, e) {
    try {
      let { OpenID, Token } = await ApiService.getPublicTokenAndOpenID() // 获取公共 Token 和 OpenID
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
      let response = await ApiService.post('/game/battledetail', body, {
        ssoopenid: OpenID,
        ssotoken: Token
      })

      if (response.returnCode === -30003) { // 如果登录状态失效
        const loginData = await this.getUserLoginData(e) // 获取用户登录数据
        if (!loginData) return null // 如果未找到登录数据，返回 null

        // 重新发送请求获取战斗详情
        response = await ApiService.post('/game/battledetail', body, {
          ssoopenid: loginData.ssoOpenId,
          ssotoken: loginData.ssoToken
        })

        if (response.returnCode === -30003) { // 如果登录状态仍然失效
          await e.reply('登录状态失效，请重新扫码登录') // 回复用户
          return null // 返回 null
        }
      }

      if (response.returnCode !== 0) { // 如果返回码不为 0
        return null // 返回 null
      }

      if (!response || !response.data) { // 如果响应数据不完整
        return null // 返回 null
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
}