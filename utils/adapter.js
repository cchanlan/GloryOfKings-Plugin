/**
 * 跨适配器安全地取群 / 群成员。
 *
 * 为什么不能直接 `Bot.pickGroup(Number(groupId))`：
 * 官方 QQ 机器人（QQBot 适配器）的 group_id 是 openid、user_id 是 `appid:openid`，
 * 两者都不是数字。`Number()` 出来是 NaN，pickGroup(NaN) 拿不到真群，
 * 于是整条推送（战绩推送 / 日报 / 群报）静默发不出去 —— 日志里只有一句
 * 「取不到群」，看着像是群没了。
 *
 * 反过来在 icqq / OneBot 下群号确实是数字，历史上有适配器用 `Map<number, ...>`
 * 存群列表，传字符串会 miss，所以也不能一律传字符串。
 * 正确顺序就是先判断「长得像不像数字 ID」再决定传什么，
 * 和 utils/avatar.js 里 getGroupAvatar 的做法一致。
 *
 * 成员昵称同理：`pickMember(Number(qq))` 在官bot 下必然 NaN。
 */
import { isQQNumber } from './avatar.js'

/** 数字 ID 传 Number、其他形态（openid / wxid）原样传字符串 */
export function normalizeId (id) {
  const text = String(id ?? '').trim()
  if (!text) return ''
  return isQQNumber(text) ? Number(text) : text
}

/**
 * 取群对象。
 * @param {string|number} groupId
 * @param {object} [bot] 指定 bot 实例（多账号下应传 e.bot / Bot[uin]），默认全局 Bot
 * @returns {object|null} 取不到返回 null
 */
export function pickGroupSafe (groupId, bot = null) {
  const gid = normalizeId(groupId)
  if (!gid) return null

  const host = bot || (typeof Bot !== 'undefined' ? Bot : null)
  try {
    return host?.pickGroup?.(gid) || null
  } catch (err) {
    logger?.debug?.(`[王者] pickGroup(${groupId}) 失败: ${err.message}`)
    return null
  }
}

/**
 * 取群成员对象。
 * @param {string|number} groupId
 * @param {string|number} userId
 * @param {object} [bot]
 */
export function pickMemberSafe (groupId, userId, bot = null) {
  const uid = normalizeId(userId)
  if (!uid) return null

  const group = pickGroupSafe(groupId, bot)
  try {
    return group?.pickMember?.(uid) || null
  } catch (err) {
    logger?.debug?.(`[王者] pickMember(${groupId}, ${userId}) 失败: ${err.message}`)
    return null
  }
}

/**
 * 取一个人在群里的显示名（群名片优先），取不到时给一个不难看的兜底。
 *
 * 兜底刻意不回落成原始 ID：官bot 的 user_id 是 `appid:openid`，
 * 直接画到图上是一长串十六进制，比「召唤师」难看得多。
 *
 * @param {object} [group] 已有的群对象（e.group），有就不用再 pick
 * @param {string|number} userId
 * @param {string} [fallback] 取不到且 ID 不是 QQ 号时用的名字
 */
export async function resolveMemberName (group, userId, fallback = '召唤师') {
  const uid = normalizeId(userId)

  try {
    const member = group?.pickMember?.(uid)
    // getInfo 各适配器有的同步有的异步，info 属性也不一定有，全都试一遍
    const info = member?.info || (await member?.getInfo?.())
    const name = info?.card || info?.nickname || member?.card || member?.nickname
    if (name) return String(name)
  } catch (err) {
    logger?.debug?.(`[王者] 取成员昵称失败 ${userId}: ${err.message}`)
  }

  return isQQNumber(userId) ? String(userId) : fallback
}
