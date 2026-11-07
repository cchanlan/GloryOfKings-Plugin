/**
 * 私聊签到报告失败时，只选一个能确认号主在场的共同群，不使用落盘群索引。
 * gl/gml 支持 Yunzai 的数字 ID 和 TRSS/JiuLi 的聚合列表；缓存缺失才查成员表。
 * 仅在 Linux/JiuLi 上运行验证，其他框架和字符串 ID 分支以适配器桩验证。
 */
import { normalizeId, pickGroupSafe } from './adapter.js'

export async function randomCommonGroup (owner, bot = globalThis.Bot) {
  const uid = String(owner ?? '').trim()
  if (!uid || !bot) return null

  let groups
  let cache
  try {
    groups = Array.from(bot.gl?.entries?.() || []).filter(([, info]) => !info?.guild)
  } catch (error) {
    globalThis.logger?.warn?.(`[签到回报] 获取群列表失败：${error?.message || error}`)
    return null
  }
  try { cache = bot.gml } catch { /* 缓存不可用时问适配器 */ }

  // Fisher–Yates：随机排列后取第一个确认在群的，避免固定落到群列表首项。
  for (let i = groups.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[groups[i], groups[j]] = [groups[j], groups[i]]
  }
  for (const [groupId, info] of groups) {
    if (!String(groupId ?? '').trim()) continue
    try {
      // 聚合列表的 bot_id 指回真正持有该群的账号，不能随机换机器人发送。
      const sender = (info?.bot_id && bot[info.bot_id]) || bot
      let members = cache?.get?.(groupId) || cache?.get?.(String(groupId)) || cache?.get?.(normalizeId(groupId))
      if (!members?.size || typeof members.has !== 'function') {
        const group = pickGroupSafe(groupId, sender)
        members = await group?.getMemberMap?.()
      }
      if (!members?.has?.(uid) && !members?.has?.(normalizeId(uid))) continue
      return { groupId: String(groupId), botId: String(info?.bot_id || '') }
    } catch (error) {
      globalThis.logger?.debug?.(`[签到回报] 查询共同群 ${groupId} 失败：${error?.message || error}`)
    }
  }
  return null
}
