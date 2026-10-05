/**
 * 王者公告的数据层。
 *
 * 数据源是**官网资讯接口**（`ApiService.getPvpNewsList`，端点是官网资讯页自己调的那个），
 * 零鉴权、不占营地频控配额、没绑营地ID也能用 —— 和 #皮肤上新 走官网那套同一个思路。
 * 营地那边虽然也有 `/info/listinfov2` 这类资讯端点，但要登录态、会吃账号请求配额，
 * 而公告是「所有人看到的都一样」的数据，没必要为它消耗营地的号。
 *
 * 每条自带 `sIdxTime`（发布时间）和 `sTagInfo`（**可读**标签名，如「官方公告|体验服公告」），
 * 所以「是不是公告」「属于哪一类」都不用猜，按标签筛就行。
 *
 * ⚠️ 推送判新用的是**时间水位**，不是「和上次快照比 diff」：
 * 这个接口一个频道有上万条历史，用 diff 判新会在第一次运行时把上万条全推一遍
 * （同 [[skinNews]] 那条教训）。首次运行只记水位、不推任何东西。
 */
import path from 'path'
import { ApiService, cache, readYamlFile, writeYamlFile } from '#utils'
import { quarantineCorrupt } from './safeStore.js'
import { PluginData } from '#components'

const NEWS_PUSH_FILE = path.join(PluginData, 'GameNewsPush.yaml')

/** 资讯列表的内存缓存时长（秒）。公告一天也就几条，10 分钟足够，避免连续查重复拉 */
const NEWS_TTL = 600

/** 防重复推送的记录最多留多少条 */
const PUSHED_KEEP = 200

/**
 * 频道 ID。**1762 是版本/公告专区，正式服公告在这里**（2026-09-29 实测）。
 *
 * ⚠️ 一开始用的 1760「热门」，它里面**没有**「9月29日版本更新公告」这种置顶的
 * 正式服更新公告 —— 于是 `#王者公告` 发出来的是几天前的体验服公告（主人当场发现）。
 * 各频道实测（条数 / 内容）：
 *   1762 5899 条  版本公告专区：置顶的正式服更新公告 + 英雄调整 + 处罚公告，**用它**
 *   1760 10125 条 热门：公告与资讯混在一起，正式服更新公告会缺
 *   1761 2383 条  新闻：以英雄平衡性调整、处罚公告为主
 *   1763 1801 条  活动公告：各种活动公告
 *   1766 1444 条  纯体验服：全是体验服公告，正可用来自检过滤
 */
export const CHANNEL_NEWS = 1762

/** 兼容旧名（曾用过 1760） */
export const CHANNEL_HOT = CHANNEL_NEWS

/**
 * 公告分类。**顺序即优先级**，第一个 match 中的就是它的类别。
 *
 * 只收正式服公告，体验服整条滤掉（见 isAnnouncement），所以这里不再有「体验服」类。
 */
const CATEGORIES = [
  { key: 'version', name: '版本更新', color: '#f5d76e', match: n => /版本更新|停机|不停机|更新公告/.test(n.title) },
  { key: 'activity', name: '活动', color: '#ff8fa8', match: n => /活动|福利|礼包|祈愿/.test(n.title) },
  { key: 'punish', name: '处罚', color: '#ff7a85', match: n => /处罚|打击|违规|封号/.test(n.title) },
  { key: 'other', name: '公告', color: '#6f8ef5', match: () => true }
]

/** 补全官网返回的协议相对地址（`//static.gametalk.qq.com/...`），否则出图时加载不到 */
function fixUrl (raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  if (text.startsWith('//')) return `https:${text}`
  if (text.startsWith('http://')) return `https://${text.slice(7)}`
  return text
}

/**
 * 解析 `sTagInfo`：`"2536|图文,610|内容形式"` → `['图文', '内容形式']`。
 * 用可读名而不是 `sTagIds` 的数字，是因为标签 ID 没有公开含义表、官网自己也会改。
 */
function parseTags (raw) {
  return String(raw || '')
    .split(',')
    .map(part => part.split('|')[1] || '')
    .map(name => name.trim())
    .filter(Boolean)
}

