/**
 * 营地登录态的**保活 + 续期**（`#营地续期` + 定时任务）。
 *
 * ## 先搞清楚「过期」是怎么发生的
 *
 * 2026-09-19 实测把机制摸清了：
 *   · `/user/login` 恒返回 **`expires = 0`** —— 营地**不给** token 过期时间
 *   · 老的刷新接口 `/user/refreshweixintoken` 已下线（现在报 `rpc name invalid`）
 *   · 所有 `loginType` 变体调 `/user/login` 都**返回原 token**，营地没有「换新 token」这种接口
 *   · 记忆里的失效实例是「**闲置 29 天没人碰**」
 *
 * → 结论：营地 token 是**用则续命、闲置才死**。所以**天天在用的号根本不会过期**，
 *   会死的是「用得少」的号。
 *
 * ## 于是这里做两件事
 *
 * 1. **保活**（对所有号，QQ + 微信都做）：定期调一次轻量接口。因为 api.js 的账号
 *    候选列表是**轮转**的（`getAuthCandidates` 会 `#rotateGlobals`），所以
 *    **发 N 次请求 = N 个号各被用了一次**，不用也不该去指定账号。
 * 2. **续期**（只对 QQ）：万一某个号真的失效了（保活时被标成 `authInvalid`），
 *    QQ 还能用存着的三件套**重登换新 token**救回来（实测可行）；微信没有可重放的
 *    凭证（营地 wx 分支只认扫码换来的 code），失效了只能重新扫码。
 *
 * ⚠️ **重登会顶掉旧 token**（实测重放成功后旧 token 立刻 -30003），所以只在
 *    「确认已失效」时才做，且拿到新凭证必须立刻写回 —— 中间失败那个号就真废了。
 */
import { Config, PluginName } from '#components'
import { shouldQuote } from '#utils'
import authStore from '../utils/authStore.js'
import apiService from '../utils/api.js'
import { reloginQQAccount } from '../utils/qqLogin.js'
import { sendMaster } from '../utils/masterMsg.js'

const KEY_CRON = 'campRenewCron'

/** 每个号之间歇一下，别把营地接口打急了（api.js 自己也有间隔，这里是额外保险） */
const GAP_MS = 1500

function cfg () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const nameOf = acc => `${acc.userId}${acc.userName ? `（${acc.userName}）` : ''}`

export class CampRenew extends plugin {
  constructor () {
    super({
      name: '王者营地登录续期',
      dsc: '营地登录态保活（QQ + 微信），QQ 失效还能自动重登救回',
      event: 'message',
      priority: 0,
      rule: [
        { reg: '^#营地续期$', fnc: 'renewNow', permission: 'master' }
      ]
    })

    // cron 留空 = 关掉定时（collectTask 只收 cron 和 fnc 都有值的项）
    this.task = [
      {
        name: '营地登录态保活',
        cron: String(cfg()[KEY_CRON] || ''),
        fnc: () => this.renew({ silent: true }),
        log: false
      }
    ]
  }

  /** 指令入口：`#营地续期` —— 立刻保活一遍，顺手把失效的 QQ 号救回来 */
  async renewNow (e) {
    await e.reply('正在保活（每个号戳一下，顺便抢救失效的 QQ 号）…', shouldQuote())
    return await this.renew({ e })
  }

