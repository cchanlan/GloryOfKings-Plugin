/**
 * 账号被营地限流（-30107）时的通知。
 *
 * 触发点只有一个：`utils/api.js` 的 `#markRateLimited` —— 那里同时也是「静默 12 小时」的
 * 起点（冷却表里没有这个号 = 刚刚才被限流，见那边的注释）。
 *
 * 两件事：
 * 1. **私信主人**：哪个号被限流了、静默多久。号一旦被限流就 12 小时不参与轮询，
 *    主人有权知道池子少了谁。
 * 2. **只有 1 个全局账号时附一句提示**（可以用扫码登录加号），而且**只提一次** ——
 *    多账号的建议反复念就是骚扰，记在文件里，提过就不再提。
 *
 * 这条消息是给主人看的，不是给群友的，所以可以说实现层面的话（账号 ID、静默时长）。
 */
import path from 'path'
import { PluginData } from '#components'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'
import { sendMaster } from './masterMsg.js'

/** 提醒状态。只存「多账号建议提过没有」，删了会重新提一次，不值得备份 */
const NOTICE_FILE = path.join(PluginData, 'RateLimitNotice.yaml')

/** 和 api.js 的 `#maskUserId` 同一个口径：头 3 尾 3，中间打星 */
function maskUserId (userId) {
  const text = String(userId || '')
  return text.length > 6 ? `${text.slice(0, 3)}***${text.slice(-3)}` : text
}

/**
 * 某个账号刚被限流时通知主人。
 *
 * 不要 await 调用方（api.js 的命中路径是同步的）：发不出去就发不出去，
 * 不该让一条私信拖慢或打断请求链路。sendMaster 内部已经吃掉所有异常并返回布尔。
 *
 * @param {object} opts
 * @param {string} opts.userId 被限流的营地账号 userId
 * @param {number} opts.silenceMs 静默时长（毫秒）
 * @param {number} opts.accountCount 池里现在有几个可用账号
 * @returns {Promise<boolean>} 私信是否至少送到一个主人
 */
export async function notifyAccountRateLimited ({ userId, silenceMs, accountCount }) {
  const state = readNoticeState()

  // 同一个号在静默期内只提醒一次。**这条不是防重复调用，是防重启**：
  // 静默表只活在内存里（api.js），进程一重启它就空了，下一轮轮询会再试探这个号、
  // 再次命中——但那不是新事故，不该再发一条一模一样的私信。
  const notifiedAt = Number(state.notified?.[userId] || 0)
  if (notifiedAt && Date.now() - notifiedAt < Number(silenceMs)) {
    return false
  }

  const hours = Math.round(silenceMs / 3600000)
  const lines = [`营地账号 ${maskUserId(userId)} 被限流，已静默 ${hours} 小时。`]

  // 池里只剩这一个号：静默之后就真没号可用了，得让主人知道能怎么补。
  // 这条建议**全局只发一次**（重启也不会重复念，同样记在这个文件里）。
  // ⚠️ 别在单账号时说「改用其他账号」——根本没有其他账号（实测文案翻过车）。
  const loneAccount = Number(accountCount) <= 1
  let hintSentAt = state.multiAccountHintSentAt || ''
  if (loneAccount) {
    lines.push('静默期间没有别的全局账号可用，查询会提示限流。')
    if (!hintSentAt) {
      lines.push('', '发 #营地wx全局登录 或 #营地QQ全局登录 可以加更多全局账号。')
      hintSentAt = new Date().toISOString()
    }
  } else {
    lines.push('期间自动改用其他全局账号查询，不用处理。')
  }

  writeNoticeState({
    multiAccountHintSentAt: hintSentAt,
    notified: { ...state.notified, [userId]: Date.now() }
  })

  return sendMaster(lines.join('\n'))
}

/** 提醒状态。读不出来就当作空（宁可多提一次，也别让该收到的主人收不到） */
function readNoticeState () {
  try {
    return readYamlFile(NOTICE_FILE) || {}
  } catch {
    return {}
  }
}

function writeNoticeState (state) {
  try {
    writeYamlFile(NOTICE_FILE, state)
  } catch (error) {
    logger?.debug?.(`[王者插件] 记录限流提醒状态失败：${error?.message || error}`)
  }
}