/**
 * 这条该不该收。两个条件都要满足：是公告，且**不是体验服**。
 *
 * 「是公告」先认标签里的「公告」，标签缺失时退回看标题 —— 实测有 2 条 `sTagInfo`
 * 是空串，只认标签会把它们漏掉。
 *
 * 「不是体验服」按**标签 + 标题双判**（实测标签里明确写着 `体验服`：
 * 「9月29日体验服不停机更新公告」的 tag 是 `公告/资讯/体验服公告/体验服专区/体验服/官方公告`）。
 * 主人 2026-09-29 明确要求：只要正式服公告，体验服的一律不要。
 */
function isAnnouncement (news) {
  if (news.tags.some(t => t.includes('体验服')) || /体验服/.test(news.title)) return false

  if (news.tags.some(t => t.includes('公告'))) return true
  return /公告|更新|声明/.test(news.title)
}

/** '2026-09-24 17:29:45' → 毫秒时间戳；解析不了返回 0（这种条目会被当成最旧的） */
function toTime (raw) {
  const text = String(raw || '').trim()
  if (!text) return 0
  // Safari/部分环境不认空格分隔，统一换成 T
  const ms = Date.parse(text.replace(' ', 'T'))
  return Number.isNaN(ms) ? 0 : ms
}

/** '2026-09-24 17:29:45' → '09-24 17:29' */
export function formatNewsTime (raw) {
  const text = String(raw || '').trim()
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!m) return text
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`
}

/**
 * 公告清单：按发布时间倒序的公告（已滤掉资讯/赛事这些非公告条目）。
 *
 * @param {number} [limit] 从接口取多少条原始资讯（筛完会少于这个数）
 * @returns {Promise<object[]>}
 */
export async function getNewsList (limit = 40) {
  // key 带上频道号：换频道后不会读到换之前缓存的那批（否则要等 TTL 过期才生效）
  const cacheKey = `gok:gameNews:${CHANNEL_NEWS}:${limit}`
  const hit = cache.get(cacheKey)
  if (hit) return hit

  const { items } = await ApiService.getPvpNewsList({ chanid: CHANNEL_NEWS, limit })

  const list = items
    .map(raw => {
      const news = {
        id: String(raw.iId || raw.iNewsId || ''),
        title: String(raw.sTitle || '').trim(),
        time: String(raw.sIdxTime || raw.sCreated || '').trim(),
        tags: parseTags(raw.sTagInfo),
        cover: fixUrl(raw.sIMG || raw.sImgBig || ''),
        // 有 sVID 的是视频稿，详情页路径不一样（官网前端就是这么分的）
        url: raw.sVID
          ? `https://pvp.qq.com/v/detail.shtml?G_Biz=18&tid=${raw.iId}`
          : `https://pvp.qq.com/web201706/newsdetail.shtml?tid=${raw.iId}`,
        top: Number(raw.iTopPos) === 1
      }
      news.ms = toTime(news.time)
      return news
    })
    .filter(news => news.id && news.title && isAnnouncement(news))
    .map(news => {
      const category = CATEGORIES.find(c => c.match(news)) || CATEGORIES[CATEGORIES.length - 1]
      return { ...news, category: category.name, color: category.color, timeText: formatNewsTime(news.time) }
    })
    // ⚠️ 排序必须**置顶优先，再按时间倒序**，不能只按时间：
    // 接口给的置顶项（iTopPos=1）是官方刻意顶上去的正式服更新公告，
    // 而它的发布时间往往比旁边那条「英雄平衡性调整」还早几分钟
    // （实测 9月29日版本更新公告 09-28 16:44 vs 马超海月平衡 09-28 16:52）。
    // 只按 ms 排会把官方置顶的那条挤掉，用户看到的就是另一条。
    .sort((a, b) => (Number(b.top) - Number(a.top)) || (b.ms - a.ms))

  cache.set(cacheKey, list, NEWS_TTL)
  return list
}

/* ------------------------------------------------------------ 订阅与推送水位 */

/**
 * 读订阅表，坏了返回空表——绝不让定时任务因为这个文件挂掉。
 * 解析失败先隔离坏文件，否则空表会被下一次保存固化、订阅静默消失（同 skinNews / groupReportStore）。
 * @returns {{pushList: object, pushed: string[], watermark: number}}
 */
