/**
 * #王者公告 —— 官网公告的**完整正文**出图，以及按群订阅的新公告推送。
 *
 * 数据源与判据见 utils/gameNews.js：走官网资讯接口，零鉴权、**不占营地请求配额**，
 * 没绑营地ID也能用（同 #皮肤上新 的思路）。
 *
 * ⚠️ 指令必须带「王者」前缀：genshin 插件占了 `^#*(公告|资讯|活动)$`，
 * 裸 `#公告` 会被它抢走（那边是米游社公告）。
 *
 * 出图与分发规则（主人 2026-09-29 定）：
 *   - 单张图控制在 3MB 内（MAX_IMAGE_BYTES），超了自动降画质重渲
 *   - 3 张以内直接在一条消息里发完；超过 3 张走合并转发
 *
 * 推送时间是配置项 `gameNewsCron`（锅巴面板「公告检查时间」），
 * 留空 = 不自动推送，只保留指令。改完需重启（cron 在 constructor 注册）。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import common from '../../../lib/common/common.js'
import { getImgType, Button, shouldQuote, pickGroupSafe, AT_HEAD } from '#utils'
import { Config } from '#components'
import {
  getNewsList, getNewsDetail, loadGameNewsStore, setGameNewsSub,
  collectGameNews, markGameNewsPushed
} from '../utils/gameNews.js'

const readConfig = () => {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/** #王者公告列表 一张图里最多列几条 */
const MAX_ITEMS = 12

/** 单张图的体积上限（主人要求 3MB 以内）。超了按 QUALITY_STEPS 降画质重渲 */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024

/**
 * 降画质的梯度。第一档就是插件平时的画质，后面几档专治长图。
 * ⚠️ quality 只对 jpeg / webp 有效，png 是无损的、给了也不会变小 —— 所以长正文
 * 强制走 jpeg/webp（见 detailImgType）。
 */
const QUALITY_STEPS = [82, 68, 52, 40]

/** 3 张以内直接发，超过走合并转发 */
const INLINE_MAX_IMAGES = 3

/**
 * 详情图用什么格式。跟随全局配置，但 png 换成 jpeg：
 * png 无损，降不了体积，长公告必然突破 3MB。
 */
function detailImgType () {
  const type = getImgType()
  return type === 'png' ? 'jpeg' : type
}

/** 截图消息段的字节数。拿不到返回 0（当作「没法判断」，不触发降画质） */
function imageBytes (img) {
  const file = img?.file ?? img?.data?.file ?? img
  if (Buffer.isBuffer(file)) return file.length
  // 少数适配器把图转成了 base64:// 字符串，按 4/3 反推原始体积
  if (typeof file === 'string' && file.startsWith('base64://')) {
    return Math.floor((file.length - 9) * 3 / 4)
  }
  return 0
}

