// 皮肤墙功能：营地皮肤列表接口调用逻辑参考自 https://github.com/KimigaiiWuyi/WzryUID
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import common from '../../../lib/common/common.js'
import { ApiService, readYamlFile, getLocalImage, getUserAvatar, getPvpSkinCover, Button, AT_HEAD, stripAtText, resolveTargetUserId, shouldQuote, resolveMemberName, isQQNumber, SZ_ORDER, tierRank, pickTierText, QUALITY_STATS, countQuality, cleanImageCache, resolveCacheMaxBytes } from '#utils'
import path from 'path'
import { PluginData } from '#components'

const PAGE_SIZE = 50
// 皮肤墙截图质量。原来出 JPEG 时满页 50 张大图在 q90 下可达 8MB+、部分适配器发送失败，
// 只能靠降到 q75 压体积。现在出 webp，同一张图体积约为 jpeg 的 1/3 且失真更低，
// 所以质量提回 82（webp 的 82 视觉上相当于 jpeg 的 90+），体积仍远低于原来。
const SCREENSHOT_QUALITY = 82

/**
 * 一条合并转发最多塞多少张图 / 多少字节。
 *
 * 实测 709 皮肤的号分成 15 页，**每页只有约 1MB**（分页本身是好的），
 * 但 15 张一次塞进同一条合并转发就是 14.32MB —— 单页没超限，整条转发超了，
 * 适配器（NapCat）会把整条转发一起拒收，用户什么都收不到。
 * 所以分页之外还得给「一条转发」设闸，超了就再发一条。
 */
const FORWARD_MAX_IMAGES = 8
const FORWARD_MAX_BYTES = 8 * 1024 * 1024

