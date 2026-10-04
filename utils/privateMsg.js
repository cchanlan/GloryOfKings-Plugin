/**
 * 私聊发送：仅凭成功回执确认，不把异常原因当成用户的隐私设置。
 * 群临时私聊只尝试 OneBot v11 的私聊 API；不支持时返回失败，绝不改发群消息。
 */
import { normalizeId } from './adapter.js'

/** 各适配器的消息 ID 字段不同，只接受有效标量。 */
function pickMessageId (result) {
  const raw = result?.message_id ?? result?.messageId ?? result?.data?.message_id ?? result?.seq
  if (typeof raw === 'string' && raw.trim()) return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return ''
}

function confirmed (result) {
  return Boolean(result && typeof result === 'object' && !result.error &&
    (result.status === undefined || result.status === 'ok') &&
    (result.retcode === undefined || result.retcode === 0) && pickMessageId(result))
}

function receiptReason (result) {
  return String(result?.message || result?.error ||
    `unconfirmed_receipt: status=${result?.status}, retcode=${result?.retcode}`)
}

/**
 * @param {string|number} userId
 * @param {string} message
 * @param {{bot?: object, groupId?: string|number}} [options]
 * @returns {Promise<{ok: boolean, via?: string, reason?: string, messageId?: string}>}
 * reason 仅供日志；成功回执不代表对方已读。
 */
export async function sendPrivate (userId, message, { bot, groupId } = {}) {
  const target = normalizeId(userId)
  if (!target) return { ok: false, reason: 'no_target' }
  const api = bot || (typeof Bot !== 'undefined' ? Bot : null)
  let reason = 'no_api'

  try {
    const friend = api?.pickFriend?.(target)
    if (typeof friend?.sendMsg === 'function') {
      const result = await friend.sendMsg(message)
      if (confirmed(result)) return { ok: true, via: 'friend', messageId: pickMessageId(result) }
      reason = receiptReason(result)
    }
  } catch (error) {
    reason = error?.message || 'send_failed'
  }
  globalThis.logger?.debug?.(`[王者插件] 私聊 ${target} 未确认成功：${reason}`)

  // sendApi 本身不是 OneBot 能力标识。仅在已知 v11 适配器及数字 QQ/群号下尝试。
  // group_id 是实现相关扩展，支持与否由私聊 API 回执决定，不保证非好友一定能送达。
  const numericId = value => /^\d+$/.test(String(value ?? '')) &&
    Number.isSafeInteger(Number(value)) && Number(value) > 0
  if (api?.adapter?.name === 'OneBotv11' && typeof api.sendApi === 'function' &&
      numericId(target) && numericId(groupId)) {
    try {
      const result = await api.sendApi('send_private_msg', {
        user_id: Number(target),
        group_id: Number(groupId),
        message: [{ type: 'text', data: { text: String(message) } }]
      })
      if (confirmed(result)) {
        return { ok: true, via: 'group_temp', messageId: pickMessageId(result) }
      }
      reason = receiptReason(result)
    } catch (error) {
      reason = error?.message || 'send_failed'
    }
    globalThis.logger?.debug?.(`[王者插件] 群临时私聊 ${target} 未确认成功：${reason}`)
  }
  return { ok: false, reason }
}