function formatMB (bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`
}

/**
 * 渲一页正文，体积超标就降画质重渲。
 *
 * 逐档重试而不是一上来就用低画质：绝大多数公告一档就够（纯文字的才几百 KB），
 * 只有带十几张官方长图的版本更新公告才需要往下降。
 *
 * @returns {Promise<object|false>} 图片消息段，全部尝试都失败则 false
 */
async function renderPage (data) {
  let last = false

  for (const [i, quality] of QUALITY_STEPS.entries()) {
    const img = await puppeteer.screenshot('GameNewsDetail', {
      ...data,
      imgType: detailImgType(),
      quality,
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/GameNewsDetail.html'
    })

    if (!img) return last

    const bytes = imageBytes(img)
    last = img

    // 拿不到体积（0）就不折腾了，直接用；够小也直接用
    if (!bytes || bytes <= MAX_IMAGE_BYTES) {
      if (i > 0) {
        logger.mark(`[王者公告] 第 ${data.pageNo} 页降到画质 ${quality} 后 ${formatMB(bytes)}`)
      }
      return img
    }

    logger.mark(`[王者公告] 第 ${data.pageNo} 页画质 ${quality} 下 ${formatMB(bytes)} 超 3MB，继续降`)
  }

  // 降到底还是超，也只能发它 —— 总比什么都不发好
  return last
}

/**
 * 把一条公告渲成若干页图。
 * @returns {Promise<object[]>} 图片消息段数组（可能为空）
 */
async function renderDetail (detail) {
  const imgList = []

  for (const [i, page] of detail.pages.entries()) {
    try {
      const img = await renderPage({
        title: detail.title,
        timeText: detail.timeText,
        category: detail.category,
        color: detail.color,
        url: detail.url,
        headCover: detail.headCover,
        page,
        pageNo: i + 1,
        pageCount: detail.pageCount,
        totalPages: detail.totalPages,
        truncated: detail.truncated,
        isLast: i === detail.pages.length - 1
      })
      if (img) imgList.push(img)
    } catch (error) {
      logger.error(`[王者公告] 第 ${i + 1} 页渲染失败: ${error.message}`)
    }
  }

  return imgList
}

export class GameNews extends plugin {
  constructor () {
    super({
      name: '王者公告',
      dsc: '官网公告正文与新公告推送',
      event: 'message',
      // 同 skinNews / whoIsPlaying：完整锚定的短指令要抢在 queryGameStats 的宽匹配前面
      priority: 0,
      rule: [
        // ⚠️⚠️ 三条都要用 AT_HEAD 替掉硬 `^`（2026-10-06 修）：手打/粘贴出来的
        //    「@昵称」到 Bot 这边**只是纯文本**（真 at 段不会进 e.msg），它顶在指令前面时
        //    硬 `^#` 匹配不上，规则直接 continue —— 用户发出去**一句回应都没有**。
        //    同插件 heroList / myHeroList / heroDetail / skinWall / skinMissing 都已用 AT_HEAD。
        { reg: `${AT_HEAD}#王者(公告|资讯)列表$`, fnc: 'list' },
        { reg: `${AT_HEAD}#王者(公告|资讯)$`, fnc: 'latest' },
        {
          reg: `${AT_HEAD}#(开启|关闭)王者公告推送$`,
          fnc: 'toggle',
          // admin 会自动放行主人，群里则要求管理员
          permission: 'admin'
        }
      ]
    })

    const cfg = readConfig()
    this.task = cfg.gameNewsCron
      ? { name: '王者公告', cron: cfg.gameNewsCron, fnc: () => this.pushAll(), log: false }
      : { name: '', fnc: '', cron: '' }
  }

  /* ------------------------------------------------------------ 指令查询 */

  /** #王者公告 —— 最新一期公告的完整正文 */
  async latest (e) {
    let list
    try {
      list = await getNewsList()
    } catch (error) {
      // ⚠️ 原始 error.message 不甩给用户（2026-10-06 修）：这条数据源是官网资讯接口
      //    （零鉴权、不占营地配额），失败原因基本只有网络/对方改版两种，原文对用户没有
      //    可操作性；而 message 里可能带完整 URL 与内部字段名。
      logger.error(`[王者公告] 获取失败: ${error.message}`)
      return e.reply('官网公告拉取失败，稍后再试试', shouldQuote())
    }

    if (!list.length) {
      return e.reply('官网最近没有公告', shouldQuote())
    }

    let detail
    try {
      detail = await getNewsDetail(list[0])
    } catch (error) {
      // ⚠️ 同上：给用户「怎么办」而不是 error.message（2026-10-06 修）。
      //    原文链接是已知的、也是唯一有用的出路，保留。
      logger.error(`[王者公告] 取正文失败: ${error.message}`)
      return e.reply(`取公告正文失败，可以直接看原文：${list[0].url}`, shouldQuote())
    }

    await e.reply(`正在生成《${detail.title}》${detail.pageCount > 1 ? `，共 ${detail.pageCount} 页` : ''}...`, shouldQuote())

    const imgList = await renderDetail(detail)
    if (!imgList.length) {
      return e.reply(`公告出图失败，可以直接看原文：${detail.url}`, shouldQuote())
    }

    const subscribed = Boolean(loadGameNewsStore().pushList[String(e.group_id || '')])
    await this.#deliver(e, imgList, detail, Button.gameNews(subscribed))
  }

  /** #王者公告列表 —— 只看标题清单 */
  async list (e) {
    let list
    try {
      list = await getNewsList()
    } catch (error) {
      logger.error(`[王者公告] 获取失败: ${error.message}`)
      return e.reply('官网公告拉取失败，稍后再试试', shouldQuote())
    }

    if (!list.length) {
      return e.reply('官网最近没有公告', shouldQuote())
    }

    const img = await puppeteer.screenshot('GameNews', {
      imgType: getImgType(),
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/GameNews.html',
      pushMode: false,
      list: list.slice(0, MAX_ITEMS)
    })
    // ⚠️⚠️ 出图失败必须在这里拦住（2026-10-06 修）：`puppeteer.screenshot` 渲染失败时返回
    //    **false**（renderers/puppeteer/lib/puppeteer.js：`if (ret.length === 0 || !ret[0]) return false`），
    //    而适配器的 makeMsg 会把非对象元素包成文本段 —— 群里收到的是一条内容为 `false` 的消息，
    //    不是任何可读的失败提示。同文件 latest() 对同类失败有兜底
    //    （`if (!imgList.length) return e.reply('公告出图失败…')`），这里是唯一漏掉的分支。
    if (!img) return e.reply('公告列表出图失败，稍后再试', shouldQuote())

    const subscribed = Boolean(loadGameNewsStore().pushList[String(e.group_id || '')])
    await e.reply([img, Button.gameNews(subscribed)], shouldQuote())
  }

  async toggle (e) {
    if (!e.isGroup) {
      return e.reply('公告推送要在群里开关（推送发到本群）', shouldQuote())
    }

    const enable = e.msg.includes('开启')
    const cfg = readConfig()

    if (enable && !cfg.gameNewsCron) {
      return e.reply('主人把「公告检查时间」留空了，自动推送是关着的，只能用 #王者公告 查', shouldQuote())
    }

    const { changed } = setGameNewsSub(e.group_id, enable, {
      operator: String(e.user_id),
      groupName: e.group_name || ''
    })

    if (!changed) {
      return e.reply(`本群的公告推送本来就是${enable ? '开着' : '关着'}的`, shouldQuote())
    }

    await e.reply([
      enable
        ? `已开启本群公告推送，检查时间：${cfg.gameNewsCron}\n官网出新公告时会在本群播报`
        : '已关闭本群公告推送',
      Button.gameNews(enable)
    ], shouldQuote())
  }

  /* ------------------------------------------------------------ 发送 */

  /**
   * 按张数决定怎么发：3 张以内一条消息发完，超过走合并转发（主人 2026-09-29 定）。
   *
   * 文案一律在图**下面**（见 [[plugin-push-copy-below-image]]）。
   * 合并转发里塞不进按钮，按钮只能另跟一条。
   *
   * @param {object|null} e 消息事件；定时推送传 null，改用 target.sendMsg
   * @param {object} target 发送对象（e 为空时必须给）
   */
  async #deliver (e, imgList, detail, button, { target = null, caption = '' } = {}) {
    const tip = caption || this.#caption(detail, imgList.length)
    const send = msg => (e ? e.reply(msg, shouldQuote()) : target.sendMsg(msg))

    if (imgList.length <= INLINE_MAX_IMAGES) {
      const segs = [...imgList]
      if (tip) segs.push(tip)
      if (button) segs.push(button)
      await send(segs)
      return
    }

    const title = `${detail.title}（共 ${imgList.length} 页）`
    const forwardMsg = await common.makeForwardMsg(e, imgList, title)
    await send(forwardMsg)
    // 转发里放不了文案和按钮，跟一条
    const segs = []
    if (tip) segs.push(tip)
    if (button) segs.push(button)
    if (segs.length) await send(segs)
  }

  /** 图下面那行说明 */
  #caption (detail, pageCount) {
    const parts = [`📢 ${detail.timeText} · ${detail.category}`]
    if (detail.truncated) {
      parts.push(`正文过长，只出了前 ${pageCount} 页（共 ${detail.totalPages} 页）`)
    }
    parts.push(`原文：${detail.url}`)
    return parts.join('\n')
  }

  /* ------------------------------------------------------------ 定时推送 */

  /**
   * 每轮：把比水位新的公告推给订阅群。
   * 首次运行只记水位、不推（见 utils/gameNews.js 的 collectGameNews）。
   *
   * 只推**最新那一条的完整正文**，其余新公告在文案里列标题 ——
   * 一次冒出好几条时全渲完既慢又刷屏。
   */
  async pushAll () {
    const groups = Object.keys(loadGameNewsStore().pushList)
    if (!groups.length) return

    let items
    let store
    let firstRun
    try {
      ({ items, store, firstRun } = await collectGameNews())
    } catch (error) {
      logger.error(`[王者公告] 定时检查失败: ${error.message}`)
      return
    }

    if (firstRun) {
      logger.mark('[王者公告] 首次运行，已记下时间水位，下轮起只推新公告')
      return
    }

    if (!items.length) return

    let detail
    try {
      detail = await getNewsDetail(items[0])
    } catch (error) {
      logger.error(`[王者公告] 取正文失败: ${error.message}`)
      return
    }

    const imgList = await renderDetail(detail)
    if (!imgList.length) {
      logger.error('[王者公告] 出图失败，本轮不推送（水位保留，下轮重试）')
      return
    }

    const caption = [
      this.#caption(detail, imgList.length),
      items.length > 1
        ? `另有 ${items.length - 1} 条新公告：\n${items.slice(1).map(n => `· ${n.title}`).join('\n')}`
        : ''
    ].filter(Boolean).join('\n')

    let sent = 0
    for (const groupId of groups) {
      const group = pickGroupSafe(groupId)
      if (!group?.sendMsg) {
        logger.warn(`[王者公告] 群 ${groupId} 取不到发送对象，跳过`)
        continue
      }

      try {
        await this.#deliver(null, imgList, detail, null, { target: group, caption })
        sent += 1
      } catch (error) {
        logger.error(`[王者公告] 推送到群 ${groupId} 失败: ${error.message}`)
      }
    }

    // 只要有一个群收到就推进水位，避免下轮重复播报；一个群都没发出去时保留，下轮重试
    if (sent > 0) {
      markGameNewsPushed(store, items)
      logger.mark(`[王者公告] 已推送《${detail.title}》等 ${items.length} 条到 ${sent} 个群`)
    }
  }
}