// SZ_ORDER / TIER_PRIORITY / tierRank / pickTierText / QUALITY_STATS / countQuality 都搬到了
// utils/skinCatalog.js —— #缺皮肤 要用同一套品质口径，两边各存一份迟早会走偏。
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
      // 大图位会把图放大到约 2.6 倍，只剩 180x280 卡面图(lowRes)的皮肤摆上去会发虚。
      // 段内换一张有大图的顶上，段外顺序不动——只在两行内挪位，价值高低的整体排布不受影响。
      if (pageSkins[idx].lowRes) {
        for (let k = idx + 1; k < idx + bandSize; k++) {
          if (!pageSkins[k].lowRes) {
            [pageSkins[idx], pageSkins[k]] = [pageSkins[k], pageSkins[idx]]
            break
          }
        }
      }
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
          reg: `${AT_HEAD}#(王者)?皮肤墙\\s*(.*)$`,
          fnc: 'skinWall'
        },
        {
          reg: `${AT_HEAD}#(王者)?全部皮肤\\s*(.*)$`,
          fnc: 'allSkins'
        }
      ]
    })
  }

  async skinWall(e) {
    const rest = stripAtText(e.msg).replace(/^#(王者)?皮肤墙\s*/, '').trim()
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
    const ID = stripAtText(e.msg).replace(/^#(王者)?全部皮肤\s*/, '').trim()
    return this.#render(e, ID, null)
  }

  async #render(e, msgID, topCount) {
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint)
    // 查的不是自己（艾特了别人）
    const isAt = String(userId) !== String(e.user_id)

    // 昵称：查自己用触发者信息；@别人时从群成员信息取被@人的昵称。
    // 走 resolveMemberName 而不是自己 pickMember(Number(userId))：官bot 的 user_id
    // 是 appid:openid，Number() 是 NaN；兜底也不能回落成原始 ID（画到图上是一长串十六进制）
    let nickname = e.sender?.card || e.sender?.nickname || (isQQNumber(userId) ? String(userId) : '召唤师')
    if (isAt) {
      nickname = await resolveMemberName(e.group, userId)
    }

    const userFilePath = path.join(PluginData, 'UserData.yaml')
    const allUserData = readYamlFile(userFilePath) || {}
    const userInfo = allUserData[userId]

    const ID = msgID || (userInfo && userInfo.ids && userInfo.ids.length
      ? userInfo.ids[userInfo.current || 0]
      : null)

    if (!ID) {
      await e.reply(['未查询到营地ID，请先使用 #绑定营地 绑定营地ID，或在指令后附带营地ID', Button.bind()])
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

    // 品质计数(荣耀典藏/无双/传说)，供顶部统计格展示
    const qualityCounters = { gloryNum: 0, wushuangNum: 0, legendNum: 0 }
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
      countQuality(conf.classTypeName, qualityCounters)

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
        // 皮肤图三级回退，逐个尝试直到拿到真图（下载时才逐级取，见后面的 skinTasks）：
        //   1) 营地 szLargeIcon 竖版大图(720x1280)——卡片最大也只有 434x732，画质足够富余
        //   2) 官网立绘裁成的竖版图(720x1280)——营地对刚上线的新皮肤常只给占位图，
        //      官网这张表的封面图 816 条全齐，是唯一能补齐新皮肤的图源
        //   3) 营地 bigCover 卡面图(180x280)——营地 App“我的皮肤”用的就是它，清晰度垫底
        // getLocalImage 会识别并跳过占位图，所以能落到第一张真图上，不会渲染成灰块。
        imgUrl: conf.szLargeIcon || '',
        coverUrl: conf.bigCover || conf.szSmallIcon || '',
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
    // 并发下载图片到本地缓存，避免 puppeteer 截图时逐张走网络
    const toDataUrl = async (url) => {
      if (!url) return ''
      const img = await getLocalImage(url)
      if (Buffer.isBuffer(img)) {
        const ext = path.extname(new URL(url).pathname).toLowerCase()
        const mime = ext === '.png' ? 'image/png' : 'image/jpeg'
        return `data:${mime};base64,${img.toString('base64')}`
      }
      return url
    }
    const batch = async (tasks, limit = 8) => {
      const results = new Array(tasks.length)
      let i = 0
      const worker = async () => {
        while (i < tasks.length) {
          const idx = i++
          results[idx] = await tasks[idx]()
        }
      }
      await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()))
      return results
    }

    // 头像走 getUserAvatar：官方 QQ 机器人的 user_id 是 openid 而非 QQ 号，
    // 直接拼 q1.qlogo.cn 会回落到默认头像，导致所有人都渲染成同一张图
    const avatarUrl = await getUserAvatar(e, userId)
    const avatarDataUrl = await toDataUrl(avatarUrl)

    // 预下载皮肤图：按回退链逐级尝试，拿到真图即止
    const skinTasks = result.map((skin, idx) => async () => {
      // skin 与 result[idx] 是同一对象，先把营地的候选地址取出来再清空，否则会把待试的源一起清掉
      const campSources = [skin.imgUrl, skin.coverUrl]
      // 一张都拿不到时 imgUrl 保持为空，让模板走无图分支只显示底色和名字——
      // 浏览器端算不了 md5、识别不了占位图，交给它重试只会把灰块渲染出来
      result[idx].imgUrl = ''
      // 官网图排在两个营地源中间：它比 bigCover 清晰得多，但要多拉一次官网总表(780KB)，
      // 故写成惰性求值——只有营地大图确实取不到时才会真去拉，全部命中首选时零额外开销。
      const sources = [
        () => campSources[0],
        () => getPvpSkinCover(skin.skinId),
        () => campSources[1]
      ]
      for (let si = 0; si < sources.length; si++) {
        const url = await sources[si]()
        if (!url) continue
        const img = await getLocalImage(url)
        if (!Buffer.isBuffer(img)) continue
        result[idx].imgUrl = `data:image/jpeg;base64,${img.toString('base64')}`
        // 只剩 180x280 的卡面图可用，标记低清：大图位要放大到 2.6 倍，会明显发虚
        result[idx].lowRes = si === sources.length - 1
        break
      }
      if (skin.labelUrl) {
        const labelImg = await getLocalImage(skin.labelUrl)
        if (Buffer.isBuffer(labelImg)) {
          const ext = path.extname(new URL(skin.labelUrl).pathname).toLowerCase()
          const mime = ext === '.png' ? 'image/png' : 'image/jpeg'
          result[idx].labelUrl = `data:${mime};base64,${labelImg.toString('base64')}`
        }
      }
    })
    await batch(skinTasks, 8)

    // 下完立刻按上限削一次。实测查一个 709 皮肤的号，imgCache 从 1MB 冲到 570MB
    // ——是默认上限(200MB)的 2.8 倍，而定时清理每天只跑一次，中间这段时间完全失控。
    // 图已经转成 base64 进了 HTML，这里删掉磁盘副本不影响本次出图。
    try {
      cleanImageCache({ maxBytes: resolveCacheMaxBytes(), quiet: true })
    } catch {}

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
      // 页数多时会拆成几条转发发（见 FORWARD_MAX_IMAGES），先按张数预告，别让人以为只有一条
      const batches = Math.ceil(totalPages / FORWARD_MAX_IMAGES)
      const how = batches > 1 ? `分 ${totalPages} 张图、${batches} 条合并转发` : `分 ${totalPages} 张图以合并转发`
      await e.reply(`${scope}，将${how}发送，请稍候...`)
    }

    const buildParams = (pageSkins, pageIndex) => ({
      imgType: 'webp',
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/SkinWall.html',
      // 固定 name(=目录)，用 saveId 区分每页文件，避免 Renderer 复用模板缓存时不建目录导致 ENOENT
      saveId: `SkinWall_${pageIndex}`,
      // 降质压体积，避免满页大图 JPEG 过大导致部分适配器发送失败
      quality: SCREENSHOT_QUALITY,
      ydId: String(ID),
      avatar: avatarDataUrl,
      nickname,
      owned: skinInfo.owned,
      totalSkinNum: skinInfo.totalSkinNum || '',
      notForSell: skinInfo.notForSell,
      totalValue: skinInfo.totalValue,
      // 三个品质计数格，label 一并传给模板，改名只需动 QUALITY_STATS
      qualityStats: QUALITY_STATS.map(s => ({ label: s.label, num: qualityCounters[s.key] })),
      pageInfo: totalPages > 1 ? `第 ${pageIndex + 1}/${totalPages} 页` : '',
      skinList: pageSkins
    })

    // 单页直接发图
    if (totalPages === 1) {
      const img = await puppeteer.screenshot('SkinWall', buildParams(pages[0], 0))
      await e.reply([img, Button.skinWall(ID)], shouldQuote())
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
    // 按体积切批：单条转发塞太多会被适配器整条拒收（见 FORWARD_MAX_* 的注释）
    const chunks = chunkByBytes(imgList)
    for (let i = 0; i < chunks.length; i++) {
      const title = chunks.length > 1 ? `${forwardTitle}（${i + 1}/${chunks.length}）` : forwardTitle
      const forwardMsg = await common.makeForwardMsg(e, chunks[i], title)
      // 合并转发里塞不进按钮，按钮单独跟一条
      await e.reply(forwardMsg)
    }
    await e.reply(Button.skinWall(ID))
  }
}

/** 截图消息段的字节数。拿不到就返回 0，让调用方退回按张数切 */
function imageBytes (img) {
  const file = img?.file ?? img?.data?.file ?? img
  if (Buffer.isBuffer(file)) return file.length
  // 少数适配器把图转成了 base64:// 字符串，按 4/3 反推原始体积
  if (typeof file === 'string' && file.startsWith('base64://')) {
    return Math.floor((file.length - 9) * 3 / 4)
  }
  return 0
}

/**
 * 把图片列表切成若干条转发的量：张数和累计体积哪个先到就切。
 * 单张自己就超 FORWARD_MAX_BYTES 时不再和别人合批，独占一条。
 */
function chunkByBytes (imgList, maxImages = FORWARD_MAX_IMAGES, maxBytes = FORWARD_MAX_BYTES) {
  const chunks = []
  let cur = []
  let curBytes = 0

  for (const img of imgList) {
    const bytes = imageBytes(img)
    if (cur.length && (cur.length >= maxImages || (bytes && curBytes + bytes > maxBytes))) {
      chunks.push(cur)
      cur = []
      curBytes = 0
    }
    cur.push(img)
    curBytes += bytes
  }

  if (cur.length) chunks.push(cur)
  return chunks
}
