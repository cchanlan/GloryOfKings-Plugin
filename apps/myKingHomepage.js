import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ApiService, readJsonFile, getFilePath, writeJsonFile, readYamlFile } from '#utils'
import path from 'path'
import fs from 'fs'
import { PluginData, Config } from '#components'

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
        cron: onlineReminderCron
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
      const ID = userData[user]
      const settingsUserFilePath = path.join(PluginData, 'user_settings', `${user}.json`)

      const { OpenID, Token } = await ApiService.getPublicTokenAndOpenID()

      const response = await this.fetchUserProfile(ID, OpenID, Token, user)
      if (response === -1 || response === -2) continue

      const { profile, roleCard } = response.data

      if (!fs.existsSync(settingsUserFilePath)) {
        writeJsonFile(settingsUserFilePath, { gameOnline: roleCard.gameOnline })
      }
      const { gameOnline } = readJsonFile(settingsUserFilePath)
      if (gameOnline === roleCard.gameOnline) continue

      writeJsonFile(settingsUserFilePath, { gameOnline: roleCard.gameOnline })

      const inventoryImage = await puppeteer.screenshot('myKingHomepage', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/MyKingHomepage.html',
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

  async myKingHomepage (e) {
    let userId = e.user_id
    const userFilePath = path.join(PluginData, 'UserData.yaml')

    const allUserData = readYamlFile(userFilePath)
    const ID = allUserData[userId]

    if (!ID) {
      await e.reply(segment.image('https://gitee.com/Tloml-Starry/resources/raw/master/resources/img/example/王者营地ID获取.png'))
      return
    }

    const { OpenID, Token } = await ApiService.getPublicTokenAndOpenID()

    const response = await this.fetchUserProfile(ID, OpenID, Token, userId)

    if (response === -1) {
      return e.reply('公共Token&OpenID失效. \r且未找到您的登录信息，请先扫码登录。\r发送【#营地扫码】')
    }
    if (response === -2) {
      return e.reply('您的登录信息已过期，请重新扫码登录。')
    }

    const { profile, roleCard } = response.data

    const data = {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/MyKingHomepage.html',
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
    }

    const inventoryImage = await puppeteer.screenshot('myKingHomepage', data)

    await e.reply(inventoryImage)
  }

  async fetchUserProfile (ID, OpenID, Token, userId) {
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
