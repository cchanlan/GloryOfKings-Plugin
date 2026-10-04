/**
 * 读「被引用消息」的原文。
 *
 * 两处要用，所以抽成共用：
 *   · `apps/campIm.js` —— 引用营地推送直接回信
 *   · `apps/watchBattle.js` —— 引用开播提示发 `#营地开播`，**按提示里那个人名精确挑回那一场**
 *
 * ⚠️⚠️ 为什么观战那边非读不可（2026-10-05 修）：`#营地开播` 原先只开「本群最近提示的那一场」，
 *    而一个群里订阅了上下线提醒的人往往不止一个 —— A 开局发了提示、B 开局又发一条，
 *    用户看着 A 那条发指令，开出来的却是 B（主人反馈的「提示开播这个人却开了另一个人」）。
 *    现在把被引用提示的原文读出来、认出里面的人名，再去服务端按名字挑回原来那一场。
 *
 * 各家适配器给的口子不一样，逐个试：
 *   · `e.getReply()` —— 云崽 loader 在收到 reply 段时挂的（`loader.js:367`）
 *   · `bot.getMsg(id)` / `e.group.getMsg(id)` / `e.friend.getMsg(id)`
 *   · `bot.sendApi('get_msg')` —— Gscore-Adapter 走这条
 *   · `getChatHistory` —— 部分适配器只给这条
 *
 * ⚠️ 全失败要返回 null（不是 ''）—— 调用方靠它区分「读不到」和「读到空的」。
 */
export async function readQuoted (e) {
  const refId = e?.reply_id
  if (!refId) return null

  const bot = e.bot || globalThis.Bot

  // ① 云崽自带的（yenai 也走这条，实测能拿到东西）
  try {
    if (typeof e.getReply === 'function') {
      const t = flattenMsg(await e.getReply())
      if (t) return t
    }
  } catch { /* 换下一条路 */ }

  // ② 适配器各自的
  for (const fn of [
    () => bot?.getMsg?.(refId),
    () => e.group?.getMsg?.(refId),
    () => e.friend?.getMsg?.(refId),
    () => bot?.sendApi?.('get_msg', { message_id: refId }),
    () => e.group?.getChatHistory?.(e.source?.seq, 1),
    () => e.friend?.getChatHistory?.(e.source?.time, 1)
  ]) {
    try {
      let r = await fn()
      if (Array.isArray(r)) r = r.pop()        // 聊天记录返回的是数组
      const t = flattenMsg(r)
      if (t) return t
    } catch { /* 换下一条路 */ }
  }

  return null
}

/** 把各种形状的「消息」对象拍平成纯文本；拍不出东西返回 '' */
export function flattenMsg (r) {
  if (!r) return ''
  if (typeof r === 'string') return r

  // OneBot 的 get_msg 返回：{ message: [...], raw_message: '...' }
  if (typeof r.raw_message === 'string' && r.raw_message) return r.raw_message
  if (typeof r.message === 'string') return r.message

  const arr = Array.isArray(r.message)
    ? r.message
    : Array.isArray(r.msg_elements) ? r.msg_elements : null
  if (!arr) return ''

  return arr.map(seg => {
    if (!seg) return ''
    if (typeof seg === 'string') return seg
    if (seg.type === 'text') return seg.text ?? seg.data?.text ?? ''
    return ''
  }).join('')
}

/** 有引用消息时它的 id（各家适配器字段不一样，挨个试） */
export function quotedId (e) {
  return e?.reply_id || e?.source?.message_id || e?.source?.seq || ''
}
