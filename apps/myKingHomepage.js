import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import common from '../../../lib/common/common.js'
import { ApiService, readYamlFile, Button, AT_HEAD, AT_TAIL, stripAtText, resolveTargetUserId, shouldQuote } from '#utils'
import path from 'path'
import { PluginData, PluginPath } from '#components'
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
          // 「王者」两个字可省，#全部主页 是很自然的简写
          reg: `${AT_HEAD}#全部(王者)?(主页|卡片|信息)${AT_TAIL}`,
          fnc: 'allKingHomepage'
        },
        {
          reg: `${AT_HEAD}#王者(主页|卡片|信息)\\s*(.*)$`,
          fnc: 'myKingHomepage'
        }
      ]
    })
  }

  getUserInfo(userId) {
    const allUserData = readYamlFile(path.join(PluginData, 'UserData.yaml')) || {}
    return allUserData[userId]
  }

  // 查询单个ID的主页，默认取当前营地ID；也支持 #王者主页[序号] 与 #王者主页[营地ID]
  async myKingHomepage(e) {
    const input = stripAtText(e.msg).replace(/^#王者(主页|卡片|信息)\s*/, '').trim()
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint)
    const userInfo = this.getUserInfo(userId)
    const ids = userInfo?.ids || []

    if (!ids.length) {
      await e.reply([
        segment.image(path.join(PluginPath, 'resources', 'img', '营地ID获取.png')),
        Button.bind()
      ], shouldQuote())
      return
    }

    let ID
    if (!input) {
      ID = ids[userInfo.current] || ids[0]
    } else if (/^\d+$/.test(input) && Number(input) <= 9999) {
      // 4位以内的纯数字视为绑定列表序号，营地ID位数远大于此
      ID = ids[Number(input) - 1]
      if (!ID) {
        await e.reply(`序号无效，你当前只绑定了 ${ids.length} 个营地ID`)
        return
      }
    } else {
      ID = input
    }

    await this.replyHomepages(e, [ID], userId)
  }

  // 查询已绑定的全部营地ID主页
  async allKingHomepage(e) {
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint)
    const userInfo = this.getUserInfo(userId)
    const ids = userInfo?.ids || []

    if (!ids.length) {
      await e.reply([
        segment.image(path.join(PluginPath, 'resources', 'img', '营地ID获取.png')),
        Button.bind()
      ], shouldQuote())
      return
    }

    await this.replyHomepages(e, ids, userId)
  }

  async replyHomepages(e, IDs, userId) {
    if (IDs.length > 1) {
      await e.reply(`本次查询包含${IDs.length}个ID，请稍候...`)
    }

    const imgBuffers = []
    const failedResults = []
    const pushFailure = (id, message) => {
      failedResults.push({
        id: String(id),
        message: String(message || '获取数据失败,请稍后重试')
      })
    }

    for (const ID of IDs) {
      let profileData
      try {
        profileData = await ApiService.getProfile(ID, String(userId))
      } catch (error) {
        logger.error(`[王者主页] 查询 ${ID} 失败: ${error.message}`)
        const replyMessage = ApiService.formatUserFacingError(error, {
          isMaster: Boolean(e.isMaster),
          scene: '王者主页查询异常'
        })
        if (IDs.length === 1) {
          await e.reply(replyMessage)
        } else {
          pushFailure(ID, replyMessage)
        }
        continue
      }

      if (profileData.returnCode === -30107) {
        if (IDs.length === 1) {
          await e.reply('获取数据失败,请稍后重试')
        } else {
          pushFailure(ID, '获取数据失败,请稍后重试')
        }
        continue
      }

      if (profileData.returnCode === -10107) {
        if (IDs.length === 1) {
          await e.reply(`ID: ${ID},召唤师隐藏了主页信息，无法查看`)
        } else {
          pushFailure(ID, '召唤师隐藏了主页信息，无法查看')
        }
        continue
      }

      if (!profileData || !profileData.data || !profileData.data.roleList) {
        console.log('获取数据失败，API返回:', JSON.stringify(profileData, null, 2))
        if (IDs.length === 1) {
          await e.reply('获取数据失败,请稍后重试')
        } else {
          pushFailure(ID, '获取数据失败,请稍后重试')
        }
        continue
      }

      try {
        const { head: headData, targetRoleId } = profileData.data
        const roleData = profileData.data.roleList.find(role => role.roleId === targetRoleId)

        if (!roleData) {
          if (IDs.length === 1) {
            await e.reply('未找到角色数据')
          } else {
            pushFailure(ID, '未找到角色数据')
          }
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
      } catch (error) {
        logger.error(`[王者主页] 渲染 ${ID} 失败: ${error.message}`)
        if (IDs.length === 1) {
          await e.reply(`ID: ${ID}，主页数据异常，暂时无法生成图片`)
        } else {
          pushFailure(ID, '主页数据异常，已跳过')
        }
        continue
      }

      if (IDs.length > 1) {
        await common.sleep(5000)
      }
    }

    if (imgBuffers.length) {
      // 单ID时按钮带上营地ID，避免点击后又回落到当前账号；多ID时给通用按钮
      const button = IDs.length === 1 ? Button.homepage(IDs[0]) : Button.homepage()
      await e.reply([...imgBuffers, button], shouldQuote())
    }

    if (failedResults.length) {
      const failureMessage = IDs.length === 1
        ? failedResults[0].message
        : [
            `本次有 ${failedResults.length} 个ID异常，已跳过：`,
            ...failedResults.map(item => `ID: ${item.id}，${item.message}`)
          ].join('\n')

      await e.reply(failureMessage)
    }
  }
}
