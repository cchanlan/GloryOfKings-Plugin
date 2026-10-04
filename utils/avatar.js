/**
 * 跨平台头像解析。
 *
 * 背景：插件原来到处硬编码 `https://q1.qlogo.cn/g?b=qq&s=100&nk=${userId}`。
 * 这个地址只对「真实 QQ 号」有效。官方 QQ 机器人（QQBot 适配器）拿到的 user_id
 * 是 openid（32 位十六进制串），不是 QQ 号，喂给 q1.qlogo.cn 不会 404，而是回落
 * 到一张默认头像 —— 于是所有人渲染出来都是同一张图，看着就像「只显示机器人自己的头像」。
 *
 * 正确做法是优先问适配器要：各适配器的 pickMember/pickFriend 都实现了 getAvatarUrl()，
 * 它知道自己平台该拼什么地址（官方机器人是 q.qlogo.cn/qqapp/{appid}/{openid}/100）。
 * 只有在适配器给不出、且 ID 确实长得像 QQ 号时，才回落到 qlogo 拼接。
 */

// QQ 号是 5-12 位纯数字；openid 是 32 位十六进制串，用这个区分
const QQ_NUMBER = /^\d{5,12}$/

export function isQQNumber(id) {
  return QQ_NUMBER.test(String(id ?? '').trim())
}

/** 兜底的 qlogo 地址，仅在 ID 确为 QQ 号时才有意义 */
export function qlogoUrl(userId, size = 100) {
  return isQQNumber(userId)
    ? `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${userId}`
    : ''
}

/** 群头像的公开地址，仅在群号确为数字群号时才有意义（官方机器人的群是 openid，拼不出来） */
export function groupQlogoUrl (groupId, size = 100) {
  const gid = String(groupId ?? '').trim()
  return isQQNumber(gid) ? `https://p.qlogo.cn/gh/${gid}/${gid}/${size}` : ''
}

/**
 * 解析群头像地址，取不到返回空串（模板里 onerror 会把 img 隐藏，露出底下的「群」字占位）
 * @param {string|number} groupId 群号
 * @param {object} [group]        已有的群对象（e.group / Bot.pickGroup 的结果），有就不用再 pick
 * @param {number} [size]         头像尺寸
 */
export async function getGroupAvatar (groupId, group = null, size = 100) {
  const gid = String(groupId ?? '').trim()

  // 1. 问适配器要 —— 和用户头像同一个思路，各平台自己知道该拼什么地址
  try {
    const target = group ?? (isQQNumber(gid) ? Bot?.pickGroup?.(Number(gid)) : Bot?.pickGroup?.(gid))
    const url = await target?.getAvatarUrl?.(size)
    if (url) return url
    if (target?.avatar) return target.avatar
  } catch (err) {
    logger?.debug?.(`[头像] 适配器获取群 ${gid} 头像失败: ${err.message}`)
  }

  // 2. 回落到 p.qlogo.cn 的公开群头像
  return groupQlogoUrl(gid, size)
}

/**
 * 解析目标用户头像地址，取不到返回空串（模板里有 onerror 兜底，会把 img 隐藏）
 * @param {object} e      消息事件
 * @param {string|number} userId 目标用户（可能是 at 的对象，不一定是发送者）
 * @param {number} size   头像尺寸
 */
export async function getUserAvatar(e, userId, size = 100) {
  const target = String(userId ?? '').trim()

  // 1. 问适配器要 —— 官方机器人等非 QQ 号平台只有这条路走得通
  try {
    const picker = e?.group?.pickMember
      ? e.group.pickMember(target)
      : (e?.bot?.pickFriend ? e.bot.pickFriend(target) : null)

    const url = await picker?.getAvatarUrl?.()
    if (url) return url
    if (picker?.avatar) return picker.avatar
  } catch (err) {
    logger?.debug?.(`[头像] 适配器获取失败 ${target}: ${err.message}`)
  }

  // 2. 目标就是发送者本人时，事件里通常已经带了头像
  if (String(e?.user_id ?? '') === target && e?.sender?.avatar) {
    return e.sender.avatar
  }

  // 3. 回落到 qlogo，仅当 ID 确实是 QQ 号
  const fallback = qlogoUrl(target, size)
  if (!fallback) {
    logger?.debug?.(`[头像] ${target} 不是 QQ 号且适配器无头像，返回空`)
  }
  return fallback
}
