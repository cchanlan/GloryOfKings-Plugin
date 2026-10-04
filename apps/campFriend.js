/**
 * 营地好友 —— 拉「当前营地号」在游戏里的好友，挑一个发消息。
 *
 * ## 干什么
 *   ① `#营地好友`           出图：现在在游戏里的好友，带编号
 *   ② `#营地私聊 <编号> <内容>`  按编号给 TA 发营地消息
 *
 * ## 用哪个营地号
 * **`#切换营地` 选中的那个**（`UserData.yaml` 的 `ids[current]`）。
 * 主人的多个营地号各有各的好友，不搞并集。
 *
 * ⚠️⚠️ 但它还必须**是扫码登录过的全局账号**（`AuthPool.json` 里有 `token`/`userKey`/`userSig`）——
 *    `#绑定营地` 只存一个营地ID 数字，**没有登录态**，拿它发消息营地会拒
 *    （实测 `-30710 请先绑定手机`）。所以 `#context` 里要再查一次
 *    `listGlobalAccountsByOwner`（跟 `#营地观战` 同一个口径）。
 *
 * ## 「在线」的判据
 * `gameOnline === 1`（王者客户端开着）。**不是** `appOnline`（那是营地 App 在线，
 * 跟游戏是两回事），也**不是**「有 battleId」（那只是正在对局中，比在线窄）。
 *
 * ## 为什么好友数据要问服务端
 * 营地接口的签名头要用账号自己的 `userKey` 现算，这套逻辑只有服务端
 * （`server-im` / `server`）有；插件端没有等价实现。
 *
 * ## 编号映射为什么落盘
 * 主人看完列表可能过几分钟才发 `#营地私聊 3 你好`，中间插件可能重启。
 * 存 `campImStore`（TTL 10 分钟），按「发起人 + 用哪个营地号」分开存 ——
 * 主人换 `#切换营地` 之后编号指向的人完全不一样，混了会发错人。
 */
import path from 'node:path'
import { PluginName, PluginPath } from '#components'
import { getImgType, shouldQuote, getCurrentId } from '#utils'
import * as client from '../utils/campImClient.js'
import * as store from '../utils/campImStore.js'
import authStore from '../utils/authStore.js'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'

/** 好友列表最多列几个（图太长没法看） */
const MAX_ROWS = 20

/**
 * 营地单条消息的字数上限。
 * 实测 2026-09-20：200 字能发，202 字就被拒（返回「发送字数超过限制」）。
 * 超了营地会回一个 **URL 编码的**错误文本，直接甩给用户没法看，所以这里先拦。
 */
const MAX_MSG_LEN = 200

export class CampFriend extends plugin {
  constructor () {
    super({
      name: '王者营地好友',
      dsc: '拉当前营地号在游戏里的好友，挑一个发营地消息',
      event: 'message',
      priority: 0,
      rule: [
        // ⚠️ 两条都限**私聊**（`message.private`）—— 好友名单是个人隐私，
        //    在群里发出来等于把「你有哪些好友、谁在打游戏」公开了。
        //    发消息同理：群里发 `#营地私聊 1 xxx` 会让所有人看到你在跟谁说话。
        //    ⚠️ 注意是**规则级** event，不是插件级的 —— 别写到上面的 super 里。
        { reg: '^#营地好友$', fnc: 'list', event: 'message.private' },
        { reg: '^#营地私聊\\s*(\\d+)\\s+([\\s\\S]+)$', fnc: 'chat', event: 'message.private' }
      ]
    })
  }