export function loadGameNewsStore () {
  try {
    const data = readYamlFile(NEWS_PUSH_FILE)
    return {
      pushList: data?.pushList && typeof data.pushList === 'object' ? data.pushList : {},
      pushed: Array.isArray(data?.pushed) ? data.pushed.map(String) : [],
      watermark: Number(data?.watermark) || 0
    }
  } catch (error) {
    quarantineCorrupt(NEWS_PUSH_FILE, error, '[王者公告]')
    return { pushList: {}, pushed: [], watermark: 0 }
  }
}

export function saveGameNewsStore (store) {
  writeYamlFile(NEWS_PUSH_FILE, {
    pushList: store?.pushList || {},
    // 只留最近的，否则这个数组会一直长
    pushed: (store?.pushed || []).slice(-PUSHED_KEEP),
    watermark: Number(store?.watermark) || 0
  })
}

/**
 * 开 / 关一个群的公告推送。关掉就删记录，不留空壳。
 * @returns {{changed: boolean}} changed 为假表示状态本来就是这样
 */
export function setGameNewsSub (groupId, enable, extra = {}) {
  const key = String(groupId || '')
  if (!key) return { changed: false }

  const store = loadGameNewsStore()
  const on = Boolean(store.pushList[key])

  if (on === enable) return { changed: false }

  if (enable) {
    store.pushList[key] = { enabled: true, since: Date.now(), ...extra }
  } else {
    delete store.pushList[key]
  }

  saveGameNewsStore(store)
  return { changed: true }
}

/**
 * 这一轮该推哪些公告。
 *
 * 判据是**时间水位**：只推发布时间比 `watermark` 新的。
 * 首次运行（watermark=0）**只记水位、不推**，否则会把上万条历史公告全推一遍。
 *
 * @returns {Promise<{items: object[], store: object, firstRun: boolean}>}
 */
export async function collectGameNews () {
  const store = loadGameNewsStore()
  const list = await getNewsList()

  if (!list.length) return { items: [], store, firstRun: false }

  // 首次运行：把水位钉在最新一条上，这一轮什么都不推
  if (!store.watermark) {
    store.watermark = Math.max(...list.map(n => n.ms))
    saveGameNewsStore(store)
    return { items: [], store, firstRun: true }
  }

  const pushed = new Set(store.pushed)
  const items = list.filter(news => news.ms > store.watermark && !pushed.has(news.id))

  return { items, store, firstRun: false }
}

/** 把这批公告记进已推列表，并把水位推到其中最新的那条 */
export function markGameNewsPushed (store, items) {
  if (!items.length) return
  const ids = items.map(n => String(n.id))
  store.pushed = [...store.pushed.filter(id => !ids.includes(id)), ...ids]
  store.watermark = Math.max(Number(store.watermark) || 0, ...items.map(n => n.ms))
  saveGameNewsStore(store)
}

/* ------------------------------------------------------------ 公告正文 */

/**
 * 正文里保留的标签。其余标签一律拆掉**只留内容**（不是整段删掉，
 * 否则官网那些 `<span>` 套 4 层的段落会被删得只剩空壳）。
 */
const KEEP_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'img', 'table', 'tr', 'td', 'th'])

/**
 * 单页正文最多多少字 / 最多几张图。
 *
 * 长公告**分页**而不是截断：版本更新公告实测 3119 字 + 17 张官方长图，
 * 整条渲成一张图会又长又大（皮肤墙踩过「一条转发 14MB 发不出去」，
 * 见 [[gok-skin-wall-size-and-cache]]）。
 *
 * 这两个数是 **2026-09-29 实测标定的**，不是拍的：
 * 900px 宽的详情页，4 张官方长图 + 1051 字 = 3753px 高 / 0.43MB（q82）。
 * 即约 810px/图、0.1MB/图 —— 所以**卡的是高度不是体积**：单页 8 图约 8000px，
 * 仍在「QQ 压到一屏后文字还看得清」的范围内，体积也才 1MB 出头（上限 3MB）。
 *
 * ⚠️ 第一版按「≤3MB 反推」定成 4 图/页，实测发现切得过碎：17 图被拆成 5 页、
 * 白渲染 4 次。别再用体积反推，高度才是约束。
 */
