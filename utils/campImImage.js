/**
 * 营地图片消息的解析 —— 从消息原文里提取图片地址。
 *
 * ## 背景：营地的图片消息**正文是空的**
 *
 * 实测（2026-10-14，营地好友发来的游戏截图）：
 * ```
 * { type: 'photo', typeName: '[我发送了一张图片]', message: '',
 *   links: [[7, 0, 0, '{"origin":"https://chat-1255653016.cos.ap-guangzhou.myqcloud.com/…/xxx.png",
 *                  "thumb":"…/xxx.png?imageMogr2/thumbnail/!30p",
 *                  "width":1290,"height":2796,"type":0,"scale":1}']] }
 * ```
 * `message` 是**空串**，真正的地址在 `links` 里。
 *
 * ⚠️ 这就是「别人发的图片收不到」的根因：下游只认 `message`，空正文被当
 *    「空消息」丢掉，`links` 从头到尾没人读 —— 图片消息就凭空消失了。
 *
 * ## 取哪个地址
 *
 * **`origin`（原图）优先，不用 `thumb`** —— 缩略图是 CDN 的 30% 缩放
 * （实测 1290×2796 的截图缩成 387×839），游戏截图上的字根本看不清。
 * 原图实测 218KB，直接发 QQ 没问题。
 */

/**
 * links 里一项有两种形态（**2026-10-13 实测对比出来的，都要认**）：
 *
 * ```js
 * // ① 在线推送（ws 推来的 param）—— 裸数组
 * [7, 0, 0, '{"origin":"…"}']
 *
 * // ② 离线补拉（/chatserver/offline/singlemsg 的 data.list[]）—— 多包一层 linkData
 * { linkData: ['7', '0', '0', '{"origin":"…"}'] }   // 注意协议码还是字符串
 * ```
 *
 * ⚠️⚠️ **漏了 ② 的后果**（这个 bug 真出现过）：断线超 60 秒重连后补拉回来的
 *    图片消息会解析不出图 → 被判成空消息**静默丢掉** —— 表现是「在线收得到图、
 *    断线之后那段时间的图全没影」。两条路径的数据源是同一个营地接口家族，
 *    但序列化形态不一样，必须都覆盖。
 *
 * 前三项是协议码（实测 `7/0/0`）—— **不要依赖它们的值**，也不认固定下标：
 * 只扫数组里的字符串项，谁解析得出图片地址就用谁。
 * 这样营地哪天调整前缀，这里不用跟着改。
 */
function parseLinkItem (item) {
  if (!item || typeof item !== 'object') return null
  // ② 离线补拉：{ linkData: [...] }
  const arr = Array.isArray(item) ? item : item.linkData
  if (!Array.isArray(arr)) return null
  for (const cell of arr) {
    if (typeof cell !== 'string') continue
    const pic = parseImageMeta(cell)
    if (pic) return pic
  }
  return null
}

/** 一串文本能不能解析成图片元信息；不是就返回 null */
function parseImageMeta (text) {
  const s = String(text || '').trim()
  // 便宜的前置筛：元信息一定以 `{` 开头，省得对每个字符串都跑 JSON.parse
  if (!s.startsWith('{')) return null
  let meta
  try { meta = JSON.parse(s) } catch { return null }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null

  const origin = String(meta.origin || '').trim()
  const thumb = String(meta.thumb || '').trim()
  const url = origin || thumb
  // 只认 http(s) 绝对地址：坏数据里的空串 / 相对路径发出去就是个裂图
  if (!/^https?:\/\//i.test(url)) return null

  return {
    url,
    origin,
    thumb,
    width: Number(meta.width) || 0,
    height: Number(meta.height) || 0
  }
}

/**
 * 从一条营地消息（或它的 `raw` 原文）里提取图片地址。
 *
 * 两种调用形态都吃：消息对象（`{ raw: {...} }`）和原始 param（直接就是 `{ links }`）——
 * 免得每个调用点都写一遍 `msg.raw ?? msg`。
 *
 * @param {object} msg 服务端给的消息对象，或它的 raw 原文
 * @returns {Array<{url:string, origin:string, thumb:string, width:number, height:number}>}
 */
export function extractImages (msg) {
  const links = msg?.links ?? msg?.raw?.links
  if (!Array.isArray(links)) return []
  const out = []
  for (const item of links) {
    const pic = parseLinkItem(item)
    if (pic) out.push(pic)
  }
  return out
}

/**
 * 图片消息在卡片 / 纯文字里的占位标记。
 *
 * 正文用 `[图片]` 而不是原文的 `typeName`（`[我发送了一张图片]`）——
 * 那个是**发件人视角**的文案（营地给发件人自己也推一份），对收件的归属人来说
 * 「我」字完全错位（2026-10-14 实测确认）。
 */
export function photoMark (n = 1) {
  return n > 1 ? `[图片 ×${n}]` : '[图片]'
}