  /**
   * 取这次要用哪个营地号 —— **就是 `#切换营地` 选中的那个**。
   *
   * ⚠️⚠️ 两个前提都得满足，缺一个都不行：
   *    ① `#切换营地` 选中了它（`UserData.yaml` 的 `ids[current]`）
   *    ② 它是**扫码登录过的全局账号**（`AuthPool.json` 里有 `token`/`userKey`/`userSig`）
   *
   *    ⚠️ 这两个**完全不是一回事**：`#绑定营地` 只存一个营地ID 数字，**没有登录态**，
   *       拿它发消息会被营地拒（实测 `-30710 请先绑定手机`）。
   *       所以这里必须再查一次 `listGlobalAccountsByOwner`，跟 `#营地观战` 同一个口径。
   *
   * ⚠️ **不做「退到名下第一个号」的兜底** —— 那样主人选了 A 号却拉到 B 号的好友，
   *    比直接报错更难排查。选中的号没登录就明确让他去登录。
   *
   * ⚠️ `includeOrphan` 只给主人开：2026-09-17 之前扫的全局账号没记 `ownerBotUserId`，
   *    而那时只有主人能发全局登录，所以那批无主的号一律算主人的。
   */
  #context (e) {
    const uid = String(e.user_id || '')
    const selfUserId = String(getCurrentId(uid) || '')

    if (!selfUserId) {
      return {
        error: '要先绑定营地ID\n发 #绑定营地 <你的营地ID> 或 #营地QQ全局登录 扫码'
      }
    }

    // 选中的号必须也是「自己扫码登录过的全局号」—— 绑定表里的号没有登录态，发不了消息
    const mine = authStore
      .listGlobalAccountsByOwner(uid, { includeOrphan: Boolean(e.isMaster) })
      .map(a => String(a.userId))
      .filter(Boolean)

    if (!mine.includes(selfUserId)) {
      return {
        error: `营地号 ${selfUserId} 还没登录过\n发 #营地QQ全局登录 或 #营地wx全局登录 扫码`
      }
    }

