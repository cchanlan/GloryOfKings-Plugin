import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import common from '../../../lib/common/common.js'
import { ApiService, readYamlFile } from '#utils'
import path from 'path'
import { PluginData } from '#components'
import moment from 'moment'

export class MyKingHomepage extends plugin {
  constructor() {
    super({
      name: '查询王者主页',
      dsc: '王者主页',
      event: 'message',
      priority: 1,
      rule: [
        {
          reg: '^#王者(主页|卡片|信息)\\s*(.*)$',
          fnc: 'myKingHomepage'
        }
      ]
    })
  }

  async myKingHomepage(e) {
    const msg = e.msg.replace(/^#王者(主页|卡片|信息)\s*/, '')
    let userId = (e.at && !e.atme) ? e.at : e.user_id
    const userFilePath = path.join(PluginData, 'UserData.yaml')

    const allUserData = readYamlFile(userFilePath)
    const userInfo = allUserData[userId]

    if (!userInfo || !userInfo.ids || !userInfo.ids.length) {
      await e.reply(segment.image('https://raw.gitcode.com/Kevin1217/resources/files/master/resources/img/example/王者营地ID获取.png'))
      return
    }

    const IDs = msg ? [msg] : userInfo.ids
    if (IDs.length > 1) {
      await e.reply(`本次查询包含${IDs.length}个ID，请稍候...`)
    }

    const imgBuffers = []
    for (const ID of IDs) {
      const profileData = await ApiService.getProfile(ID)

      if (profileData.returnCode === -30107) {
        await e.reply('获取数据失败,请稍后重试')
        continue
      }

      if (profileData.returnCode === -10107) {
        await e.reply(`ID: ${ID},召唤师隐藏了主页信息，无法查看`)
        continue
      }

      if (!profileData || !profileData.data || !profileData.data.roleList) {
        console.log('获取数据失败，API返回:', JSON.stringify(profileData, null, 2))
        await e.reply('获取数据失败,请稍后重试')
        continue
      }

      const { head: headData, targetRoleId } = profileData.data
      const roleData = profileData.data.roleList.find(role => role.roleId === targetRoleId)

      if (!roleData) {
        await e.reply('未找到角色数据')
        continue
      }

      const { mods } = headData
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

      const mode10v10 = mods.find(mod => mod.modId === 708); // 10v10模式
      const mode5v5 = mods.find(mod => mod.modId === 701); // 5v5模式
      const modePeakRace = mods.find(mod => mod.modId === 702); // 巅峰赛

      modePeakRace.param1 = JSON.parse(modePeakRace.param1)
      modePeakRace.param1.flagPag = modePeakRace.param1.flagPag.match(/(\d+).pag/)[1]

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

      imgBuffers.push(await puppeteer.screenshot('myKingHomepage', data))

      if (IDs.length > 1) {
        await common.sleep(5000)
      }
    }

    e.reply(imgBuffers)
  }
}
