import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import common from '../../../lib/common/common.js'
import { getImgType, ApiService, readYamlFile, Button, AT_HEAD, AT_TAIL, stripAtText, resolveTargetUserId, resolveUserData, shouldQuote } from '#utils'
import path from 'path'
import { PluginData, PluginPath } from '#components'
import moment from 'moment'

/** 营地在线状态码 → 中文（营地用 0/1/2，不是布尔） */
const ONLINE_TEXT = {
  0: '离线',
  1: '在线',
  2: '游戏中'
}

/** 三个模式在 `mods` 里的固定 modId */
const MOD_ID = {
  rank10v10: 708,
  rank5v5: 701,
  peakRace: 702
}

/**
 * 段位 → 旗帜图编号（`resources/img/flag{N}.png`）。
 *
 * 判定顺序不能调：`最强王者` 也包含「王者」两个字，但它在星耀之上，
 * 所以必须先判低段位、后判高段位，让后面的条件覆盖前面的。
 */
function resolveFlagImg (rank5v5) {
  // 默认 4：王者之后不再细分
  if (/青铜|白银|黄金|铂金/.test(rank5v5)) return '1'
  if (/钻石|星耀/.test(rank5v5)) return '2'
  if (rank5v5.includes('最强王者')) return '3'
  return '4'
}

/**
 * 把主页接口返回的数据整理成模板要的形状。
 *
 * 抽成独立函数（而不是塞在回复流程里）有两个好处：出错时异常边界清晰
 * ——上游那种写法里，任何一步抛错都会连累后面几个账号；这里一个账号
 * 解析失败只影响它自己。
 *
 * ⚠️ 几个字段是营地的「字符串里再套 JSON」写法，解析失败会抛错，
 *    由调用方的 catch 兜住并提示「主页数据异常」。
 *
 * @param {object} profileData 主页接口的完整响应
 * @param {object} roleData 命中的那个角色
 * @param {object} headData 响应里的 head 段
 * @returns {object} 渲染模板用的数据
 */
function buildHomepageData (profileData, roleData, headData) {
  const { mods } = headData
  const {
    roleName, // 昵称
    roleIcon, // 头像
    gameLevel, // 等级
    gameOnline: onlineCode, // 在线状态 【1:在线 0:离线】
    areaName, // 分区
    roleText, // 区服
    onlineTime: onlineTimestamp, // 最近一次上线
    offlineTime: offlineTimestamp // 最近一次离线
  } = roleData

  const gameOnline = ONLINE_TEXT[onlineCode]
  const onlineTime = moment(onlineTimestamp * 1000).locale('zh-cn').calendar()
  const offlineTime = moment(offlineTimestamp * 1000).locale('zh-cn').calendar()

  const mode10v10 = mods.find(mod => mod.modId === MOD_ID.rank10v10)
  const mode5v5 = mods.find(mod => mod.modId === MOD_ID.rank5v5)
  const modePeakRace = mods.find(mod => mod.modId === MOD_ID.peakRace)

  // 巅峰赛的 param1 是一段 JSON 字符串，里面还套着 flagPag 的图片文件名
  modePeakRace.param1 = JSON.parse(modePeakRace.param1)
  modePeakRace.param1.flagPag = modePeakRace.param1.flagPag.match(/(\d+).pag/)[1]

  const mod = mods.filter(i => i.stype === 0)
  const combat = mods.find(i => i.stype === 1)

  const { rankingStar, starImg } = JSON.parse(mode5v5.param1)
  const rank10v10 = `${mode10v10.name} ${JSON.parse(mode10v10.param1).rankingStar}星`
  const rank5v5 = `${mode5v5.name} ${rankingStar}星`
  const isKing = rank5v5.includes('王者')

  return {
    imgType: getImgType(),
    tplFile: 'plugins/GloryOfKings-Plugin/resources/html/MyKingHomepage.html',
    // 渲染产物落在 temp/html/myKingHomepage/ 下，所以资源路径要从那里往上数三层
    _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
    roleIcon,
    roleName,
    gameLevel,
    gameOnline,
    rank10v10,
    rank5v5,
    areaName,
    roleText,
    flagImg: resolveFlagImg(rank5v5),
    rankIcon: mode5v5.icon,
    onlineTime,
    offlineTime,
    rankingStar,
    starImg,
    isKing,
    isOffline: gameOnline === '离线',
    honor: isKing ? 'honor' : 'roleJob',
    content_7: modePeakRace.content,
    modePeakRace,

    mod,
    combat
  }
}

export class MyKingHomepage extends plugin {
  constructor () {
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

  async getUserInfo (userId) {
    const allUserData = await resolveUserData(userId)
    return allUserData[userId]
  }

  // 查询单个ID的主页，默认取当前营地ID；也支持 #王者主页[序号] 与 #王者主页[营地ID]
  async myKingHomepage (e) {
    const input = stripAtText(e.msg).replace(/^#王者(主页|卡片|信息)\s*/, '').trim()
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint)
    const userInfo = await this.getUserInfo(userId)
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
  async allKingHomepage (e) {
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint)
    const userInfo = await this.getUserInfo(userId)
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

  /**
   * 逐个账号拉主页并出图。
   *
   * 多账号时**逐个报错、不中断**：一个号隐藏了主页或者数据坏了，
   * 不该把后面几个号一起带下去，所以失败信息先攒着，最后统一回一条。
   */
  async replyHomepages (e, IDs, userId) {
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

      // 频控（-30107）走不到这里：getProfile 命中频控时是抛错的，
      // 已被上面的 catch 接走，由 formatUserFacingError 转成对用户友好的提示。

      if (profileData.returnCode === -10107) {
        if (IDs.length === 1) {
          await e.reply(`ID: ${ID},召唤师隐藏了主页信息，无法查看`)
        } else {
          pushFailure(ID, '召唤师隐藏了主页信息，无法查看')
        }
        continue
      }

      if (!profileData || !profileData.data || !profileData.data.roleList) {
        logger.debug(`[王者主页] ${ID} 返回结构异常: ${JSON.stringify(profileData)?.slice(0, 500)}`)
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

        const data = buildHomepageData(profileData, roleData, headData)
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

      // 多账号时每张图之间隔一下：连打营地接口会触发频控
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
