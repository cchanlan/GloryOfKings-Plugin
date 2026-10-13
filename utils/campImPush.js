/**
 * 营地消息 → QQ 私信推送。
 *
 * ## 推给谁
 * **只推给该营地账号的归属人**（`AuthPool.json` 的 `ownerBotUserId`）。
 * 没有归属人的号一律不推 —— 那批是 2026-09-17 之前扫的老号，主人明确说过不管。
 *
 * ## 长什么样
 * ```
 * [头像卡片 + 对方发的原图，从头像到图片是一整张]   ← 图**镶在卡片里**（2026-10-14 主人定）
 * 📩 我就只会补兵
 * （微信安卓 荣耀王者）
 *
 * 回复：引用这条消息，或发 #营地回复 1580886057 <内容>
 * ```
 *
 * ⚠️ **引用回复靠的是下面这段文字正文**（认 `📩` 抬头 + 营地号 + 发信人昵称，
 *    见 apps/campIm.js 的 replyByQuote）—— 所以卡片图只是好看，正文一个字都不能省。
 * ⚠️ **图渲染/发送失败要降级成纯文字** —— 不能因为一张图发不出去就把消息丢了。
 *
 * ## ⚠️ 图片消息的特殊性（2026-10-14 修「别人发的图片收不到」）
 *
 * 营地好友发图片时**正文是空的**，地址在 `links` 里（见 utils/campImImage.js）。
 * 所以这条链上有两个必须守住的点：
 *   · 正文为空**不等于**消息为空 —— 有图就要照推（apps/campIm.js 的 dispatch 同此判据）
 *   · 图片是**消息本体**不是装饰，下载后**镶进卡片**一起出来；卡片渲染失败时
 *     退回「图当独立消息段单独发」，绝不因为图挂了把整条消息丢掉
 */
import path from 'node:path'
import { Config, PluginPath } from '#components'
import authStore from './authStore.js'
import { sendPrivate } from './privateMsg.js'
import { addRef, setLastPush, getLastPush as storeGetLastPush } from './campImStore.js'
import { sendMaster } from './masterMsg.js'
import { qlogoUrl } from './avatar.js'
import { extractImages, photoMark } from './campImImage.js'
import { getLocalImage } from './fileUtils.js'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { getImgType } from './imageType.js'

// ⚠️ `segment` 是云崽的全局变量（lib/plugins/loader.js 里 global.segment = segment），
//    不能从 #components import —— 本仓库其他文件（如 apps/heroDetail.js）也是直接用全局的。
/* global segment */

/** 配置读取（现读，改完不用重启） */
function cfg () {
  try { return Config.getDefOrConfig('config') || {} } catch { return {} }
}

/** 推送带不带头像图 */
function pushImageEnabled () {
  return cfg().campImPushImage !== false
}

/** 拿某营地账号的归属人 QQ；没有就返回 '' */
export function ownerOf (campUserId) {
  try {
    const acc = authStore.getAccount(String(campUserId))
    return String(acc?.ownerBotUserId || '')
  } catch {
    return ''
  }
}

/**
 * 营地**官方通知账号** —— 活动红点 / 系统提示（`campEventMsg`）的发信人，不是真人好友。
 *
 * ⚠️ 服务端（`server-im/camp-im-server.js`）在解析阶段就挡掉了这批，插件端再兜一层是因为：
 *    **用户跑的营地消息服务可能是别人部署的旧版**，那边没这道过滤的话，
 *    插件端不认就照样会把「您有未领取的任务奖励」这类推成好友私信（2026-10-10 实测）。
 */
const OFFICIAL_SENDER_ID = '1001'

