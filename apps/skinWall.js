// 皮肤墙功能：营地皮肤列表接口调用逻辑参考自 https://github.com/KimigaiiWuyi/WzryUID
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import common from '../../../lib/common/common.js'
import { ApiService, readYamlFile } from '#utils'
import path from 'path'
import { PluginData } from '#components'

const SZ_ORDER = ['SR', 'S++', 'S+', 'S', 'A', 'B', 'C', 'D']
const SKIN_IMG_BASE = 'https://game-1255653016.file.myqcloud.com/battle_skin_702-1236'
const PAGE_SIZE = 50
// 皮肤墙截图 JPEG 质量：满页 50 张大图在 q90 下可达 8MB+，部分适配器发送失败。
// 保持每页 50 张，仅靠降质压体积——q75 视觉几乎无损但体积约为 q90 的 1/3，满页可压到 ~3MB。
const SCREENSHOT_QUALITY = 75

// 高价值品质优先级(下标越小价值越高)，对齐营地“皮肤价值”口径。
// 这些顶级品质(如荣耀典藏)的综合估值 skin_worth 常为 0，无法靠 worth 排序；
// 且营地评级里 SR 会盖过 S++ 的荣耀典藏，故用显式品质优先级把它们稳定置顶。
// 依据接口返回的 conf.classTypeName(品质名数组)精确匹配。
const TIER_PRIORITY = ['荣耀典藏', '珍品无双', '无双至尊', '珍品传说', '传说限定']

// 取皮肤命中的最高价值品质档位下标；未命中任何高价值品质返回末尾档，走原有评级/估值兜底。
function tierRank(classTypeName) {
  const names = Array.isArray(classTypeName) ? classTypeName : []
  let best = TIER_PRIORITY.length
  for (const name of names) {
    const idx = TIER_PRIORITY.indexOf(String(name))
    if (idx !== -1 && idx < best) best = idx
  }
  return best
}

// 品质名展示优先级：接口的 classTypeName 是数组，常混着主题名(如“墨染江湖”)与品质名(如“无双”)，
// 顺序不固定。这里按“价值品质”优先挑一个用于文字角标兜底——角标图缺失(接口新皮肤图 404 或为空)
// 时，用品质名渲染一个文字标，避免高价值皮肤看起来“没标”。列表外的名字作为最次兜底取数组首项。
const QUALITY_LABELS = [
  '荣耀典藏', '珍品无双', '无双至尊', '珍品传说', '传说限定',
  '无双', '珍品限定', '传说品质', '史诗品质', '勇者品质', '限定'
]

function pickTierText(classTypeName) {
  const names = (Array.isArray(classTypeName) ? classTypeName : [])
    .map(n => String(n).trim())
    .filter(Boolean)
  if (!names.length) return ''
  for (const label of QUALITY_LABELS) {
    if (names.includes(label)) return label
  }
  return names[0]
}
// #皮肤墙 未指定数量时的默认渲染数
const DEFAULT_TOP_COUNT = 50
// 皮肤墙网格列数，需与 SkinWall.html 的 grid-template-columns 保持一致
const GRID_COLS = 6

