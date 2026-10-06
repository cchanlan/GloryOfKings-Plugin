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

/**
 * 互斥锁锚在 `globalThis` 上，不用实例私有字段。
 *
 * 原因同 `apps/campIm.js` 的 pollState：JiuLi 热重载会给 `plugins/` 下每个模块追加
 * `?jiuli_reload=<代数>` 重新求值整张模块图，`#renewRunning` 是**实例私有字段**，
 * 跨模块代次完全独立 —— 老代次那个已经在跑的 `#renewOnce` 不会被新代次的锁挡住。
 * 一轮保活 30 秒起（2N+2 次请求 × 1.5s 间隔），窗口不算短，重叠了就把营地请求量翻倍。
 *
 * ⚠️ 说明：2026-10-05 排查过的「两条保活 MARK 只差 116ms」**不是**这个问题 ——
 *    复核（2026-10-06）确认那两行之间夹着 45 次进程启动，属于不同的 JiuLi 进程，
 *    原注释「不同日志文件里同一时刻的行」的判断是对的。这里纯属把锁的作用域
 *    跟 pollState 对齐，不宣称修掉了那次现象。
 */
const RENEW_LOCK_KEY = '__gokCampRenewLock'
const renewLock = (globalThis[RENEW_LOCK_KEY] ||= { running: false })

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
    // ⚠️ 先测锁再回话：上一轮还在跑时直接交给 renew 回「还在跑」，
    //    不能先回「正在保活」又改口「还在跑」，两条回复自相矛盾
    if (renewLock.running) {
      return await this.renew({ e })
    }
    await e.reply('正在保活（每个号戳一下，顺便抢救失效的 QQ 号）…', shouldQuote())
    return await this.renew({ e })
  }

  /**
   * 统一入口（定时任务和指令都走这里）：先查互斥锁，再把活交给 #renewOnce。
   * 上一轮没跑完这一轮直接跳过 —— 并发跑的代价见 renewLock 的注释。
   *
   * @param {object}  [opts]
   * @param {object}  [opts.e]      有就是指令触发的（结果回群里），没有就是定时任务（私聊主人）
   * @param {boolean} [opts.silent] 定时模式下**一切正常就不打扰主人**（有事才说话）
   */
  async renew (opts = {}) {
    if (renewLock.running) {
      logger.warn(`[${PluginName}] 上一轮营地保活还没跑完，本轮跳过`)
      // 手动触发时回一句，免得主人以为指令没生效；定时任务重叠就只在日志里留痕
      if (opts.e) await opts.e.reply('上一轮保活/续期还在跑，等它结束再试', shouldQuote())
      return
    }

    renewLock.running = true
    try {
      return await this.#renewOnce(opts)
    } finally {
      renewLock.running = false
    }
  }

  /** 卸载 / 热重载时释放锁，避免老代次卡住导致新代次永远跳过（框架 loader.js 会调） */
  async onUnload () {
    renewLock.running = false
  }

  /** 保活的正体（参数见 renew）。只在 renew 的互斥锁里调用，别直接调。 */
  async #renewOnce ({ e = null, silent = false } = {}) {
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
    // ⚠️ 实测口径（2026-10-06 复核后订正了原先那句「一次推进 2 格」）：
    //    轮转只发生在**一处** —— `utils/api.js` 的 `#rotateGlobals`（:1268），
    //    每次 `#auth.candidates()`（即每次请求）游标 `+1`（`this.#globalCursor += 1`）。
    //    `utils/authStore.js` 的 `getAuthCandidates`（:826）**刻意不轮转**（那里 :858 有明确说明），
    //    所以「一次请求推进 2 格」的说法是错的 —— 每次请求只推进 1 格。
    //    那么 N 次就足以覆盖 N 个号，`2N+2` 是**超额覆盖**（多戳一轮），
    //    不算 bug、也不打算改：多戳几次没副作用，而账号增删/优先级变化时余量更稳。
    //    （`authStore.#rotateGlobals` / `#globalCursor` 是死代码，本类里没有调用点。）
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
      // ⚠️ 拆开判断（2026-10-06 修）：原先 `!isQQ || !hasTokens` 把「平台不是 qq」和
      //    「三件套不齐」合并成一条，于是 loginPlatform 缺失（手工补录 / 锅巴导入 / 早期版本
      //    写进去的空值）的失效 QQ 号既不尝试重登，又被报成「没有三件套，救不了」——
      //    把主人往错误方向带。
      const platform = String(acc.loginPlatform || '')
      const hasTokens = Boolean(acc.accessToken && (acc.appOpenid || acc.openId))

      if (platform === 'wechat') {
        deadWx.push(nameOf(acc))
        continue
      }
      if (platform !== 'qq') {
        deadQqFailed.push(`${nameOf(acc)}（平台未知：${platform || '空'}，没按 QQ 重登）`)
        continue
      }
      if (!hasTokens) {
        deadQqFailed.push(`${nameOf(acc)}（没有三件套，救不了）`)
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
