/**
 * 王者营地每日签到。
 *
 * ## 两条入口
 *
 * | 入口 | 签谁 | 结果送哪 |
 * |---|---|---|
 * | `#王者签到` 指令 | **发指令的人名下**的号 | **回原会话**（群里发就回群、私聊发就回私聊） |
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
import apiService from '../utils/api.js'
import { signOneAccount, summarizeViews, groupByOwner } from '../utils/campSignTask.js'
import { buildSignView, isSignedToday } from '../utils/campSign.js'
import { sendPrivate } from '../utils/privateMsg.js'
import { sendMaster } from '../utils/masterMsg.js'

/** 定时签到时间的配置键（锅巴「营地签到」区块） */
const KEY_CRON = 'campSignCron'

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function cfg () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
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
   */
  async checkStatus (e) {
    const accounts = this.#myAccounts(e)
    if (!accounts.length) return this.#noAccountHint(e)

    const views = []
    for (const account of accounts) {
      const { campId, name } = labelOf(account)

      try {
        const info = (await apiService.getCampSignInfo(campId))?.data || {}
        const signed = isSignedToday(info.weekSignMap)

        views.push({
          name,
          campId,
          info,
          // 判不了就别硬报「未签」
          stateClass: signed === null ? 'fail' : (signed ? 'done' : 'new'),
          stateText: signed === null ? '数据异常' : (signed ? '今天已签' : '今天还没签')
        })
      } catch (error) {
        logger.warn(`[王者签到] ${campId} 查状态失败: ${error?.message || error}`)
        views.push({
          name, campId, stateClass: 'fail', stateText: '查询失败',
          failReason: apiService.formatUserFacingError(error)
        })
      }
      await sleep(GAP_MS)
    }

    await this.#render(e, views, { mode: 'status' })
  }

  /**
   * `#王者签到` —— 给发指令的人名下每个号签一遍，结果回**原会话**。
   *
   * 每个号的失败都在 `signOneAccount` 内部吃掉了，
   * 一个号挂了不影响后面的号 ——「微信号签上了、QQ 号没签上」必须如实分开报。
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

      await this.#render(e, views, { mode: 'sign', ...summarizeViews(views) })
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
      logger.info(
        `[${PluginName}] 营地自动签到完成：签上 ${stats.okCount} / 已签 ${stats.alreadyCount} / ` +
        `没角色 ${stats.noRoleCount} / 失败 ${stats.failCount}`
      )

      await this.#notifyOwners(pairs)
      await this.#notifyMasterOrphans(pairs)
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
   *    真失败了要说（要他处理）。「本来已签」「没绑角色」都是**日常状态**，
   *    天天推等于骚扰 —— 跳过。
   */
  async #notifyOwners (pairs) {
    const grouped = groupByOwner(pairs)

    for (const [owner, views] of grouped) {
      if (!owner) continue   // 无主号交给 #notifyMasterOrphans

      const needTell = views.filter(v => v.signed || (!v.noRole && !v.already))
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
   */
  async #notifyMasterOrphans (pairs) {
    const orphans = pairs.filter(pair => !String(pair.account?.ownerBotUserId || '').trim())
    if (!orphans.length) return

    const lines = []
    for (const { view } of orphans) {
      if (view.signed) {
        const gifts = giftLine(view)
        lines.push(`${view.campId}：签到成功${gifts ? `，${gifts}` : ''}`)
      } else if (!view.noRole && !view.already) {
        lines.push(`${view.campId}：${view.stateText}${view.failReason ? ` —— ${view.failReason}` : ''}`)
      }
    }

    // 全是「已签」「没角色」时 lines 是空的 —— 没新信息就不打扰主人
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

export default CampSignIn
