/**
 * #王者拉黑 / #王者取消拉黑 / #王者黑名单（主人指令）
 *
 * 名单存在 config.yaml 的 blackList 里，锅巴面板也能直接改（两边是同一份）。
 * 真正的拦截不在这个文件：指令走 utils/blackList.js 里 guardApps 套的闸门，
 * 推送在各自遍历订阅的地方跳过。这里只负责增删查和文案。
 */
import { AT_HEAD, AT_TAIL, stripAtText, pickAtText, resolveTargetUserId, shouldQuote } from '#utils'
import {
  getBlackList,
  addBlackUser,
  removeBlackUser,
  followGlobalBlack,
  getHostBlackList
} from '../utils/blackList.js'

/** 名单太长时只列前这么多个，剩下的让主人去锅巴看 */
const LIST_LIMIT = 30

export class GokBlackList extends plugin {
  /** 别给这个类套黑名单闸门，否则名单管理会被名单自己锁住 */
  static skipBlackGuard = true

  constructor () {
    super({
      name: '王者黑名单',
      dsc: '拉黑某人，让他触发不了王者插件的任何功能',
      event: 'message',
      // 完整锚定的短指令要抢在 queryGameStats 那些宽匹配前面
      priority: 0,
      rule: [
        {
          reg: `${AT_HEAD}#王者(拉黑|加黑|禁用)\\s*(\\d*)${AT_TAIL}`,
          fnc: 'add',
          permission: 'master'
        },
        {
          reg: `${AT_HEAD}#王者(取消拉黑|解除拉黑|解黑|取消禁用)\\s*(\\d*)${AT_TAIL}`,
          fnc: 'remove',
          permission: 'master'
        },
        {
          reg: '^#王者黑名单(列表)?$',
          fnc: 'list',
          permission: 'master'
        }
      ]
    })
  }

  /**
   * 解析这条指令要操作谁：真 at 段 > 指令后直接写的 QQ 号 > 纯文本 @昵称。
   *
   * 真 at 优先于文本里的数字：昵称本身就是一串数字的人不少，
   * 反过来先认数字会把「@12345678」这种昵称当成 QQ 号。
   * @returns {Promise<{userId?: string, hint?: string}>}
   */
  async pickTarget (e) {
    if (e.at && !e.atme) return { userId: String(e.at) }

    const digits = stripAtText(e.msg).match(/(\d{5,12})(?!\d)/)
    if (digits) return { userId: digits[1] }

    const { userId, hint } = await resolveTargetUserId(e, { requireMaster: true })
    // hint 非空 = @ 了人但没认出来。它自带的兜底文案是查询语境的（让用户补营地ID），
    // 在这里得换成「写 QQ 号」
    if (hint) {
      return { hint: `没找到「${pickAtText(e.msg)}」这个人，请从 @ 列表里点选对方，或者在指令后面写上他的 QQ 号` }
    }
    if (String(userId) === String(e.user_id)) {
      return { hint: '要操作谁呢？@ 他一下，或者在指令后面写上他的 QQ 号' }
    }

    return { userId: String(userId) }
  }

  /** #王者拉黑@某人 */
  async add (e) {
    const { userId, hint } = await this.pickTarget(e)
    if (hint) return e.reply(hint, shouldQuote())

    const result = addBlackUser(userId)
    if (result === 'exists') {
      return e.reply(`${userId} 已经在王者黑名单里了`, shouldQuote())
    }
    if (result !== 'ok') {
      return e.reply('没认出要拉黑的人，请 @ 他一下再发一次', shouldQuote())
    }

    return e.reply([
      `已拉黑 ${userId}`,
      '他发的王者指令都不会有回应，之前订阅的战绩推送、日报周报月报也会停下来，群报和排行榜里也不再统计他',
      '订阅还留着，想恢复发送 #王者取消拉黑@他'
    ].join('\n'), shouldQuote())
  }

  /** #王者取消拉黑@某人 */
  async remove (e) {
    const { userId, hint } = await this.pickTarget(e)
    if (hint) return e.reply(hint, shouldQuote())

    const result = removeBlackUser(userId)
    if (result === 'absent') {
      // 只在插件名单里没找到，但人可能是被机器人全局黑名单挡着的，得说清楚
      const inHost = followGlobalBlack() && getHostBlackList().includes(String(userId))
      return e.reply(
        inHost
          ? `${userId} 不在王者黑名单里，他是被机器人的全局黑名单挡住的，去那边解除`
          : `${userId} 不在王者黑名单里`,
        shouldQuote()
      )
    }
    if (result !== 'ok') {
      return e.reply('没认出要操作的人，请 @ 他一下再发一次', shouldQuote())
    }

    return e.reply(`已把 ${userId} 移出王者黑名单，他的指令和之前订阅的推送都恢复了`, shouldQuote())
  }

  /** #王者黑名单 */
  async list (e) {
    const list = getBlackList()
    const hostCount = followGlobalBlack() ? getHostBlackList().length : 0

    const lines = list.length
      ? [
          `📕 王者黑名单（${list.length} 人）`,
          ...list.slice(0, LIST_LIMIT).map(id => `· ${id}`),
          list.length > LIST_LIMIT ? `……还有 ${list.length - LIST_LIMIT} 人，完整名单去 #王者设置 里看` : ''
        ]
      : ['王者黑名单是空的']

    if (hostCount) lines.push(`另外机器人全局黑名单里的 ${hostCount} 人也一样不响应`)
    lines.push('拉黑发送 #王者拉黑@某人，取消发送 #王者取消拉黑@某人')

    return e.reply(lines.filter(Boolean).join('\n'), shouldQuote())
  }
}
