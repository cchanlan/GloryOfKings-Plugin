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
 * 模板里资源路径的前缀。
 *
 * 渲染产物落在 `temp/html/myKingHomepage/` 下，所以要从那里往上数三层才能回到
 * 插件目录。模板里用 `{{_res_path}}img/xxx.png` 拼地址，这个常量给 JS 侧
 * 需要兜底图时复用，避免两处各写一遍、改一处漏一处。
 */
const RES_PATH = '../../../plugins/GloryOfKings-Plugin/resources/'

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
 * 解析营地的「字符串里再套 JSON」字段，失败一律退回空对象。
 *
 * ⚠️⚠️ 2026-10-06 加的。修的是一个**主页图必崩**的真 bug：
 *   营地会给 `param1` 空串（实测同一响应里 modId 304/408/105/201/409/202
 *   的 param1 全是 `""`），也会整个 mod 都不给 —— 没打过 10v10 的号没有 708、
 *   新号没定级可能没有 701、巅峰赛没打过没有 702。
 *   原实现是 `JSON.parse(modePeakRace.param1)` 和 `mods.find(...).param1` 直接写，
 *   这些情况**每一步都当场抛**，用户只看到「主页数据异常」。
 *
 *   实测：把原逻辑抽出来喂 15 种营地真实可能给的数据形状，**12 种直接崩**
 *   （空 mods / 缺 708 / 缺 701 / 缺 702 / param1 空串 / param1 为 null /
 *    没有 flagPag / flagPag 不是 .pag / flagPag 为 null …）。
 *
 *   这里只兜「解析」这一层：拿不到就返回 `{}`，让下面各处按缺数据处理，
 *   出图时对应字段显示「暂无」而不是整张图失败。
 */
function parseParam (raw) {
  // 数组也是 object，但它不是我们要的形状（下面各处都按对象取字段）—— 一并当没有
  const usable = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

  if (usable(raw)) {
    return raw
  }
  const text = String(raw ?? '').trim()
  if (!text) {
    return {}
  }
  try {
    const parsed = JSON.parse(text)
    return usable(parsed) ? parsed : {}
  } catch {
    // 解析不了就当中没有：主页图少一项，总好过整张图出不来
    return {}
  }
}

/**
 * 从 `flagPag` 地址里抠出旗帜图编号（`resources/img/flag{N}.png` 的 N）。
 *
 * ⚠️ 两个坑都在原实现里踩过：
 *   ① `/(\d+).pag/` 的 `.` **没转义** —— 它匹配任意字符，
 *      于是 `2xpag`、`12-pag` 这种也会被当成合法并取出错误数字；
 *   ② 抠不到时 `match()` 返回 null，原实现直接 `[1]` → TypeError 崩掉整张图。
 *      这里抠不到返回 ''，模板会去找 `flag.png`（不存在）→ 显示空图，
 *      但**不会**让整个主页渲染失败。
 */
function parseFlagPag (flagPag) {
  const matched = String(flagPag ?? '').match(/(\d+)\.pag/)
  return matched ? matched[1] : ''
}

/**
 * 把主页接口返回的数据整理成模板要的形状。
 *
 * 抽成独立函数（而不是塞在回复流程里）有两个好处：出错时异常边界清晰
 * ——上游那种写法里，任何一步抛错都会连累后面几个账号；这里一个账号
 * 解析失败只影响它自己。
 *
 * ⚠️ 几个字段是营地的「字符串里再套 JSON」写法。**解析一律走 parseParam**，
 *    单个模式缺数据/格式变了只让那一项显示「暂无」，不再连累整张图。
 *
 * @param {object} profileData 主页接口的完整响应
 * @param {object} roleData 命中的那个角色
 * @param {object} headData 响应里的 head 段
 * @returns {object} 渲染模板用的数据
 */
