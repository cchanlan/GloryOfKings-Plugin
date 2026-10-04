/**
 * 营地消息 → QQ 私信推送。
 *
 * ## 推给谁
 * **只推给该营地账号的归属人**（`AuthPool.json` 的 `ownerBotUserId`）。
 * 没有归属人的号一律不推 —— 那批是 2026-09-17 之前扫的老号，主人明确说过不管。
 *
 * ## 长什么样
 * ```
 * [头像+昵称卡片图]               ← 渲染出来的小卡片：游戏头像 + 角色名（营地绿风格）
 * 📩 我就只会补兵                 ← 只留游戏角色名
 * 你干嘛呢
 * （微信安卓 荣耀王者）
 *
 * 回复：引用这条消息，或发 #营地回复 1580886057 <内容>
 * ```
 *
 * ⚠️ **引用回复靠的是下面这段文字正文**（认 `📩` 抬头 + 营地号 + 发信人昵称，
 *    见 apps/campIm.js 的 replyByQuote）—— 所以卡片图只是好看，正文一个字都不能省。
 * ⚠️ **图渲染/发送失败要降级成纯文字** —— 不能因为一张图发不出去就把消息丢了。
 */
import path from 'node:path'
import { Config, PluginPath } from '#components'
import authStore from './authStore.js'
import { sendPrivate } from './privateMsg.js'
import { addRef, setLastPush, getLastPush as storeGetLastPush } from './campImStore.js'
import { sendMaster } from './masterMsg.js'
import { qlogoUrl } from './avatar.js'
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
  const title = clip(msg.fromRoleName, 16) || clip(msg.fromUserId, 12)
  const body = msg.text || '（空消息）'

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

  return { caption, fallbackText: fallbackLines.join('\n'), image, name: title, sub, message: body }
}

/**
 * 把整条营地消息（头像 + 昵称 + 来源 + 正文）渲染成一张卡片（营地绿风格，webp）。
 *
 * 图只是好看，认收件人靠的是图下文字（见文件头注释）；渲染失败返回 '' 让上游降级。
 *
 * @param {{image?:string, name:string, sub?:string, message?:string}} card
 * @returns {Promise<string|Buffer>} 云崽 segment 的图，或 ''（失败）
 */
async function renderCard (card) {
  try {
    return await puppeteer.screenshot('gok-camp-im-msg', {
      // 见 apps/campFriend.js 的说明：_res_path 是「从 temp/html/<name>/ 回到 resources」的相对路径
      tplFile: path.join(PluginPath, 'resources', 'html', 'campImMsg.html'),
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      imgType: getImgType(),
      avatar: card.image || '',
      name: card.name || '营地好友',
      sub: card.sub || '',
      message: card.message || '（空消息）'
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
  const owner = ownerOf(msg.selfUserId)
  if (!owner) return { ok: false, reason: 'no_owner' }   // 无归属 → 按约定不管

  const { caption, fallbackText, image, name, sub, message: body } = buildContent(msg)
  // 正文已经渲染进图，所以没头像也照样出图（图里有 🎮 占位）；只有配置里关了才不出
  const withImage = pushImageEnabled()

  // ① 带图发：整条消息渲染成卡片；渲染挂了、又恰好有头像 URL 就退回裸头像
  let sent = { ok: false, reason: 'skip_image' }
  if (withImage) {
    let pic = await renderCard({ image, name, sub, message: body })
    if (!pic && image) pic = segment.image(image)   // 渲染失败且有头像 → 裸头像兜底
    if (pic) {
      try {
        const message = [pic, caption]
        sent = await sendPrivate(owner, message, { bot })
      } catch (e) {
        sent = { ok: false, reason: e?.message || 'image_failed' }
      }
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
      + `发信人：${msg.fromRoleName || msg.fromUserId}\n内容：${msg.text}`
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
    nick: String(msg.fromRoleName || ''),
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