const CHARS_PER_PAGE = 4000
const IMAGES_PER_PAGE = 8

/**
 * 整条公告最多渲染多少页。再长就只出这么多，末页标注「还有 N 页」并给原文链接。
 *
 * 12 页是按实测定的：最大的正式服更新公告（S45「月照长安」11208 字 + 88 图）
 * 正好用满 8 页，留出余量避免真实公告被截。上限本身只是防「活动公告堆几十张图」
 * 那种极端情况，不是常态。
 */
const MAX_PAGES = 12

/** 常见实体转成字符。官网正文里 `&rarr;` 用得很多（英雄调整的「旧值 → 新值」） */
const ENTITIES = [
  [/&rarr;/gi, '→'], [/&larr;/gi, '←'], [/&mdash;/gi, '—'], [/&ldquo;/gi, '“'],
  [/&rdquo;/gi, '”'], [/&lsquo;/gi, '‘'], [/&rsquo;/gi, '’'], [/&hellip;/gi, '…'],
  [/&middot;/gi, '·'], [/&times;/gi, '×'], [/&nbsp;/gi, ' ']
]

/**
 * 把官网正文 HTML 洗成能直接塞进深色模板的片段。
 *
 * 官网正文**每段都带写死的内联样式**（`font-size:16px` + 微软雅黑 + 行高，实测一条
 * 3.4KB 的公告里有 29 处 `style=`），照原样渲染到深色底上是白底黑字、字号还乱。
 * 所以先把样式全剥掉，只留结构，字体字号交给模板。
 *
 * 唯一保留的语义是**红色强调**（官网用 `color:#ff0000` 标更新时间这类关键信息）：
 * 纯红在深色底上对比度很差，换成模板里的浅红 `.hl`。
 *
 * @param {string} raw sContent 原文
 * @returns {{html: string, textLength: number, imageCount: number, truncated: boolean}}
 */
export function sanitizeNewsContent (raw) {
  let html = String(raw || '')

  // 脚本/样式块整段扔掉，连内容一起
  html = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')

  // 红色强调 → <em class="hl">。只匹配**内部没有嵌套 span** 的那层（最内层优先），
  // 循环到不再变化为止；用正则配嵌套标签是配不准的，所以靠「最内层」这个约束绕开
  const RED = /<span[^>]*color:\s*(?:#ff0000|#f00|red)[^>]*>((?:(?!<\/?span)[\s\S])*?)<\/span>/gi
  for (let i = 0; i < 10; i++) {
    const next = html.replace(RED, '<em class="hl">$1</em>')
    if (next === html) break
    html = next
  }

  // 图片：先把 src 抽出来重建成干净的 <img>，顺手补协议相对地址。
  // 这里**不限张数**——控体积是分页的事（见 paginateNewsContent），
  // 在这儿砍图会让正文和图对不上（文字说「如下图」结果图没了）
  let imageCount = 0
  html = html.replace(/<img\b[^>]*>/gi, tag => {
    const src = fixUrl((tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1] || '')
    if (!src) return ''
    imageCount += 1
    return `<img src="${src}">`
  })

  // 其余标签：保留的只留标签名（属性一律丢，样式就是这么来的），不保留的拆掉留内容。
  //
  // ⚠️ 必须跳过 img：上面刚把图片重建成 `<img src="...">`，这条正则若也作用在它身上
  // 会把 src 一起丢掉 —— 图全变成空标签、一张都不显示，而且**页面照样渲得出来**，
  // 只是体积虚低（实测踩过：4 张官方长图的页面 naturalWidth 全是 0）。
  // ⚠️⚠️ `em` 也必须放行（2026-10-06 修）：上面第 314 行刚把官网的红色 `<span>`
  // 换成 `<em class="hl">`，而这条正则会把属性一律重建掉 → `class="hl"` 被吃成裸 `<em>`。
  // 模板 `resources/html/GameNewsDetail.html:117` 的选择器是 `.content em.hl`，
  // **永远匹配不上**，作者在 298-299 行写的设计意图（深色底上把纯红换成浅红 `.hl`）
  // 自上线以来从未生效过 —— 实测 10 条真实公告共 55 个 `<em>`，带 class 的 **0 个**。
  // 所以这里和 img 一样放行原标签（em 只有这一种用法，属性不会被外部注入）。
  html = html.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (tag, name) => {
    const lower = name.toLowerCase()
    if (!KEEP_TAGS.has(lower)) return ''
    if (lower === 'img') return tag
    if (lower === 'em') return tag.startsWith('</') ? '</em>' : '<em class="hl">'
    return tag.startsWith('</') ? `</${lower}>` : `<${lower}>`
  })

  for (const [re, ch] of ENTITIES) html = html.replace(re, ch)

  // 空段落（官网用 <p>&nbsp;</p> 当间距）会在深色卡片里留一堆空洞
  html = html.replace(/<p>\s*<\/p>/gi, '').replace(/(?:<br>\s*){3,}/gi, '<br><br>')

  const textLength = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().length

  // 这里不截断：长公告交给 paginateNewsContent 分页，正文一个字都不丢
  return { html: html.trim(), textLength, imageCount }
}