function buildHomepageData (profileData, roleData, headData) {
  // mods 也可能整个缺失（营地偶尔不给 head.mods），兜成空数组
  const mods = Array.isArray(headData?.mods) ? headData.mods : []
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
  // ⚠️⚠️ 时间戳为 0 / 缺失时必须给「—」，不能让 moment 去格式化（2026-10-06 修）。
  //    `moment(0)` 是**合法**的（= 1970-01-01 UTC），`.calendar()` 于是渲染出
  //    「1970/01/01」—— 看起来像真数据，用户会以为这人 1970 年上过线。
  //    实测线上 24 个账号里有 2 个（52334903、1781746532）字段就是 0。
  //    `Number('')` 也是 0，所以空串同样走这条路。
  const fmtCalendar = (ts) => {
    const sec = Number(ts)
    // 小于等于 0 一律当「没有」，另外挡住明显不是秒级时间戳的脏值
    if (!Number.isFinite(sec) || sec <= 0) return '—'
    return moment(sec * 1000).locale('zh-cn').calendar()
  }
  const onlineTime = fmtCalendar(onlineTimestamp)
  const offlineTime = fmtCalendar(offlineTimestamp)

  const mode10v10 = mods.find(mod => mod.modId === MOD_ID.rank10v10)
  const mode5v5 = mods.find(mod => mod.modId === MOD_ID.rank5v5)
  const modePeakRace = mods.find(mod => mod.modId === MOD_ID.peakRace)

  // ⚠️ 下面每个模式都可能整个缺失（没打过 10v10 / 新号没定级 / 巅峰赛没打过），
  //    param1 也可能是空串 —— 一律按「这项没有数据」处理，绝不抛错。
  const peakParam = parseParam(modePeakRace?.param1)
  const v5Param = parseParam(mode5v5?.param1)
  const v10Param = parseParam(mode10v10?.param1)

  // 把抠出来的旗帜编号写回 param1，模板里读的是 `modePeakRace.param1.flagPag`。
  // ⚠️ 必须**复制**、不能就地改 `modePeakRace.param1`：那是调用方响应对象里的字段，
  //    改了以后同一份数据再渲染一次，flagPag 已经是 `'2'` 这种裸编号，
  //    正则再也匹配不到 `.pag`，旗帜就变成破图（实测踩到过）。
  const peakRace = modePeakRace
    ? { ...modePeakRace, param1: { ...peakParam, flagPag: parseFlagPag(peakParam.flagPag) } }
    : undefined

  const mod = mods.filter(i => i.stype === 0)
  const combat = mods.find(i => i.stype === 1)

  const { rankingStar, starImg } = v5Param

  /**
   * 段位文案：有星数才拼「N星」，没有就只显示段位名。
   *
   * 不能拼成「永恒钻石I 暂无星」这种 —— 缺星数的号（新号、营地改版）
   * 段位名本身是有效的，读起来反而别扭。整个模式缺失时才是「暂无」。
   */
  const rankText = (mode, param) => {
    if (!mode) return '暂无'
    const star = param.rankingStar
    const hasStar = star !== undefined && star !== null && star !== ''
    return hasStar ? `${mode.name} ${star}星` : String(mode.name ?? '暂无')
  }
  const rank10v10 = rankText(mode10v10, v10Param)
  const rank5v5 = rankText(mode5v5, v5Param)
  const isKing = rank5v5.includes('王者')
  const flagImg = resolveFlagImg(rank5v5)

  // 巅峰赛这一块的兜底。
  //
  // 背景：`modePeakRace` 存在但 `param1` 是空串时（营地没给巅峰赛数据），
  // 下面三个字段全是 undefined，模板直接拼进 src 会渲染出破图占位。
  // ⚠️ 兜底图的选择：`roleIcon` 用玩家自己的头像（模板那层金框是另一张
  //    `modePeakRace-avatar.png`，它是边框不是头像，拿它当头像是错的）；
  //    旗帜抠不到就退回 5v5 的编号，别留空。
  if (peakRace) {
    const param = peakRace.param1
    if (!param.flagPag) param.flagPag = flagImg
    if (!param.roleIcon) param.roleIcon = roleIcon || ''
    if (param.desc === undefined || param.desc === null || param.desc === '') param.desc = '未定级'
  }

  return {
    imgType: getImgType(),
    tplFile: 'plugins/GloryOfKings-Plugin/resources/html/MyKingHomepage.html',
    // 渲染产物落在 temp/html/myKingHomepage/ 下，所以资源路径要从那里往上数三层
    _res_path: RES_PATH,
    roleIcon,
    roleName,
    gameLevel,
    gameOnline,
    rank10v10,
    rank5v5,
    areaName,
    roleText,
    flagImg,
    // mode5v5 / modePeakRace 整个缺失时 icon 也是 undefined —— 给张兜底图，
    // 否则模板会去请求空地址，渲染出破图（原实现是 `mode5v5.icon`，缺了还当场崩）
    rankIcon: mode5v5?.icon || `${RES_PATH}img/roleJob.png`,
    onlineTime,
    offlineTime,
    rankingStar,
    // 星条图缺失就给空串，模板用 {{if}} 跳过这一层。
    // ⚠️ 别拿 `star.png` 兜底：那是一颗星，塞进「星条」的尺寸里会被拉成
    //    一张糊满段位盾牌的大金星（实测踩到过，比空着还难看）。
    starImg: starImg || '',
    isKing,
    isOffline: gameOnline === '离线',
    honor: isKing ? 'honor' : 'roleJob',
    content_7: peakRace?.content,
    modePeakRace: peakRace,

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