    return { uid, selfUserId }
  }

  /** `#营地好友` —— 列出现在在游戏里的好友 */
  async list (e) {
    const ctx = this.#context(e)
    if (ctx.error) return e.reply(ctx.error, shouldQuote())

    let res
    try {
      res = await client.getFriends(ctx.selfUserId)
    } catch (err) {
      return e.reply(client.serviceDownText(err), shouldQuote())
    }
    if (!res?.ok) {
      // ⚠️ 服务端的 error 里可能有「营地返回 -30107」这种内部细节，不能原样甩给用户。
      //    按约定：说清「发生了什么」+「下一步做什么」。
      logger.warn(`[${PluginName}] 拉好友列表失败：${res?.error || '(无)'} code=${res?.code || ''}`)
      if (res?.code === 'no-account') {
        return e.reply(
          `营地号 ${ctx.selfUserId} 还没登录过\n发 #营地QQ全局登录 或 #营地wx全局登录 扫码`,
          shouldQuote()
        )
      }
      return e.reply('拿不到好友列表，稍后再试', shouldQuote())
    }

    const friends = res.friends || []
    if (!friends.length) {
      return e.reply('现在没有好友在游戏里', shouldQuote())
    }

    // 只列前 MAX_ROWS 个（编号也只按这个来）
    const shown = friends.slice(0, MAX_ROWS)
    // ⚠️ 存进映射前把 `battleId` 换成布尔 —— 它只是「在不在对局中」的标记，
    //    而那个值是 `235568_1463845650_1789833537` 这种**带下划线的数字串**，
    //    落盘成 YAML 后别的工具（比如 Python 的 yaml）会当成千位分隔符读成一个天文数字。
    //    存布尔既没这个坑，也够用（编号映射只需要「发给谁」）。
    store.setFriendList(ctx.uid, ctx.selfUserId, shown.map(f => ({
      userId: f.userId,
      roleId: f.roleId,
      nick: f.nick || f.campNick || '',
      inBattle: Boolean(f.battleId)
    })))

    const rows = shown.map((f, i) => ({
      idx: i + 1,
      name: f.nick || f.campNick || '未知',
      avatar: f.avatar,
      jobName: f.jobName || '',
      inBattle: Boolean(f.battleId)
    }))
    // 超出部分要说一声 —— 不然用户以为列表只有这些
    const more = friends.length - shown.length

    let img
    try {
      img = await puppeteer.screenshot('gok-camp-friend', {
        // ⚠️ `tplFile` 走 `fs.readFileSync`（Renderer.js:48），所以绝对路径没问题；
        //    但 `_res_path` 是**拼进 HTML 的 URL**，必须是「从 temp/html/<name>/ 出发
        //    到 resources 的相对路径」—— 渲染产物落在 `./temp/html/gok-camp-friend/`，
        //    往上是三层才到云崽根，再进 plugins/...。
        //    写成绝对路径在 Linux 上碰巧能出图（file:// 认），但换机器/Windows 就废，
        //    跟全项目其他模板的做法也不一致（照抄 WatchBattle）。
        tplFile: path.join(PluginPath, 'resources', 'html', 'campFriend.html'),
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        imgType: getImgType(),
        friends: rows,
        total: res.total || 0,
        more,
        selfUserId: ctx.selfUserId
      })
    } catch (err) {
      logger.error(`[${PluginName}] 好友列表出图失败：${err?.message || err}`)
      img = null
    }

    const tail = '发 #营地私聊 <编号> <内容> 给 TA 发消息'
    if (!img) {
      // 出图挂了退化成文字，别什么都不回
      const lines = rows.map(r => `${r.idx}. ${r.name}${r.jobName ? `（${r.jobName}）` : ''}${r.inBattle ? ' 🎮' : ''}`)
      if (more > 0) lines.push(`…还有 ${more} 人没列出来`)
      return e.reply([`现在在游戏里的好友（${friends.length}）`, '', ...lines, '', tail].join('\n'), shouldQuote())
    }
    await e.reply([img, tail], shouldQuote())
  }

  /** `#营地私聊 <编号> <内容>` */
  async chat (e) {
    const ctx = this.#context(e)
    if (ctx.error) return e.reply(ctx.error, shouldQuote())

    const idx = Number(e.msg.match(/^#营地私聊\s*(\d+)/)?.[1] || 0)
    const text = e.msg.match(/^#营地私聊\s*\d+\s+([\s\S]+)$/)?.[1]?.trim() || ''
    if (!idx || !text) return e.reply('格式：#营地私聊 <编号> <内容>', shouldQuote())

    // ⚠️ 先拦长度：营地超了会回一个 URL 编码的错误，直接甩给用户没法看
    if (text.length > MAX_MSG_LEN) {
      return e.reply(`太长了，最多 ${MAX_MSG_LEN} 个字（现在 ${text.length}）`, shouldQuote())
    }

    const target = store.getFriendByIndex(ctx.uid, ctx.selfUserId, idx)
    if (!target) {
      return e.reply('编号失效了，重新发一次 #营地好友 看编号', shouldQuote())
    }

    let res
    try {
      res = await client.sendMessage({
        selfUserId: ctx.selfUserId,
        toUserId: target.userId,
        toRoleId: target.roleId,
        fromRoleId: '',
        message: text
      })
    } catch (err) {
      return e.reply(client.serviceDownText(err), shouldQuote())
    }

    if (res?.ok) {
      logger.info(`[${PluginName}] 营地私聊：${ctx.selfUserId} → ${target.nick}(${target.roleId}) 发送成功`)
      return e.reply(`已发给 ${target.nick || '对方'}`, shouldQuote())
    }

    // ⚠️ 服务端已经把 URL 编码的错误解开了，但「发送字数超过限制」这类还是别原样甩给用户
    //    （插件端已经先拦过长度，走到这里多半是别的失败）。原因只进日志。
    logger.warn(`[${PluginName}] 营地私聊失败：${res?.error || '(无)'} ${JSON.stringify(res?.raw || {}).slice(0, 200)}`)
    return e.reply('没发出去，稍后再试', shouldQuote())
  }
}
