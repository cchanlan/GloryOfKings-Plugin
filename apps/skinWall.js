// 皮肤墙功能：营地皮肤列表接口调用逻辑参考自 https://github.com/KimigaiiWuyi/WzryUID
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import common from '../../../lib/common/common.js'
import { ApiService, readYamlFile } from '#utils'
import path from 'path'
import { PluginData } from '#components'

const SZ_ORDER = ['SR', 'S++', 'S+', 'S', 'A', 'B', 'C', 'D']
const SKIN_IMG_BASE = 'https://game-1255653016.file.myqcloud.com/battle_skin_702-1236'
const PAGE_SIZE = 50
// #皮肤墙 未指定数量时的默认渲染数
const DEFAULT_TOP_COUNT = 50

export class SkinWall extends plugin {
  constructor() {
    super({
      name: '查询王者皮肤墙',
      dsc: '查询账号拥有的皮肤',
      event: 'message',
      priority: 5,
      rule: [
        {
          reg: '^#(王者)?皮肤墙\\s*(.*)$',
          fnc: 'skinWall'
        },
        {
          reg: '^#(王者)?全部皮肤\\s*(.*)$',
          fnc: 'allSkins'
        }
      ]
    })
  }

  async skinWall(e) {
    const rest = e.msg.replace(/^#(王者)?皮肤墙\s*/, '').trim()
    // 参数可含营地ID和数量，任意顺序；纯数字且不超过4位视为“数量”，其余视为营地ID
    const tokens = rest.split(/\s+/).filter(Boolean)
    let ID = ''
    let topCount = DEFAULT_TOP_COUNT
    for (const t of tokens) {
      if (/^\d{1,4}$/.test(t)) topCount = Math.max(1, parseInt(t, 10))
      else ID = t
    }
    return this.#render(e, ID, topCount)
  }

  async allSkins(e) {
    const ID = e.msg.replace(/^#(王者)?全部皮肤\s*/, '').trim()
    return this.#render(e, ID, null)
  }

  async #render(e, msgID, topCount) {
    const isAt = Boolean(e.at && !e.atme)
    const userId = isAt ? e.at : e.user_id

    // 昵称：查自己用触发者信息；@别人时从群成员信息取被@人的昵称
    let nickname = e.sender?.card || e.sender?.nickname || String(userId)
    if (isAt) {
      nickname = String(userId)
      try {
        const member = e.group?.pickMember?.(Number(userId))
        const info = member?.getInfo ? await member.getInfo() : member?.info
        nickname = info?.card || info?.nickname || String(userId)
      } catch (err) {
        logger.debug(`[皮肤墙] 获取被@成员昵称失败: ${err.message}`)
      }
    }

    const userFilePath = path.join(PluginData, 'UserData.yaml')
    const allUserData = readYamlFile(userFilePath) || {}
    const userInfo = allUserData[userId]

    const ID = msgID || (userInfo && userInfo.ids && userInfo.ids.length
      ? userInfo.ids[userInfo.current || 0]
      : null)

    if (!ID) {
      await e.reply('未查询到营地ID，请先使用 #绑定营地 绑定营地ID，或在指令后附带营地ID')
      return
    }

    let data
    try {
      const res = await ApiService.getSkinList(ID, String(userId))
      data = res && res.data ? res.data : res
    } catch (error) {
      logger.error(`[皮肤墙] 查询 ${ID} 失败: ${error.message}`)
      await e.reply(ApiService.formatUserFacingError(error, {
        isMaster: Boolean(e.isMaster),
        scene: '皮肤墙查询异常'
      }))
      return
    }

    if (!data || !data.skinCountInfo || !Array.isArray(data.heroSkinList)) {
      logger.error(`[皮肤墙] 返回数据异常: ${JSON.stringify(data).slice(0, 300)}`)
      await e.reply('获取皮肤数据失败，可能该召唤师隐藏了资料或登录态失效')
      return
    }

    const skinInfo = data.skinCountInfo
    const confList = data.heroSkinConfList || {}

    let srNum = 0
    let sppNum = 0
    let spNum = 0
    const result = []

    for (const skin of data.heroSkinList) {
      if (!('iBuy' in skin) || skin.szClass == null) {
        continue
      }
      const szClass = String(skin.szClass).replace('＋', '+')
      const conf = confList[skin.skinId]
      if (!conf) {
        continue
      }
      const szLevel = SZ_ORDER.includes(szClass) ? SZ_ORDER.indexOf(szClass) : 7
      if (szLevel === 0) srNum++
      else if (szLevel === 1) sppNum++
      else if (szLevel === 2) spNum++

      result.push({
        iClass: szLevel,
        szClass,
        // 价格：综合价值优先，点券价兜底，用于排序
        price: Number(conf.skin_worth) || Number(conf.iPrice) || 0,
        skinId: conf.iSkinId,
        skinName: conf.szTitle,
        heroName: conf.szHeroTitle,
        imgUrl: `${SKIN_IMG_BASE}/${conf.iSkinId}.jpg`,
        // 702-1236 图集不含全部皮肤，缺失时回退到官方大图
        fallbackUrl: conf.szLargeIcon || conf.szSmallIcon || '',
        // 皮肤品质角标图（史诗/限定/荣耀典藏等），可能为空
        labelUrl: conf.classLabel || ''
      })
    }

    // 价格从高到低；价格相同按营地评级(iClass 越小越高)排
    result.sort((a, b) => (b.price - a.price) || (a.iClass - b.iClass))

    const totalAvailable = result.length
    // #皮肤墙 [N]：只渲染价值最高的前 N 个；#全部皮肤：topCount 为 null 表示不截断
    const limited = topCount ? result.slice(0, topCount) : result
    // 大图标记依据截断后的顺序重排，避免首张恰好不是最贵那张
    limited.forEach((skin, idx) => {
      skin.big = idx % 7 === 0
    })

    if (!limited.length) {
      await e.reply('该账号暂无可展示的皮肤，或资料未公开')
      return
    }

    // 皮肤较多时分页渲染，每页 PAGE_SIZE 个，避免单图过长、渲染过久
    const pages = []
    for (let i = 0; i < limited.length; i += PAGE_SIZE) {
      pages.push(limited.slice(i, i + PAGE_SIZE))
    }
    const totalPages = pages.length
    const isLimited = topCount && topCount < totalAvailable

    if (totalPages > 1) {
      const scope = isLimited ? `按价值 TOP ${limited.length}` : `共 ${limited.length} 个皮肤`
      await e.reply(`${scope}，将分 ${totalPages} 张图以合并转发发送，请稍候...`)
    }

    const buildParams = (pageSkins, pageIndex) => ({
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/SkinWall.html',
      // 固定 name(=目录)，用 saveId 区分每页文件，避免 Renderer 复用模板缓存时不建目录导致 ENOENT
      saveId: `SkinWall_${pageIndex}`,
      ydId: String(ID),
      avatar: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}`,
      nickname,
      owned: skinInfo.owned,
      totalSkinNum: skinInfo.totalSkinNum || '',
      notForSell: skinInfo.notForSell,
      totalValue: skinInfo.totalValue,
      srNum,
      sppNum,
      spNum,
      pageInfo: totalPages > 1 ? `第 ${pageIndex + 1}/${totalPages} 页` : '',
      skinList: pageSkins
    })

    // 单页直接发图
    if (totalPages === 1) {
      const img = await puppeteer.screenshot('SkinWall', buildParams(pages[0], 0))
      await e.reply(img)
      return
    }

    // 多页逐张渲染后合并转发
    const imgList = []
    for (let i = 0; i < totalPages; i++) {
      try {
        const img = await puppeteer.screenshot('SkinWall', buildParams(pages[i], i))
        if (img) imgList.push(img)
      } catch (error) {
        logger.error(`[皮肤墙] 第 ${i + 1} 页渲染失败: ${error.message}`)
      }
    }

    if (!imgList.length) {
      await e.reply('皮肤图渲染失败，请稍后再试')
      return
    }

    const forwardTitle = isLimited ? `皮肤墙 TOP${limited.length} · ${ID}` : `皮肤墙 · ${ID}`
    const forwardMsg = await common.makeForwardMsg(e, imgList, forwardTitle)
    await e.reply(forwardMsg)
  }
}