/**
 * 把洗好的正文按**段落边界**切成多页，每页控制在「一张图 ≤3MB」的量级内。
 *
 * 为什么按段落切：切在标签中间会渲出破碎的 HTML（`<p>` 没闭合，后面整页样式跟着崩）。
 * 分割点取 `<p>` / `<h1-4>` / `<li>` / `<img>` 的**起始位置**（lookahead 不吃掉标签本身）。
 *
 * 一页满的判据有两个，谁先到算谁：字数到 CHARS_PER_PAGE，或图片到 IMAGES_PER_PAGE。
 * 图片单独计数是因为**图比字重得多**——正文 17 张官方长图那种，字数还没到一页
 * 体积就已经爆了。
 *
 * @param {string} html 洗好的正文
 * @returns {{pages: string[], truncated: boolean, totalPages: number}}
 *   truncated 为真表示超出 MAX_PAGES 被丢掉了尾部，totalPages 是丢之前的真实页数
 */
export function paginateNewsContent (html) {
  const source = String(html || '').trim()
  if (!source) return { pages: [], truncated: false, totalPages: 0 }

  const blocks = source.split(/(?=<p>|<h[1-4]>|<li>|<img\b)/i).filter(b => b.trim())

  const pages = []
  let cur = ''
  let curChars = 0
  let curImages = 0

  for (const block of blocks) {
    const chars = block.replace(/<[^>]*>/g, '').trim().length
    const images = (block.match(/<img\b/gi) || []).length

    // 当前页已经有内容、再加这一块就超标 → 先收页
    const full = curChars + chars > CHARS_PER_PAGE || curImages + images > IMAGES_PER_PAGE
    if (cur && full) {
      pages.push(cur)
      cur = ''
      curChars = 0
      curImages = 0
    }

    cur += block
    curChars += chars
    curImages += images
  }

  if (cur.trim()) pages.push(cur)

  const totalPages = pages.length
  const truncated = totalPages > MAX_PAGES

  return { pages: truncated ? pages.slice(0, MAX_PAGES) : pages, truncated, totalPages }
}

/**
 * 取一条公告的完整详情（标题 + 时间 + 洗好的正文）。
 *
 * @param {object} news 列表项（`getNewsList` 的元素）
 * @returns {Promise<object>} 给模板用的数据
 */
export async function getNewsDetail (news) {
  const detail = await ApiService.getPvpNewsDetail(news.id)
  const body = sanitizeNewsContent(detail.content)
  const { pages, truncated, totalPages } = paginateNewsContent(body.html)

  return {
    ...news,
    title: detail.title || news.title,
    time: detail.time || news.time,
    timeText: formatNewsTime(detail.time || news.time),
    pages,
    pageCount: pages.length,
    totalPages,
    textLength: body.textLength,
    imageCount: body.imageCount,
    truncated,
    // 正文一张图都没有时，把列表里那张头图放到首页，免得整张图全是文字
    headCover: body.imageCount ? '' : news.cover
  }
}