  /**
   * 保活的正体。
   *
   * @param {object}  [opts]
   * @param {object}  [opts.e]      有就是指令触发的（结果回群里），没有就是定时任务（私聊主人）
   * @param {boolean} [opts.silent] 定时模式下**一切正常就不打扰主人**（有事才说话）
   */
  async renew ({ e = null, silent = false } = {}) {
    let before = []
    try {
      before = authStore.listAccounts() || []
    } catch (error) {
      logger.error(`[${PluginName}] 保活读账号池失败：${error?.message || error}`)
      return this.#report(e, '❌ 读账号池失败，先看看日志')
    }
    if (!before.length) {
      if (silent) return
      return this.#report(e, '账号池里还没有号')
    }

    // ① 保活：戳 2N+2 次，轮转自然覆盖到每个号
    //
    // ⚠️ 为什么不是「戳 N 次就够」：轮转游标**一次请求推进 2 格**
    //    （`authStore.getAuthCandidates` 里转一次、`api.js` 的 `#getAuthCandidates` 又转一次），
    //    所以 N 次只能覆盖 N/2 个号。2N+2 次保证每个号至少轮到一次。
    // ⚠️ 别改用 `lastSuccessAt` 来判断「谁被戳到了」——它不是每次成功请求都写（只在
    //    authStore 的登录成功路径写），拿它当覆盖率指标会误判（踩过）。
    const times = before.length * 2 + 2
    let reached = 0
    let errors = 0
    for (let i = 0; i < times; i++) {
      try {
        await apiService.keepAlive()
        reached++
      } catch (error) {
        // 单个号失效会让这次请求抛错（api.js 会把它标成 authInvalid），别的号还活着，
        // 所以整轮保活不该因此中断 —— 记一笔继续
        errors++
        logger.debug(`[${PluginName}] 保活第 ${i + 1} 次请求失败：${error?.message || error}`)
      }
      await sleep(GAP_MS)
    }

    // ② 看谁被标成失效了，能救的救回来
    const after = authStore.listAccounts() || []
    const dead = after.filter(a => a?.authInvalid)
    const revived = []
    const deadWx = []
    const deadQqFailed = []

    for (const acc of dead) {
      const isQQ = String(acc.loginPlatform) === 'qq'
      const hasTokens = acc.accessToken && (acc.appOpenid || acc.openId)
      if (!isQQ || !hasTokens) {
        if (String(acc.loginPlatform) === 'wechat') deadWx.push(nameOf(acc))
        else deadQqFailed.push(`${nameOf(acc)}（没有三件套，救不了）`)
        continue
      }
      try {
        const fresh = await reloginQQAccount(acc)
        // ⚠️ 必须立刻写回：重登已经把旧 token 顶掉了，这一步失败 = 这个号废了
        authStore.upsertAccount({ ...fresh, resetAuthState: true })
        revived.push(nameOf(acc))
        logger.mark(`[${PluginName}] 营地登录态已救回：${acc.userId}`)
      } catch (error) {
        deadQqFailed.push(`${nameOf(acc)}：${error?.message || error}`)
        logger.warn(`[${PluginName}] 重登失败 ${acc.userId}：${error?.message || error}`)
      }
      await sleep(GAP_MS)
    }

    logger.mark(`[${PluginName}] 营地保活：${reached} 次请求（失败 ${errors}）、救回 ${revived.length}、待重扫 ${deadWx.length}`)

    // 定时模式下一切正常就闭嘴
    if (silent && !revived.length && !deadWx.length && !deadQqFailed.length && !errors) return

    const lines = [`✅ 保活完成：${reached} 次请求，${before.length} 个号都戳过了`]
    if (revived.length) lines.push('', `🩹 失效的 QQ 号救回来了（${revived.length} 个）：`, ...revived)
    if (deadWx.length) {
      lines.push('', `⚠️ 这些微信号失效了，得重新扫码（${deadWx.length} 个）：`, ...deadWx)
    }
    if (deadQqFailed.length) lines.push('', '❌ 这几个也没救回来：', ...deadQqFailed)

    return this.#report(e, lines.join('\n'))
  }

  /** 有 e 就回群里，没有（定时任务）就私聊主人 */
  async #report (e, text) {
    if (e) return e.reply(text, shouldQuote())
    try {
      await sendMaster(text)
    } catch (error) {
      logger.warn(`[${PluginName}] 保活结果私聊失败：${error?.message || error}`)
    }
  }
}