/** 昵称/角色名截断，防刷屏 */
function clip (s, n = 20) {
  const t = String(s || '').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * 组装私信内容。
 *
 * 头像优先级：**游戏头像（`fromRoleIcon`）优先，取不到回落 QQ 头像**。
 *   · 游戏头像只有「在游戏客户端里发」的消息才带；用 HTTP 发的裸文本没有
 *   · 回落用 `qlogoUrl`（`utils/avatar.js`），只在对方是 QQ 号时拼得出来
 *     （微信区的营地号拼不出 QQ 头像，那就干脆不带图）
 *
 * @returns {{text: string, image: string}}
 */
function buildContent (msg) {
  // ⭐ 只留角色名（游戏里的名字），不带营地账号昵称 —— 两个名字摆一起反而看不清谁是谁
  // ⭐ 名字的回落链：**游戏角色名 → 营地昵称 → 营地号**。
  //    中间那层是给**离线补拉**的消息兜的：营地那个接口只保证收件人那侧
  //    `toUserInfo` 带完整角色信息，发件人 `fromUserInfo` 常常是
  //    `roleName:''` + `nickname:'营地昵称'`（2026-10-10 实测样本），
  //    少了这一层，补拉回来的消息标题会显示成一串营地号，认不出是谁发的。
  const title = clip(msg.fromRoleName, 16) || clip(msg.nickname, 16) || clip(msg.fromUserId, 12)
  // ⭐ 图片消息的正文是**空的**（地址在 `links` 里，见 utils/campImImage.js）——
  //    回落链：**文字 → `[图片]` 占位 → 「（空消息）』。
  //    有图就不该显示成「（空消息）」（卡片正文会跟旁边真发出来的图自相矛盾）；
  //    占位用 `[图片]` 而不是营地原文的 `[我发送了一张图片]` —— 那是**发件人视角**的
  //    文案，对收件的归属人来说「我」字完全错位。
  const pics = extractImages(msg)
  const body = String(msg.text || '').trim() || (pics.length ? photoMark(pics.length) : '（空消息）')

  // ⚠️ 图下这一行是**引用回复的暗号**：`📩` 是 tryQuote 的识别标志、营地号是 missCamp 锚点、
  //    收件人名是 missNick 锚点（拿不到消息 id 时的兜底校验）——三样都折进这一行，
  //    既不跟图里的头像/昵称重复显示，又一个锚点都不少。正文本身已经渲染进图里了。
  const caption = `📩 回复 ${title}：引用本条，或发 #营地回复 ${msg.selfUserId} <内容>`

  // 图挂了降级纯文字用这份 —— 得带上正文，不能只发锚点（不然消息内容全丢了）
  const fallbackLines = [`📩 ${title}`, body]
  if (msg.fromRoleDesc) fallbackLines.push(`（${clip(msg.fromRoleDesc, 24)}）`)
  fallbackLines.push('', `回复：引用本条，或发 #营地回复 ${msg.selfUserId} <内容>`)

  // 游戏头像优先；没有就用发信人的 QQ 头像兜底
  let image = msg.fromRoleIcon || ''
  if (!image) {
    try {
      image = qlogoUrl(msg.fromUserId, 100) || ''
    } catch {
      image = ''
    }
  }

  // 卡片副标题：区服/段位那类附属信息（fromRoleDesc），没有就不摆
  const sub = msg.fromRoleDesc ? clip(msg.fromRoleDesc, 24) : ''

  return { caption, fallbackText: fallbackLines.join('\n'), image, name: title, sub, message: body, pics }
}

/**
 * 单条消息最多下载几张图。
 *
 * ⚠️ 必须封顶：轮询（3 秒一拍）是**串行**的，一条消息下载多久，后面所有消息就等多久。
 *    营地是外部服务，`links` 里给几十上百项时（坏数据 / 恶意构造）不封顶就是把整个
 *    收消息链路卡住 —— 图可以少发几张，消息不能堵。
 *    9 张也够用：一次连拍 9 张截图已经是很极端的情况了。
 */
const MAX_PHOTOS = 9

/**
 * 把图片消息里的图下下来（本地缓存 Buffer 或原地址），失败的单张跳过，不拖累整条。
 *
 * ⚠️ 一图两用：
 *   · 渲染卡片时给 `renderCard` 当 `photos`（图**镶进卡片**，2026-10-14 主人定的样式）
 *   · 卡片渲染失败时退回独立消息段（`segment.image`）直接发出去
 * 所以这里返回**原始数据**（Buffer / URL 字符串），由调用方决定怎么用。
 *
 * ⚠️ 用 `getLocalImage`（md5 缓存 + 占位图识别 + 「失败标记 7 天重试」）——
 *    和英雄头像 / 皮肤图共用一份缓存治理，不然这堆一次性大图会把 data/imgCache
 *    撑到上限之外、而清理器还看不见它们。
 * ⚠️ **串行下载**，不并发：一次来七八张游戏截图时并发会把带宽和句柄全占掉，
 *    跟出图任务抢资源。单张超时上限在 getLocalImage 里（15 秒）。
 * @returns {Promise<Array<Buffer|string>>}
 */
async function loadPhotos (pics) {
  const out = []
  for (const p of pics.slice(0, MAX_PHOTOS)) {
    try {
      const buf = await getLocalImage(p.url)
      out.push(buf || p.url)   // 下载失败退回远程地址，渲染器还能自己拉一次
    } catch (e) {
      logger.debug?.(`[营地消息] 图片下载失败（${e?.message || e}）：${p.url}`)
      out.push(p.url)
    }
  }
  if (pics.length > MAX_PHOTOS) {
    logger.debug?.(`[营地消息] 一条消息带了 ${pics.length} 张图，只发前 ${MAX_PHOTOS} 张`)
  }
  return out
}

/**
 * 把渲染用图转成 `<img src>` 能吃的地址。
 *
 * ⚠️ puppeteer 截图时页面在浏览器里跑，**内存 Buffer 传不进去** —— 转 base64 data URI；
 *    远程地址（下载失败时的回落）直接原样用。
 */
function toSrc (v) {
  if (Buffer.isBuffer(v)) return `data:image/png;base64,${v.toString('base64')}`
  return String(v || '')
}

/**
 * 把整条营地消息（头像 + 昵称 + 来源 + 图片 + 正文）渲染成一张卡片（营地绿风格，webp）。
 *
 * ⚠️ `photos`（对方发的图）是**镶进卡片里的**（2026-10-14 主人定的样式）——
 *    一条消息出一张卡，头像、昵称、图片、正文都在里面，不再分成「卡片图 + 独立图」
 *    两坨发出去（那样看着别扭：卡片里写着 [图片]，真图却甩在外面）。
 *    传进来的项是 Buffer（本地缓存）或地址字符串，转 data URI 交给模板。
 *
 * 图只是好看，认收件人靠的是图下文字（见文件头注释）；渲染失败返回 '' 让上游降级。
 *
 * @param {{image?:string, name:string, sub?:string, message?:string, photos?:Array<Buffer|string>}} card
 * @returns {Promise<string|Buffer>} 云崽 segment 的图，或 ''（失败）
 */
async function renderCard (card) {
  try {
    const photos = Array.isArray(card.photos) ? card.photos.map(toSrc).filter(Boolean) : []
    return await puppeteer.screenshot('gok-camp-im-msg', {
      // 见 apps/campFriend.js 的说明：_res_path 是「从 temp/html/<name>/ 回到 resources」的相对路径
      tplFile: path.join(PluginPath, 'resources', 'html', 'campImMsg.html'),
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      imgType: getImgType(),
      avatar: card.image || '',
      name: card.name || '营地好友',
      sub: card.sub || '',
      message: card.message || '',
      photos
      // ⚠️ 不用传 `waitUntil`：宿主渲染器自带 `pageGotoParams`
      //    （`renderers/puppeteer` 默认 `networkidle2`，等图加载完才截）。
      //    这里传了反而可能被后端忽略或覆盖，不如不传。
    })
  } catch (e) {
    logger.debug?.(`[营地消息] 卡片渲染失败（${e?.message || e}），降级用裸头像`)
    return ''
  }
}

/**
 * 推一条营地消息给归属人。
 *
 * @param {object} msg 服务端返回的消息对象
 * @param {object} [opts]
 * @param {object} [opts.bot] 多账号下传 e.bot
 * @returns {Promise<{ok:boolean, reason?:string, to?:string}>}
 */
export async function pushToOwner (msg, { bot } = {}) {
  // 官方通知账号（活动红点等）不进私信 —— 服务端新版已挡，这里兜旧版服务端，见上
  if (String(msg?.fromUserId || '') === OFFICIAL_SENDER_ID) return { ok: false, reason: 'official_sender' }

  const owner = ownerOf(msg.selfUserId)
  if (!owner) return { ok: false, reason: 'no_owner' }   // 无归属 → 按约定不管

  const { caption, fallbackText, image, name, sub, message: body, pics } = buildContent(msg)
  // 正文已经渲染进图，所以没头像也照样出图（图里有 🎮 占位）；只有配置里关了才不出
  const withImage = pushImageEnabled()

  // ⭐ 营地好友发的图片是**消息本体**，不受「推送带对方头像」开关管 ——
  //    那个开关管的是上面那张卡片（装饰）；图本身是对方要传达的内容，
  //    不能因为关了装饰就把内容也丢掉。
  const photos = pics?.length ? await loadPhotos(pics) : []

  // ① 带图发：整条消息（头像 + 昵称 + **对方发的图** + 正文）渲染成**一张**卡片。
  //    ⚠️ 图是**镶进卡片里的**（2026-10-14 主人定的样式）—— 别拆成「卡片 + 独立图」
  //    两坨发出去：那看着别扭（卡片上写着 [图片]，真图却甩在下面），
  //    一条消息就一条推送。
  let sent = { ok: false, reason: 'skip_image' }
  if (withImage) {
    // ⚠️ 图**已经镶进卡片**了，正文里那个自动生成的 `[图片]` 占位就成了废话
    //    （图就在上面，文字再说一遍「[图片]」很傻）—— 只有真实文字才留在卡片正文里。
    //    占位对纯文字降级（②）仍然有用，所以只在这里抹掉，buildContent 里不动。
    const cardText = (pics?.length && body === photoMark(pics.length)) ? '' : body
    let pic = await renderCard({ image, name, sub, message: cardText, photos })
    if (!pic && image) pic = segment.image(image)   // 渲染失败且有头像 → 裸头像兜底
    if (pic) {
      try {
        sent = await sendPrivate(owner, [pic, caption], { bot })
      } catch (e) {
        sent = { ok: false, reason: e?.message || 'image_failed' }
      }
    }
  }

  // ①b 卡片这条路没走成（开关关了 / 渲染和头像兜底都挂了）但手上有图：
  //     图还是要发出去（降级成独立图片段），不能因为一张装饰卡片把内容吞了
  if (!sent.ok && photos.length) {
    try {
      const segs = photos.map(p => segment.image(p))
      sent = await sendPrivate(owner, [...segs, caption], { bot })
    } catch (e) {
      sent = { ok: false, reason: e?.message || 'image_failed' }
    }
  }

  // ② 图挂了就降级纯文字（带正文的那份，不因为一张图把消息内容丢了）
  if (!sent.ok) {
    if (withImage) logger.debug?.(`[营地消息] 头像发送失败（${sent.reason}），降级纯文字`)
    sent = await sendPrivate(owner, fallbackText, { bot })
  }

  if (!sent.ok) {
    // ③ 私信彻底发不出去（多半没加好友/关了临时会话）→ 转告主人，别静默丢
    logger.warn(`[营地消息] 推给 ${owner} 失败：${sent.reason}`)
    const fallback = await sendMaster(
      `营地号 ${msg.selfUserId} 收到一条消息，但推给归属人 ${owner} 失败了（TA 多半没加机器人好友）。\n`
      + `发信人：${msg.fromRoleName || msg.fromUserId}\n`
      // ⚠️ 用 body 而不是 msg.text：图片消息的 text 是空串，写出来就是「内容：」一条空的
      + `内容：${body}`
    )
    return { ok: false, reason: sent.reason, to: owner, fallbackToMaster: fallback }
  }

  // ⭐ 精确映射：拿得到「发出去那条消息的 id」时，主人引用**任意一条**推送都能对回正确的人。
  //    ⚠️ 拿不到就只能靠下面的 __last__ 兜底，而那条路在「连着收到两条推送、引用较旧那条」
  //    时会回错人（2026-09-20 实测：引用 Cchanlan 的推送，回给了更晚推来的缨）。
  if (sent.messageId) rememberRef(sent.messageId, msg)

  // ⭐ 记下「主人最近收到的这条推送是谁发的」—— 引用回复要靠它反查。
  //    ⚠️ `sendPrivate` 只返回 {ok}，拿不到发出去那条消息的 id（各适配器行为不一），
  //    所以走「最近一条」而不是「精确 id 映射」：主人引用那条私信时，
  //    云崽给的 reply_id 我们匹配不上，就退化成「按最近一条推送回复」。
  rememberLastPush(owner, msg)

  return { ok: true, to: owner }
}

// ────────────────────────── 引用回复的映射 ──────────────────────────

/**
 * 「某归属人最近一条推送」的映射。
 *
 * ⚠️ 为什么不按消息 id 精确映射：`sendPrivate` 拿不到发出消息的 id。
 *    所以这里按**归属人**记「最近一条」，主人引用那条私信回复时，
 *    我们从 reply_id 匹配不上就退化成按最近一条处理。
 *
 * 代价：主人连着收到两条推送、引用**较旧**那条回复时，会回错人。
 * 缓解：`campImStore` 里也按 reply_id 存一份（有些适配器能拿到 id），
 *      两条路都走，优先精确匹配。
 *
 * ⚠️ 走 `campImStore` 落盘（按归属人分开存），不只用内存 Map ——
 *    不然重启后主人引用一条旧推送就认不出来，会被别的插件的
 *    `^#?回复` 之类规则抢走。
 */
function rememberLastPush (owner, msg) {
  const info = {
    selfUserId: String(msg.selfUserId),
    toUserId: String(msg.fromUserId),
    toRoleId: String(msg.fromRoleId || ''),
    fromRoleId: String(msg.raw?.toRoleId || ''),
    // ⚠️ 名字一定要存：退路取到的可能是**别人的**推送（同一个营地号下不同好友，
    //    或者两个号互相串），光靠 id 认不出来，得拿被引用原文里的发信人名核对。
    // ⚠️ 必须和写进 caption 的 title 用**同一个截断函数**（2026-10-06 修）：
    //    apps/campIm.js 的 tryQuote 是拿 `quotedText.includes(ref.nick)` 做兜底校验的，
    //    而 caption 里是 clip(…, 16) 截断后的名字。角色名 length > 16 时原文里只有
    //    「前 16 字 + …」，includes(完整名字) 恒为 false → 误判「认不出收件人」并拒绝转发，
    //    而用户引用的正是刚刚收到的最新那条推送。
    nick: clip(msg.fromRoleName, 16),
    at: Date.now()
  }
  setLastPush(owner, info)
}

/**
 * 查「某归属人最近收到的那条推送」。
 * @param {string} owner
 * @returns {object|null}
 */
export function getLastPush (owner) {
  return storeGetLastPush(owner)
}

/**
 * 记一条引用映射 —— 推私信时调（见上）。
 * 保留导出是为了将来适配器能给出消息 id 时，可以精确映射。
 */
export function rememberRef (msgId, msg) {
  if (!msgId) return
  addRef(msgId, {
    selfUserId: String(msg.selfUserId),
    toUserId: String(msg.fromUserId),
    toRoleId: String(msg.fromRoleId || ''),
    fromRoleId: String(msg.raw?.toRoleId || ''),
    nick: String(msg.fromRoleName || '')
  })
}
