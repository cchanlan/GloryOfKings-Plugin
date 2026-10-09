/**
 * 王者营地每日签到。
 *
 * ## 三条入口
 *
 * | 入口 | 签谁 | 结果送哪 |
 * |---|---|---|
 * | `#王者签到` 指令 | **发指令的人名下**的号 | **回原会话**（群里发就回群、私聊发就回私聊） |
 * | `#开启/关闭王者自动签到` | 改定时开关（改配置 + 立刻重排 job） | 回原会话一句确认 |
 * | 每日定时任务 | 池子里**所有**有号主的号 | **私聊各自的号主** |
 *
 * ## 为什么必须按 owner 分流
 *
 * 签到状态**绑在具体营地号上**（`/operation/action/signinfo` 读的就是请求方那个号的签到图），
 * 所以「谁扫的号签谁名下」是硬约束：拿全局号去签等于替别人签、还会读到别人的状态。
 * `ownerBotUserId` 在扫码全局登录时写入（口径同 `#营地观战` 的 `myWatchers`）。
 *
 * ⚠️ **无主号**（2026-09-17 之前扫的、没有 `ownerBotUserId`）：
 * · 指令里靠 `includeOrphan: e.isMaster` 兜给主人
 * · 定时任务里**只报给主人**（走 `sendMaster`，它自己按 `masterMsg.js` 的口径收口）
 *
 * ## 签的动作只有一份
 *
 * 「角色列表 → 查状态 → 没签才签」这套顺序（以及背后的 `roleId` 必需、
 * `-105204 是缺参数不是没权限`）全在 `utils/campSignTask.js` 的 `signOneAccount` 里。
 * 指令和定时都调它 —— 两处各写一份必然漂移。
 *
 * ## 没绑王者角色的号：**全程静默**
 *
 * 它既不出现在签到图里、也不出现在私聊里（2026-10-10 主人要求：
 * 「没有角色的直接静默处理，不需要渲染也不需要告知，直接跳过」）。
 * 判据只认 `/game/rolelist` 的 `20001.roles` 为空 ——
 * ⚠️ **不能**用 `signinfo` 的 `weekSignMap === '0000000'` 代替：
 * 「有角色但从没签过的新号」长得一模一样（实测对照见 `utils/campSignTask.js`）。
 * 所以「探测」照跑（省不掉那次请求），**跳过的是展示**。
 *
 * ## 定时开关：`#开启/关闭王者自动签到`
 *
 * ⚠️ 这两个指令跟 `#王者签到` **完全无关** —— 后者只是手动签一次，不改配置。
 * 自动签到的开关是配置项 `campSignCron`（锅巴「营地签到」区块，默认 `0 30 7 * * *`）。
 *
 * 改配置后**必须让 job 立刻重排**（`utils/taskCtl.js`），否则：
 *   · 空配置时加载 → 用户运行中「开启」→ job 从没注册过，永远不跑
 *   · 非空配置时加载 → 用户运行中「关闭」→ job 还挂着，第二天照样私聊
 * 另有一道**运行时闸门**（`autoSign` 开头查配置）兜底，双保险。
 *
 * ## 定时任务「一切正常就不打扰」
 *
 * 天天推一条「今天已签」是骚扰。私聊只在两种情况发：
 *   · 真签上了（他领到奖励了，值得说一声）
 *   · 真失败了（要他处理）
 * 「本来已签」「没绑王者角色」都是日常状态，**跳过**。
 * 一轮跑完在日志里留一行汇总，主人自查看日志就够。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { shouldQuote, getImgType, AT_HEAD, AT_TAIL } from '#utils'
import { Config, PluginName } from '#components'
import authStore from '../utils/authStore.js'
import { signOneAccount, probeAccount, summarizeViews, groupByOwner } from '../utils/campSignTask.js'
import { buildSignView } from '../utils/campSign.js'
import { sendPrivate } from '../utils/privateMsg.js'
import { sendMaster } from '../utils/masterMsg.js'
import { hotBox } from '../utils/hotState.js'
import { rescheduleOwnTask, isCronOn } from '../utils/taskCtl.js'

/** 定时签到时间的配置键（锅巴「营地签到」区块） */
const KEY_CRON = 'campSignCron'