// 为一页皮肤分配大图(2×2)与精确网格坐标，兼顾“高价值皮肤突出展示”“大图位置随机”“底边整齐”。
// 以“两行为一段”组织：每段 = 1 张大图 + 铺满其余格子的小图，恰好填满 cols 的两整行、段内无空洞。
// 大图在段内随机挑一列落 2×2，其余小图按阅读顺序绕开它填满——无论大图落在哪列，整段仍是满的两整行，底边照样齐。
// 只有当剩余皮肤够铺满一整段时才安排大图；不足一段的尾部全用小图自然平铺，末行即便不满也都是等高小图。
// 因为放弃了 CSS 的 dense 自动排布，这里给每张卡算好 1-indexed 的 row/col，供模板 inline 精确摆放。
function assignBandLayout(pageSkins, cols) {
  const smallPerBand = cols * 2 - 4 // 一段(两行)里除大图外的小图数
  const bandSize = 1 + smallPerBand // 一整段的卡片总数
  let idx = 0
  let baseRow = 0 // 当前段起始行(0-indexed)
  while (idx < pageSkins.length) {
    const remaining = pageSkins.length - idx
    if (remaining >= bandSize) {
      // 满段：随机选大图所在列 [0, cols-2]，占 baseRow/baseRow+1 两行的相邻两列
      const bc = Math.floor(Math.random() * (cols - 1))
      const big = pageSkins[idx]
      big.big = true
      big.row = baseRow + 1
      big.col = bc + 1
      // 段内两行按阅读顺序收集非大图格子，依次分给后续小图
      const freeCells = []
      for (let r = baseRow; r < baseRow + 2; r++) {
        for (let c = 0; c < cols; c++) {
          const inBig = (r === baseRow || r === baseRow + 1) && (c === bc || c === bc + 1)
          if (!inBig) freeCells.push({ r, c })
        }
      }
      for (let k = 0; k < smallPerBand; k++) {
        const skin = pageSkins[idx + 1 + k]
        skin.big = false
        skin.row = freeCells[k].r + 1
        skin.col = freeCells[k].c + 1
      }
      idx += bandSize
      baseRow += 2
    } else {
      // 尾部不足一段：全用小图，按阅读顺序自然平铺，无大图凸出
      for (let k = 0; k < remaining; k++) {
        const skin = pageSkins[idx + k]
        skin.big = false
        skin.row = baseRow + Math.floor(k / cols) + 1
        skin.col = (k % cols) + 1
      }
      idx += remaining
    }
  }
}

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

      // 综合价值(真实估值)与点券原价分开保存，避免两种量纲混在一起比大小
      const worth = Number(conf.skin_worth) || 0
      const iPrice = Number(conf.iPrice) || 0

      result.push({
        // 高价值品质档位(荣耀典藏/珍品无双/…)，越小越靠前；未命中为末尾档
        tier: tierRank(conf.classTypeName),
        iClass: szLevel,
        szClass,
        // 综合价值：营地估值，含绝版/返场/稀有度溢价，最能代表真实价值
        worth,
        // 点券原价：worth 缺失时的兜底维度
        iPrice,
        // 兼容字段：优先综合价值，其次点券价
        price: worth || iPrice,
        skinId: conf.iSkinId,
        skinName: conf.szTitle,
        heroName: conf.szHeroTitle,
        imgUrl: `${SKIN_IMG_BASE}/${conf.iSkinId}.jpg`,
        // 702-1236 图集不含全部皮肤，缺失时回退到官方大图
        fallbackUrl: conf.szLargeIcon || conf.szSmallIcon || '',
        // 皮肤品质角标图（史诗/限定/荣耀典藏等），可能为空
        labelUrl: conf.classLabel || '',
        // 文字品质兜底：角标图缺失或加载失败时，用品质名渲染一个文字标
        tierText: pickTierText(conf.classTypeName)
      })
    }

    // 四级排序，让真实价值高的稳定靠前：
    // 1) 高价值品质档位优先(荣耀典藏/珍品无双/无双至尊/珍品传说/传说限定)——这些顶级品质
    //    的 skin_worth 常为 0、且营地评级里 SR 会盖过 S++ 的荣耀典藏，故用显式档位置顶
    // 2) 营地评级(iClass 越小越高)——可靠的价值分层，不受接口字段缺失影响
    // 3) 同档同评级内按综合价值(真实估值)降序精排
    // 4) 综合价值缺失时按点券原价兜底，避免与综合价值混在同一维度比较
    result.sort((a, b) =>
      (a.tier - b.tier) ||
      (a.iClass - b.iClass) ||
      (b.worth - a.worth) ||
      (b.iPrice - a.iPrice)
    )

    const totalAvailable = result.length
    // #皮肤墙 [N]：只渲染价值最高的前 N 个；#全部皮肤：topCount 为 null 表示不截断
    const limited = topCount ? result.slice(0, topCount) : result

    if (!limited.length) {
      await e.reply('该账号暂无可展示的皮肤，或资料未公开')
      return
    }

    // 皮肤较多时分页渲染，每页 PAGE_SIZE 个，避免单图过长、渲染过久
    const pages = []
    for (let i = 0; i < limited.length; i += PAGE_SIZE) {
      const pageSkins = limited.slice(i, i + PAGE_SIZE)
      // 每页独立做分段布局，保证每页底边各自整齐
      assignBandLayout(pageSkins, GRID_COLS)
      pages.push(pageSkins)
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
      // 降质压体积，避免满页大图 JPEG 过大导致部分适配器发送失败
      quality: SCREENSHOT_QUALITY,
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
      await e.reply(img, true)
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
