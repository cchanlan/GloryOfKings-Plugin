import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ApiService, readJsonFile, writeJsonFile, readYamlFile } from '#utils'
import path from 'path'
import fs from 'fs'
import { PluginData, Config } from '#components'
import moment from 'moment'

const { onlineReminderCron, onlineReminder } = Config.getConfig('config')

export class MyKingHomepage extends plugin {
  constructor () {
    super({
      name: 'myKingHomepage',
      dsc: '王者主页',
      event: 'message',
      priority: 1,
      rule: [
        {
          reg: '^#王者(主页|卡片|信息)\\s*(.*)$',
          fnc: 'myKingHomepage'
        },
        {
          reg: /^#(开启|关闭)上下线提醒$/,
          fnc: 'toggleOnlineReminder'
        }
      ]
    })
    if (onlineReminder) {
      this.task = {
        name: '[定时任务]王者上下线提醒',
        fnc: () => this.onlineReminder(),
        cron: onlineReminderCron,
        log: false
      }
    }
  }

  async onlineReminder () {
    const { userFilePath, settingsFilePath } = {
      userFilePath: path.join(PluginData, 'UserData.yaml'),
      settingsFilePath: path.join(PluginData, 'user_settings.yaml')
    }

    const { userData, settingsData } = {
      userData: readYamlFile(userFilePath),
      settingsData: readYamlFile(settingsFilePath)
    }

    for (const user of Object.keys(settingsData)) {
      const userInfo = userData[user]
      if (!userInfo || !userInfo.ids || !userInfo.ids.length) continue

      const ID = userInfo.ids[userInfo.current]
      const settingsUserFilePath = path.join(PluginData, 'user_settings', `${user}.json`)

      const { OpenID, Token } = await ApiService.getPublicTokenAndOpenID()

      const response = await this.fetchUserProfile(ID, OpenID, Token)
      if (!response) continue

      const { profile, roleCard } = response.data

      if (!fs.existsSync(settingsUserFilePath)) {
        writeJsonFile(settingsUserFilePath, { gameOnline: roleCard.gameOnline })
      }
      const { gameOnline } = readJsonFile(settingsUserFilePath)
      if (gameOnline === roleCard.gameOnline) continue

      writeJsonFile(settingsUserFilePath, { gameOnline: roleCard.gameOnline })

      const inventoryImage = await puppeteer.screenshot('MyKingHomepageTask', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/MyKingHomepageTask.html',
        IP: profile.ipProperty,
        roleIcon: roleCard.roleBigIcon,
        roleName: roleCard.roleName,
        gameLevel: roleCard.level,
        gameOnline: roleCard.gameOnline,
        roleJobName: `${roleCard.roleJobName} ${roleCard.rankingStar}星`,
        areaName: roleCard.areaName,
        roleText: roleCard.serverName,
        flagImg: roleCard.flagImg,
        roleJobIcon: roleCard.roleJobIcon,
        content_1: roleCard.fightPowerItem.value1,
        content_2: roleCard.mvpNumItem.value1,
        content_3: roleCard.totalBattleCountItem.value1,
        content_4: `${roleCard.heroNumItem.value1}/${roleCard.heroNumItem.value2}`,
        content_5: roleCard.winRateItem.value1,
        content_6: `${roleCard.skinNumItem.value1}/${roleCard.skinNumItem.value2}`
      })

      Bot.pickGroup(settingsData[user]).sendMsg([`${roleCard.roleName} ${roleCard.gameOnline === 1 ? '登录了' : '下线了'}`, inventoryImage])
    }
  }

  async toggleOnlineReminder (e) {
    let userId = (e.at && e.isMaster) ? e.at : e.user_id
    let groupId = e.group_id
    if (!e.isGroup) return e.reply('只支持群聊中使用', true)

    const { userFilePath, settingsFilePath } = {
      userFilePath: path.join(PluginData, 'UserData.yaml'),
      settingsFilePath: path.join(PluginData, 'user_settings.yaml')
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
    await e.reply(`用户${userId}的上下线提醒已${isEnabled ? '开启' : '关闭'}。`)
  }

  async myKingHomepage (e) {
    const msg = e.msg.replace(/^#王者(主页|卡片|信息)\s*/, '')
    let userId = e.at || e.user_id
    const userFilePath = path.join(PluginData, 'UserData.yaml')

    const allUserData = readYamlFile(userFilePath)
    const userInfo = allUserData[userId]

    if (!userInfo || !userInfo.ids || !userInfo.ids.length) {
      await e.reply(segment.image('https://gitee.com/Tloml-Starry/resources/raw/master/resources/img/example/王者营地ID获取.png'))
      return
    }

    const ID = msg || userInfo.ids[userInfo.current]

    const profileData = await ApiService.getProfile(ID)

    if (profileData.returnCode === -30107) {
      await e.reply('获取数据失败,请稍后重试')
      return
    }

    if (profileData.returnCode === -10107) {
      await e.reply(`ID: ${ID},召唤师隐藏了主页信息，无法查看`)
    }

    if (!profileData || !profileData.data || !profileData.data.roleList) {
      console.log('获取数据失败，API返回:', JSON.stringify(profileData, null, 2))
      await e.reply('获取数据失败,请稍后重试')
      return
    }

    const { head: headData, targetRoleId } = profileData.data
    const roleData = profileData.data.roleList.find(role => role.roleId === targetRoleId)

    if (!roleData) {
      await e.reply('未找到角色数据')
      return
    }

    const { mods } = headData
    console.log(mods)
    const {
      roleName, // 昵称
      roleIcon, // 头像
      gameLevel, // 等级
      gameOnline: _gameOnline, // 在线状态 【1:在线 0:离线】
      areaName, // 分区
      roleText, // 区服
      onlineTime: onlineTimestamp, // 最近一次上线
      offlineTime: offlineTimestamp // 最近一次离线
    } = roleData
    const gameOnlineMap = {
      0: '离线',
      1: '在线',
      2: '游戏中'
    }
    const gameOnline = gameOnlineMap[_gameOnline]
    const onlineTime = moment(onlineTimestamp * 1000).locale('zh-cn').calendar()
    const offlineTime = moment(offlineTimestamp * 1000).locale('zh-cn').calendar()
    const [
      mode10v10, // 10v10模式
      mode5v5, // 5v5模式
      modePeakRace // 巅峰赛
    ] = mods
    modePeakRace.param1 = JSON.parse(modePeakRace.param1)
    modePeakRace.param1.flagPag = modePeakRace.param1.flagPag.match(/(\d+).pag/)[1]
    console.log(modePeakRace.param1)
    const mod = mods.filter(i => i.stype === 0)
    const combat = mods.find(i => i.stype === 1)
    const { rankingStar, starImg } = JSON.parse(mode5v5.param1)
    const rank10v10 = `${mode10v10.name} ${JSON.parse(mode10v10.param1).rankingStar}星`
    const rank5v5 = `${mode5v5.name} ${rankingStar}星`
    const rankIcon = mode5v5.icon
    // 默认为4 王者后都不再处理
    let flagImg = '4'
    if (rank5v5.includes('青铜') || rank5v5.includes('白银') || rank5v5.includes('黄金') || rank5v5.includes('铂金')) flagImg = '1'
    if (rank5v5.includes('钻石') || rank5v5.includes('星耀')) flagImg = '2'
    if (rank5v5.includes('最强王者')) flagImg = '3'

    const isKing = rank5v5.includes('王者')
    const isOffline = gameOnline === '离线'
    const honor = isKing ? 'honor' : 'roleJob'
    const data = {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/MyKingHomepage.html',
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      roleIcon,
      roleName,
      gameLevel,
      gameOnline,
      rank10v10,
      rank5v5,
      areaName,
      roleText,
      flagImg,
      rankIcon,
      onlineTime,
      offlineTime,
      rankingStar,
      starImg,
      isKing,
      isOffline,
      honor,
      content_7: modePeakRace.content,
      modePeakRace,

      mod,
      combat
    }

    const inventoryImage = await puppeteer.screenshot('myKingHomepage', data)

    await e.reply(inventoryImage)
  }

  async fetchUserProfile (ID, OpenID, Token) {
    try {
      const response = await ApiService.post('/userprofile/profile', {
        lastTime: 0,
        recommendPrivacy: 0,
        apiVersion: 5,
        friendUserId: ID,
        option: 0
      }, {
        ssoopenid: OpenID,
        ssotoken: Token
      })

      logger.debug('[王者上下线提醒]获取数据成功，API返回:', JSON.stringify(response, null, 2))

      const errorCodes = [1, -30003, '-30314', -10107, -51001]
      if (errorCodes.includes(response.returnCode)) {
        logger.debug('[王者上下线提醒]获取数据失败，API返回:', JSON.stringify(response, null, 2))
        return false
      }

      return response
    } catch (error) {
      console.error('Error fetching user profile:', error)
      return false
    }
  }
}