/** 默认的自动签到时间（锅巴里那个 placeholder 跟这里要一致，改一处就要改两处） */
const DEFAULT_CRON = '0 30 7 * * *'

/** 账号之间的间隔，别把营地接口打急了（api.js 自己也有节流，这里是额外保险） */
const GAP_MS = 1500

/**
 * 互斥锁锚在 `globalThis` 上，**不用实例私有字段**。
 *
 * 原因同 `apps/campRenew.js` 的 renewLock：JiuLi 热重载会给 `plugins/` 下每个模块
 * 追加 `?jiuli_reload=<代数>` 重新求值整张模块图，实例私有字段跨模块代次完全独立 ——
 * 老代次那个已经在跑的不会被新代次的锁挡住，而一轮签到几十秒的窗口足够重叠。
 */
const LOCK_KEY = '__gokCampSignLock'
const signLock = (globalThis[LOCK_KEY] ||= { running: false })

/**
 * 实例登记处 —— 给 `guoba.support.js` 的保存钩子用。
 *
 * ⚠️ 为什么不直接 `import('../index.js')` 拿 apps：`index.js` 顶层有
 *    `await loadModules()` 之类副作用，而 guoba.support.js 是被锅巴用
 *    **带 query 的动态 import** 加载的，反向 import 入口可能触发第二次求值。
 *    `hotBox` 本来就是为「跨模块实例共享一份状态」造的（pushStore 已在用），
 *    这里正好是它的适用场景：构造函数里**覆盖**登记，热重载后拿到的永远是最新实例。
 */
const instanceBox = hotBox('campSignInstance', { current: null })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function cfg () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/**
 * 写 `campSignCron` 配置。成功返回 true。
 *
 * ⚠️ 走 `Config.modify`（锅巴同一条写路径）。自己写 yaml 会绕过框架的
 *    缓存与热重载通知，出现「面板显示旧的、实际是新的」这种最难查的错。
 */
function writeCron (cron) {
  try {
    Config.modify('config', KEY_CRON, String(cron || ''))
    return true
  } catch (error) {
    logger.error(`[${PluginName}] 写 ${KEY_CRON} 失败: ${error?.message || error}`)
    return false
  }
}

/**
 * cron → 人话时间，用在回复里。
 *
 * ⚠️ 只认自家那几种形状（`秒 分 时 日 月 周`），认不出就**原样回显 cron** ——
 *    瞎猜一个「每天 0:00」比直接给 cron 更误导（用户会照错的去等）。
 *    主人自己在锅巴里填的任意 cron 都该能显示，所以兜底必须是原串。
 */
