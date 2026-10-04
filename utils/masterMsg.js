/**
 * 私聊给主人发消息，并**真实判断有没有送达**。
 *
 * ⚠️ `Bot.sendMasterMsg` 全失败也会 resolve 成功：它内部塞进返回值里的
 * `ret[bot_id][user_id]` 是**没 await 的 promise**，外面那层 allSettled 对它无效。
 * 所以必须自己再收一次。不这么做的话，「主人根本没加机器人好友」这种情况会表现为
 * 「状态文件显示已提醒、日志里一行都没有」——最难查的那类问题。
 */

/**
 * @param {string} message
 * @returns {Promise<boolean>} 至少有一个主人收到了
 */
export async function sendMaster (message) {
  if (typeof Bot !== 'object' || typeof Bot.sendMasterMsg !== 'function') return false

  try {
    const ret = await Bot.sendMasterMsg(message, Bot.uin, 0)
    const results = await Promise.allSettled(
      Object.values(ret || {}).flatMap(perBot => Object.values(perBot || {}))
    )
    return results.some(item => item.status === 'fulfilled')
  } catch (error) {
    logger?.warn?.(`[王者插件] 私聊主人失败：${error?.message || error}`)
    return false
  }
}
