import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ApiService, readJsonFile, getFilePath, writeJsonFile, readYamlFile } from '#utils'
import path from 'path'
import fs from 'fs'
import { PluginData, Config } from '#components'

const { onlineReminderCron, onlineReminder } = Config.getConfig('config')

export class MyKingHomepage extends plugin {
  constructor() {
    super({
      name: 'myKingHomepage',
      dsc: '王者主页',
      event: 'message',
      priority: 1,
      rule: [
        {
          reg: /^#王者主页$/,
          fnc: 'myKingHomepage'
        },
        {
          reg: /#(开启|关闭)上下线提醒$/,
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

  async onlineReminder() {
    const { userFilePath, settingsFilePath } = {
      userFilePath: path.join(PluginData, 'UserData.yaml'),
      settingsFilePath: path.join(PluginData, 'user_settings.yaml')
    }

    const { userData, settingsData } = {
      userData: readYamlFile(userFilePath),
      settingsData: readYamlFile(settingsFilePath)
    }

    for (const user of Object.keys(settingsData)) {
      if (!settingsData[user]) continue

      const ID = userData[user]
      const settingsUserFilePath = path.join(PluginData, 'user_settings', `${user}.json`)

      const profileData = await ApiService.getProfile(ID)
      if (!profileData) continue

      const { head: headData, targetRoleId } = profileData.data
      const roleData = profileData.data.roleList.find(role => role.roleId === targetRoleId)
      const { mods } = headData
      const {
        roleName,
        roleIcon,
        gameLevel,
        gameOnline,
        areaName,
        roleText,
        onlineTime: onlineTimestamp,
        offlineTime: offlineTimestamp,
      } = roleData

      const [
        mode10v10,
        mode5v5,
        modePeakRace,
        fightPowerItem,
        mvpNumItem,
        totalBattleCountItem,
        heroNumItem,
        winRateItem,
        skinNumItem,
      ] = mods

      if (!fs.existsSync(settingsUserFilePath)) {
        writeJsonFile(settingsUserFilePath, { 
          gameOnline,
          lastOnlineTime: onlineTimestamp,
          lastOfflineTime: offlineTimestamp
        })
        continue
      }

      const savedData = readJsonFile(settingsUserFilePath)
      const currentTime = Math.floor(Date.now() / 1000)

      if (savedData.gameOnline === gameOnline) {
        const timeThreshold = 24 * 60 * 60 // 24小时的秒数
        const timeDiff = currentTime - (gameOnline ? onlineTimestamp : offlineTimestamp)
        
        if (timeDiff > timeThreshold) {
          const timeString = new Date((gameOnline ? onlineTimestamp : offlineTimestamp) * 1000)
            .toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
          
          Bot.pickGroup(settingsData[user]).sendMsg([
            `${roleName} ${gameOnline ? '已在线' : '已离线'}超过24小时\n上次${gameOnline ? '上线' : '离线'}时间：${timeString}`
          ])
        }
        continue
      }

      writeJsonFile(settingsUserFilePath, { 
        gameOnline,
        lastOnlineTime: onlineTimestamp,
        lastOfflineTime: offlineTimestamp
      })

      const rank10v10 = `${mode10v10.name} ${JSON.parse(mode10v10.param1).rankingStar}星`
      const rank5v5 = `${mode5v5.name} ${JSON.parse(mode5v5.param1).rankingStar}星`
      const rankIcon = mode5v5.icon

      let flagImg = ''
      if (rank5v5.includes('青铜') || rank5v5.includes('白银') || rank5v5.includes('黄金')) flagImg = 'https://camp.qq.com/battle/profile/flagV2/1.png'
      if (rank5v5.includes('钻石') || rank5v5.includes('星耀')) flagImg = 'https://camp.qq.com/battle/profile/flagV2/2.png'
      if (rank5v5.includes('最强王者')) flagImg = 'https://camp.qq.com/battle/profile/flagV2/3.png'

      function formatDate(timestamp) {
        return new Date(timestamp * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      }

      const onlineTime = formatDate(onlineTimestamp)
      const offlineTime = formatDate(offlineTimestamp)

      const inventoryImage = await puppeteer.screenshot('myKingHomepage', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/MyKingHomepage.html',
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
        content_1: fightPowerItem.content,
        content_2: mvpNumItem.content,
        content_3: totalBattleCountItem.content,
        content_4: heroNumItem.content,
        content_5: winRateItem.content,
        content_6: skinNumItem.content,
        content_7: modePeakRace.content
      })

      Bot.pickGroup(settingsData[user]).sendMsg([
        `${roleName} ${gameOnline === 1 ? '登录了' : '下线了'}`, 
        inventoryImage
      ])
    }
  }

  async toggleOnlineReminder(e) {
    let userId = e.user_id
    let groupId = e.group_id
    const { isGroup } = e
    if (!isGroup) return false

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
    await e.reply(`上下线提醒已${isEnabled ? '开启' : '关闭'}。`)
  }

  async myKingHomepage(e) {
    let userId = e.user_id
    const userFilePath = path.join(PluginData, 'UserData.yaml')

    const allUserData = readYamlFile(userFilePath)
    const ID = allUserData[userId]

    if (!ID) {
      await e.reply(segment.image('https://gitee.com/Tloml-Starry/resources/raw/master/resources/img/example/王者营地ID获取.png'))
      return
    }

    const profileData = await ApiService.getProfile(ID)
    const { head: headData, targetRoleId } = profileData.data
    const roleData = profileData.data.roleList.find(role => role.roleId === targetRoleId)
    const { mods } = headData
    const {
      roleName, // 昵称
      roleIcon, // 头像
      gameLevel, // 等级
      gameOnline, // 在线状态 【1:在线 0:离线】
      areaName, // 分区
      roleText, // 区服
      onlineTime: onlineTimestamp, // 最近一次上线
      offlineTime: offlineTimestamp, // 最近一次离线
    } = roleData

    const onlineTime = new Date(onlineTimestamp * 1000).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/^\d{4}\/?/, ''); // 转换为日期加时分秒格式，不显示年份
    const offlineTime = new Date(offlineTimestamp * 1000).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(/^\d{4}\/?/, ''); // 转换为日期加时分秒格式，不显示年份
    const [
      mode10v10, // 10v10模式
      mode5v5, // 5v5模式
      modePeakRace, // 巅峰赛
      fightPowerItem, // 战斗力
      mvpNumItem, // MVP次数
      totalBattleCountItem, // 总场次
      heroNumItem, // 英雄数量
      winRateItem, // 胜率
      skinNumItem, // 皮肤数量
    ] = mods

    const rank10v10 = `${mode10v10.name} ${JSON.parse(mode10v10.param1).rankingStar}星`
    const rank5v5 = `${mode5v5.name} ${JSON.parse(mode5v5.param1).rankingStar}星`
    const rankIcon = mode5v5.icon

    let flagImg = ''
    if (rank5v5.includes('青铜') || rank5v5.includes('白银') || rank5v5.includes('黄金')) flagImg = 'https://camp.qq.com/battle/profile/flagV2/1.png'
    if (rank5v5.includes('钻石') || rank5v5.includes('星耀')) flagImg = 'https://camp.qq.com/battle/profile/flagV2/2.png'
    if (rank5v5.includes('最强王者')) flagImg = 'https://camp.qq.com/battle/profile/flagV2/3.png'

    const data = {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/MyKingHomepage.html',
      roleIcon, roleName, gameLevel, gameOnline, rank10v10,
      rank5v5, areaName, roleText, flagImg, rankIcon,
      onlineTime, offlineTime,
      content_1: fightPowerItem.content,
      content_2: mvpNumItem.content,
      content_3: totalBattleCountItem.content,
      content_4: heroNumItem.content,
      content_5: winRateItem.content,
      content_6: skinNumItem.content,
      content_7: modePeakRace.content
    }

    const inventoryImage = await puppeteer.screenshot('myKingHomepage', data)

    await e.reply(inventoryImage)
  }

  async fetchUserProfile(ID, OpenID, Token, userId) {
    try {
      let response = await ApiService.post('/userprofile/profile', {
        lastTime: 0,
        recommendPrivacy: 0,
        apiVersion: 5,
        friendUserId: ID,
        option: 0
      }, {
        ssoopenid: OpenID,
        ssotoken: Token
      })

      if (response.returnCode === -30003 || response.returnCode === '-30314') {
        const loginFilePath = getFilePath(userId)
        if (!fs.existsSync(loginFilePath)) {
          return -1
        }

        const userData = readJsonFile(loginFilePath)
        const { ssoOpenId, ssoToken } = userData
        response = await ApiService.post('/userprofile/profile', {
          lastTime: 0,
          recommendPrivacy: 0,
          apiVersion: 5,
          friendUserId: ID,
          option: 0
        }, {
          ssoopenid: ssoOpenId,
          ssotoken: ssoToken
        })

        if (response.returnCode === -30003) {
          return -2
        }
      }

      return response
    } catch (error) {
      console.error('Error fetching user profile:', error)
      return null
    }
  }
}