function humanCron (cron) {
  const raw = String(cron || '').trim()
  const parts = raw.split(/\s+/)
  if (parts.length < 6) return raw

  const [sec, min, hour, day, month, week] = parts
  const isNum = v => /^\d+$/.test(v)

  // 每天固定时间：秒 分 时 都是数字、日 月 是 *
  if (isNum(sec) && isNum(min) && isNum(hour) && day === '*' && month === '*' && week === '*') {
    return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`
  }

  return raw
}

/** 账号显示名：营地昵称 > 登录名 > 只有ID */
function labelOf (account) {
  const campId = String(account?.userId || '')
  const name = String(account?.nickname || account?.userName || '').trim()
  return { campId, name: name || campId }
}

/** 「今日奖励」拼成一行（私聊文案用，跟出图那边的口径一致） */
function giftLine (view) {
  const gifts = Array.isArray(view?.signGifts) ? view.signGifts : []
  if (!gifts.length) return ''

  return gifts
    .map(g => {
      const name = String(g?.giftText || g?.name || '').trim()
      if (!name) return ''
      const num = String(g?.giftNum ?? g?.packageNum ?? '').trim()
      return num && num !== '1' ? `${name}x${num}` : name
    })
    .filter(Boolean)
    .join(' + ')
}

export class CampSignIn extends plugin {
  constructor () {
    super({
      name: '王者营地签到',
      dsc: '王者营地每日签到（可定时自动签，结果私聊号主）',
      event: 'message',
      priority: 0,
      rule: [
        // ⚠️ 两条开关指令必须排在 `#王者签到` / `#王者签到状态` **前面**：
        //    框架按注册顺序匹配，虽然 `#(?:开启...)王者自动签到` 跟 `#王者签到`
        //    实际不冲突（前缀不同），但「自动签到」里含「签到」二字，
        //    放前面是**零成本的保险** —— 将来谁把 `#王者签到` 那条改宽就会出事。
        {
          reg: new RegExp(`${AT_HEAD}#(?:开启|打开|启用)王者自动签到${AT_TAIL}`),
          fnc: 'enableAuto'
        },
        {
          reg: new RegExp(`${AT_HEAD}#(?:关闭|关掉|停用)王者自动签到${AT_TAIL}`),
          fnc: 'disableAuto'
        },
        {
          // ⚠️⚠️ 只认带「王者」前缀的写法，**不注册裸 `#签到状态`**。
          //    本机实测（2026-10-10）xhh-TL 的米游社插件注册了
          //    `^\s*#?(?:自动)?签到(?:列表|状态|查询)\s*$` —— 裸 `#签到状态`
          //    是**它的**指令。王者这边 priority 更高（0 vs -Infinity），
          //    抢过来只会让想查米游社的人莫名其妙收到一张营地签到图。
          reg: new RegExp(`${AT_HEAD}#王者签到状态${AT_TAIL}`),
          fnc: 'checkStatus'
        },
        {
          // 同理只认 `#王者签到`。裸 `#签到` 太泛，任何插件都可以合理地用它
          reg: new RegExp(`${AT_HEAD}#王者签到${AT_TAIL}`),
          fnc: 'signIn'
        }
      ]
    })

    // 把自己登记进 hotBox，供锅巴保存钩子在「刚开启自动签到」时调用
    instanceBox.current = this

    // cron 留空 = 关掉定时（collectTask 只收 cron 和 fnc 都有值的项）
    this.task = [
      {
        name: '王者营地每日签到',
        cron: String(cfg()[KEY_CRON] || ''),
        fnc: () => this.autoSign(),
        log: false
      }
    ]
  }

  /** 卸载 / 热重载时释放锁，避免老代次卡住导致新代次永远跳过（框架 loader.js 会调） */
  async onUnload () {
    signLock.running = false
  }

  /**
   * 「配置里的 cron 变了，让 job 跟上」—— 给 `guoba.support.js` 的保存钩子调。
   *
   * ⚠️⚠️ **锅巴那条路也必须重排**（2026-10-10 补）：面板保存只写配置的话，
   *    「配置原本为空 → 面板里填上时间」这个最常见的操作会让 job **从来没注册过** ——
   *    面板显示开着、配置也是对的，但第二天早上什么都不发生。
   *    而闸门（`autoSign` 开头那句）只挡「配置空」，挡不住「配置非空但没 job」。
   *
   * ⚠️ 包一层而不是让锅巴直接 import `utils/taskCtl.js`：
   *    `this.task[0]` 这个下标只该在本文件里出现 —— 别处各写一次，
   *    将来 task 数组加一项就会有人拿错（跟 `instanceBox` 那条注释同一个道理）。
   *
   * @param {string} cron 配置里的新值（空 = 关）
   * @returns {Promise<boolean>} 是否重排成功
   */
  async syncTaskCron (cron) {
    return rescheduleOwnTask(this.task[0], cron)
  }

  /**
   * `#开启王者自动签到` —— 打开定时，并**当场先签一次**。
   *
   * ⚠️ 跟锅巴面板那个保存钩子走**同一条路**（`signNowAfterEnable`）：
   *    两边都只改配置的话，行为会漂移（一边当场签、一边不签），
   *    而用户分不清自己是从哪儿开的。
   *
   * ⚠️ 写配置用 `Config.modify`（跟锅巴同一条写路径），**不自己写 yaml** ——
   *    自己写会绕过框架的缓存与热重载通知，出现「面板显示旧的、实际是新的」。
   */
  async enableAuto (e) {
    // 已经是开着的就别重复触发一轮签到（可能正撞上定时那轮，白等十几秒）
    if (isCronOn(cfg()[KEY_CRON])) {
      return e.reply(
        `自动签到已经开着啦（每天 ${humanCron(cfg()[KEY_CRON])}）\n`
        + '想改时间：锅巴面板 → 王者荣耀 → 营地签到\n'
        + '想手动签一次：发 #王者签到',
        shouldQuote()
      )
    }

    const ok = writeCron(DEFAULT_CRON)
    if (!ok) return e.reply('写入配置失败，去锅巴面板里开一下试试', shouldQuote())

    await rescheduleOwnTask(this.task[0], DEFAULT_CRON)

    await e.reply(
      `自动签到已开启（每天 ${humanCron(DEFAULT_CRON)}）\n`
      + '现在先签一次，结果私聊你\n'
      + '想改时间：锅巴面板 → 王者荣耀 → 营地签到',
      shouldQuote()
    )

    // 回复先发出去，再跑签到（不然用户要盯着「已开启」等十几秒才等到第二条）
    this.signNowAfterEnable()
  }

  /**
   * `#关闭王者自动签到` —— 关掉定时。
   *
   * ⚠️ 关掉**不会**取消已经排上的那一轮，也不会撤回已经发出的私聊 ——
   *    那都是「关之前」发生的事，用户能理解；含糊其辞反而让人以为没关掉。
   */
  async disableAuto (e) {
    if (!isCronOn(cfg()[KEY_CRON])) {
      return e.reply(
        '自动签到本来就是关着的\n发 #王者签到 可以手动签一次',
        shouldQuote()
      )
    }

    const ok = writeCron('')
    if (!ok) return e.reply('写入配置失败，去锅巴面板里关一下试试', shouldQuote())

    await rescheduleOwnTask(this.task[0], '')

    await e.reply(
      '自动签到已关闭，之后不会再自动签\n'
      + '随时发 #王者签到 手动签，或发 #开启王者自动签到 重新打开',
      shouldQuote()
    )
  }

  /**
   * 「刚打开自动签到，先当场签一次」—— 给 `guoba.support.js` 的保存钩子调。
   *
   * ⚠️ 为什么需要：定时下一次触发可能是**明天早上 7:30**，主人刚开完开关却什么都
   *    看不到，会以为没生效（2026-10-10 主人提的诉求）。
   *
   * ⚠️ **故意不 await**：保存请求要立刻返回（不然锅巴转圈转到用户以为卡死），
   *    而这一轮要打十几个营地请求、跑十几秒。结果照常走私聊，跟定时任务同一条路。
   *
   * @returns {boolean} 是否真的排上了一次（false = 已有一轮在跑）
   */
  signNowAfterEnable () {
    if (signLock.running) {
      logger.info(`[${PluginName}] 刚开启自动签到，但已有一轮在跑，跳过这次即时签到`)
      return false
    }

    this.autoSign().catch(error => {
      logger.error(`[${PluginName}] 开启自动签到后的即时签到出错: ${error?.message || error}`)
    })

    return true
  }

  /**
   * 发指令的人名下、能用的营地号。
   *
   * `includeOrphan: true` 只给主人 —— 2026-09-17 之前扫的全局账号没有
   * `ownerBotUserId`，那时只有主人能发全局登录，所以那批无主号算主人的。
   * 这跟 `#营地观战` 的 `myWatchers` 是同一个口径，别各写一份。
   */
  #myAccounts (e) {
    return authStore.listGlobalAccountsByOwner(String(e.user_id), {
      includeOrphan: Boolean(e.isMaster)
    })
  }

  /** 名下没有可用营地号时的统一提示 */
  async #noAccountHint (e) {
    await e.reply([
      '还没有登录过王者营地号，先扫码登录一个再签到：',
      '微信：#营地wx全局登录',
      'QQ：#营地QQ全局登录',
      '登录成功后重发 #王者签到 即可。'
    ].join('\n'), shouldQuote())
  }

  /**
   * `#王者签到状态` —— 只看不签，完全不发写请求。
   *
   * 存在的意义：想确认「还差几天满签」时有一条不产生副作用的路，
   * 而且它绝不撞频控。
   *
   * ⚠️ 跟 `#王者签到` 共用 `probeAccount()`（查角色 → 查状态）。
   *    早先这里**只查 signinfo 不查 rolelist**，于是「没绑王者角色的号」会以
   *    「今天还没签」的姿态出现在图上 —— 用户照着去签，只会再被告知签不了。
   *    现在统一走 probe，没角色的号被 `noRole` 标出来、静默跳过。
   */
  async checkStatus (e) {
    const accounts = this.#myAccounts(e)
    if (!accounts.length) return this.#noAccountHint(e)

    const views = []
    for (const account of accounts) {
      const { campId, name } = labelOf(account)
      views.push(await probeAccount(campId, { name }))
      await sleep(GAP_MS)
    }

    // ⚠️ 没绑王者角色的号**静默跳过**（2026-10-10 主人要求）
    const shown = views.filter(view => !view.noRole)
    if (!shown.length) {
      return e.reply(
        '名下这些营地号都还没绑定王者角色，签不了\n'
        + '先在王者里用这个号登录一次，再发 #王者签到',
        shouldQuote()
      )
    }

    await this.#render(e, shown, { mode: 'status' })
  }

  /**
   * `#王者签到` —— 给发指令的人名下每个号签一遍，结果回**原会话**。
   *
   * 每个号的失败都在 `signOneAccount` 内部吃掉了，
   * 一个号挂了不影响后面的号 ——「微信号签上了、QQ 号没签上」必须如实分开报。
   *
   * ⚠️ 没绑王者角色的号**静默跳过**（2026-10-10 主人要求）：
   *    它既不进图、也不进文字、也不算进任何计数。
   *    但**必须照样走一遍 `signOneAccount`** —— 只有它才知道这个号有没有角色
   *    （判据在 `/game/rolelist`，省不掉这次请求）。跳过的是**展示**，不是探测。
   */
  async signIn (e) {
    const accounts = this.#myAccounts(e)
    if (!accounts.length) return this.#noAccountHint(e)

    // 跟定时任务共用一把锁：撞上定时轮次时让指令这边明确回一句，
    // 不能像定时那样静默跳过（玩家在等回复）
    if (signLock.running) {
      await e.reply('上一轮签到还在跑，稍等一下再发', shouldQuote())
      return
    }

    signLock.running = true
    try {
      const views = []
      for (const account of accounts) {
        const { campId, name } = labelOf(account)
        views.push(await signOneAccount(campId, { name }))
        await sleep(GAP_MS)
      }

      // 探测照跑（上面），但**没角色的号不出现在结果里**
      const shown = views.filter(view => !view.noRole)
      if (!shown.length) {
        return e.reply(
          '名下这些营地号都还没绑定王者角色，签不了\n'
          + '先在王者里用这个号登录一次，再发 #王者签到',
          shouldQuote()
        )
      }

      await this.#render(e, shown, { mode: 'sign', ...summarizeViews(shown) })
    } finally {
      signLock.running = false
    }
  }

  /**
   * 每日定时任务：给池子里所有能用的号签一遍，**私聊各自的号主**。
   *
   * 三条规矩：
   *   ① **一切正常就不打扰** —— 签上的 / 真失败的才私聊（见 `#notifyOwners`）
   *   ② 无主号的结果只报给主人，且走 `sendMaster` 收口（不群发给每个主人）
   *   ③ 一轮跑完在日志里留一行汇总
   */
  async autoSign () {
    if (signLock.running) {
      logger.warn(`[${PluginName}] 上一轮营地签到还没跑完，本轮跳过`)
      return
    }

    // ⚠️⚠️ **运行时闸门**（2026-10-10）：配置关了就直接返回，不管 job 有没有被摘掉。
    //    这是 `#关闭王者自动签到` 的第二道保险 —— 万一重排失败（框架 loader 路径变了、
    //    `createTask` 改名了），job 还挂在调度器里，光靠重排就会出现
    //    「用户以为关了、第二天照样收到私聊」。那种错比没有这个开关更让人恼火。
    //    `#开启` 那边同理：配置为空时 collectTask 根本没注册过 job，
    //    闸门不会误挡（它是「配置空才挡」）。
    if (!isCronOn(cfg()[KEY_CRON])) {
      logger.debug(`[${PluginName}] 自动签到已关闭，本轮不跑`)
      return
    }

    signLock.running = true
    try {
      // ⚠️ 用 listAccounts()（池子里全部）而不是 listGlobalAccountsByOwner：
      //    定时任务要覆盖所有号，包括无主号。authInvalid 的跳过 ——
      //    登录态已失效的号签也是白签，还白吃一次频控。
      const accounts = authStore.listAccounts().filter(account => !account?.authInvalid)
      if (!accounts.length) {
        logger.info(`[${PluginName}] 营地自动签到：账号池里没有可用账号，跳过`)
        return
      }

      const pairs = []
      for (const account of accounts) {
        const { campId, name } = labelOf(account)
        pairs.push({ account, view: await signOneAccount(campId, { name }) })
        await sleep(GAP_MS)
      }

      const stats = summarizeViews(pairs.map(pair => pair.view))
      // ⚠️ 没绑角色的号**静默**：不进私聊、不进主人汇报，只在日志里留个数
      //    （主人要排查「某个号怎么从来不签」时，日志是唯一的线索）
      logger.info(
        `[${PluginName}] 营地自动签到完成：签上 ${stats.okCount} / 已签 ${stats.alreadyCount} / ` +
        `失败 ${stats.failCount} / 没角色跳过 ${stats.noRoleCount}`
      )

      // 私聊与主人汇报都只看「有角色」的那批 —— 没角色的号连探测结果都不展示
      const shown = pairs.filter(pair => !pair.view?.noRole)
      if (!shown.length) {
        logger.info(`[${PluginName}] 营地自动签到：名下号都没绑王者角色，不打扰任何人`)
        return
      }

      await this.#notifyOwners(shown)
      await this.#notifyMasterOrphans(shown)
    } catch (error) {
      logger.error(`[${PluginName}] 营地自动签到出错: ${error?.message || error}`)
    } finally {
      signLock.running = false
    }
  }

  /**
   * 把结果私聊给各自的号主。
   *
   * ⚠️ **只发「需要他知道」的内容**：签上了要说（他领到奖励了），
   *    真失败了要说（要他处理）。「本来已签」是**日常状态**，天天推等于骚扰 —— 跳过。
   *
   * ⚠️ 传进来的 `pairs` **已经滤掉没绑角色的号**（调用方做的，见 `autoSign`）——
   *    这里不用再判 `noRole`，判了也是死代码。
   */
  async #notifyOwners (pairs) {
    const grouped = groupByOwner(pairs)

    for (const [owner, views] of grouped) {
      if (!owner) continue   // 无主号交给 #notifyMasterOrphans

      const needTell = views.filter(v => v.signed || !v.already)
      if (!needTell.length) continue

      const lines = ['营地签到结果']
      let okCount = 0
      for (const v of needTell) {
        const label = `${v.name}（${v.campId}）`
        if (v.signed) {
          okCount++
          const gifts = giftLine(v)
          lines.push(`${label}：签到成功${gifts ? `，${gifts}` : ''}`)
        } else {
          lines.push(`${label}：${v.stateText}${v.failReason ? ` —— ${v.failReason}` : ''}`)
        }
      }
      if (okCount) lines.push('', `共签上 ${okCount} 个号`)

      const sent = await sendPrivate(owner, lines.join('\n'))
      if (!sent.ok) {
        // 私信发不出去（多半没加机器人好友）→ 转告主人，别静默丢
        logger.warn(`[${PluginName}] 签到结果推给 ${owner} 失败：${sent.reason}`)
        await sendMaster(
          `营地号主 ${owner} 的签到结果推不出去（TA 多半没加机器人好友），内容：\n${lines.join('\n')}`
        )
      }
    }
  }

  /**
   * 无主号的结果只报给主人。
   *
   * ⚠️ 走 `sendMaster`（它按 `utils/masterMsg.js` 的口径收口：勾了取交集、
   *    没勾取第一个、交集空回落第一个），**不要**自己遍历 `cfg.master` ——
   *    那会把账号信息广播给每个主人。
   *
   * ⚠️ 传进来的 `pairs` 同样**已经滤掉没绑角色的号**（见 `autoSign`）。
   */
  async #notifyMasterOrphans (pairs) {
    const orphans = pairs.filter(pair => !String(pair.account?.ownerBotUserId || '').trim())
    if (!orphans.length) return

    const lines = []
    for (const { view } of orphans) {
      if (view.signed) {
        const gifts = giftLine(view)
        lines.push(`${view.campId}：签到成功${gifts ? `，${gifts}` : ''}`)
      } else if (!view.already) {
        lines.push(`${view.campId}：${view.stateText}${view.failReason ? ` —— ${view.failReason}` : ''}`)
      }
    }

    // 全是「已签」时 lines 是空的 —— 没新信息就不打扰主人
    if (!lines.length) return

    await sendMaster([
      `有 ${orphans.length} 个营地号没有归属人，签到结果：`,
      ...lines
    ].join('\n'))
  }

  /**
   * 出图 + 回复。
   *
   * 出图失败退化成纯文字（跟 `#王者帮助` 一个路子）——
   * **签到的结果比图重要**：图挂了也必须告诉用户「签上了没有」，
   * 不能因为截图失败就让这次签到静默消失（写请求已经发出去了）。
   */
  async #render (e, views, meta) {
    const data = buildSignView({
      views,
      mode: meta.mode,
      okCount: meta.okCount || 0,
      alreadyCount: meta.alreadyCount || 0,
      failCount: meta.failCount || 0,
      // 「没绑王者角色」单独透传，别让它混进「没签上」的计数
      noRoleCount: meta.noRoleCount || 0,
      avatar: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${e.user_id}`,
      username: (e.sender?.card || e.sender?.nickname || String(e.user_id))
    })

    let image = null
    try {
      image = await puppeteer.screenshot('campSign', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/CampSign.html',
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        imgType: getImgType(),
        ...data
      })
    } catch (error) {
      logger.error(`[王者签到] 出图失败: ${error.message}`)
    }

    // ⚠️ screenshot 失败返回的是 false 而不是抛错，光看 try/catch 拦不住
    if (image) {
      await e.reply(image, shouldQuote())
      return
    }

    await e.reply(data.textFallback, shouldQuote())
  }
}

/**
 * 取当前签到实例（锅巴保存钩子用）。
 *
 * 单独导出而不是让 guoba.support.js 自己 import hotState：
 * **box 的 key 只在这里出现一次**，两边各写一个字符串迟早会漂移
 * （一边改了一边没改 = 静默取不到实例）。
 */
export function currentCampSignInstance () {
  return instanceBox.current || null
}

export default CampSignIn
