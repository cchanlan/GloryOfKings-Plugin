/**
 * 王者营地每日签到（`#王者签到` / `#王者签到状态`）。
 *
 * ## 谁能签、签的是谁
 *
 * 签到状态**绑在具体营地号上**（`/operation/action/signinfo` 读的就是请求方
 * 那个号的签到图），所以：
 *
 *   · **只能用「发指令的人自己名下」的营地号**（`ownerBotUserId` 等于他的 QQ，
 *     口径同 `#营地观战` 的 `myWatchers`）。拿全局号去签等于替别人签，
 *     还会读到别人的状态。
 *   · 名下**有多个号就挨个签**（一个人可能微信、QQ 各一个营地号）。
 *   · 一个号都没有 → 直接提示去扫码登录，不要落到
 *     「未找到可用的营地登录态」那句技术报错上。
 *
 * ## roleId 是必需参数（别被错误文案骗了）
 *
 * `newsignin` 不带 `roleId` 时服务端回的是
 * `-105204 未授权营地，请前往游戏修改授权设置后重试` —— 看着像权限问题，
 * **实际是缺参数**。2026-10-10 逐组对照实测：body 里只补一个 `roleId`，
 * 返回就从 `-105204` 变成 `-105203 请勿重复签到`（参数齐了）。
 * 而且**只有 body 里的 `roleId` 管用**，`gameRoleId`/`areaId`/`serverId`
 * 以及请求头里的那套 `gameroleid`/`gameserverid` 通通不算数。
 * 所以每次签到前先用 `/game/rolelist` 现取一次角色ID。
 *
 * ## 判据都在 utils/campSign.js
 *
 * 字段解读（周图下标、错误码分流、奖励拼串、出图数据装配）全是纯函数放在那边，
 * 由 `test/campSign.test.mjs` 钉住；这个文件只管指令编排、请求和回复。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { shouldQuote, getImgType, AT_HEAD, AT_TAIL } from '#utils'
import authStore from '../utils/authStore.js'
import apiService from '../utils/api.js'
import {
  isSignedToday, pickMainRole, classifySignCode, buildSignView
} from '../utils/campSign.js'

/** 账号显示名：营地昵称 > 登录名 > 只有ID */
function labelOf (account) {
  const campId = String(account?.userId || '')
  const name = String(account?.nickname || account?.userName || '').trim()
  return { campId, name: name || campId }
}

export class CampSignIn extends plugin {
  constructor () {
    super({
      name: '王者营地签到',
      dsc: '王者营地每日签到',
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
   * 拉一个账号的签到状态（只读）。
   * 返回 `{ info, error }` —— 失败不抛，交给调用方决定怎么报，
   * 好让「一个号挂了」不影响「另一个号能出图」。
   */
  async #fetchInfo (campId) {
    try {
      return { info: (await apiService.getCampSignInfo(campId))?.data || {}, error: null }
    } catch (error) {
      logger.warn(`[王者签到] ${campId} 查状态失败: ${error?.message || error}`)
      return { info: null, error: apiService.formatUserFacingError(error) }
    }
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
      const { info, error } = await this.#fetchInfo(campId)

      if (error) {
        views.push({ name, campId, stateClass: 'fail', stateText: '查询失败', failReason: error })
        continue
      }

      const signed = isSignedToday(info.weekSignMap)
      views.push({
        name, campId,
        // 状态标签：判不了就别硬报「未签」
        stateClass: signed === null ? 'fail' : (signed ? 'done' : 'new'),
        stateText: signed === null ? '数据异常' : (signed ? '今天已签' : '今天还没签'),
        info
      })
    }

    await this.#render(e, views, { mode: 'status' })
  }

  /**
   * `#王者签到` —— 挨个给名下每个号签到。
   *
   * 顺序：角色列表 → 签到状态 →（没签才）签到。
   * 每个号都包在自己的 try 里，一个号失败不影响后面的号 ——
   * 「微信号签上了、QQ 号没签上」这种部分成功必须如实分开报。
   */
  async signIn (e) {
    const accounts = this.#myAccounts(e)
    if (!accounts.length) return this.#noAccountHint(e)

    const views = []
    let okCount = 0
    let alreadyCount = 0
    let failCount = 0

    for (const account of accounts) {
      const { campId, name } = labelOf(account)

      try {
        // ① 先拿角色ID —— newsignin 必需，缺了会回那句骗人的 -105204
        const role = pickMainRole(await apiService.getRoleList(campId))
        if (!role?.roleId) {
          views.push({
            name, campId, stateClass: 'fail', stateText: '没有王者角色',
            failReason: '这个营地号还没绑定王者角色，先在游戏里登录一次再来签'
          })
          failCount++
          continue
        }

        // ② 查状态，已签就不发写请求（少一次请求 = 少一分撞频控的风险）
        const { info, error } = await this.#fetchInfo(campId)
        if (error) {
          views.push({ name, campId, stateClass: 'fail', stateText: '查询失败', failReason: error })
          failCount++
          continue
        }

        if (isSignedToday(info.weekSignMap) === true) {
          views.push({
            name, campId, stateClass: 'done', stateText: '今天已签',
            info, roleName: role.roleName
          })
          alreadyCount++
          continue
        }

        // ③ 真签到
        const res = await apiService.doCampSign(campId, role.roleId)
        const verdict = classifySignCode(res?.returnCode)

        if (verdict === 'ok') {
          views.push({
            name, campId, stateClass: 'new', stateText: '签到成功',
            roleName: role.roleName,
            // 签到成功后服务端会回一份新的状态字段，直接用它拼图
            info: {
              ...info,
              weekSignMap: res?.data?.userSign || info.weekSignMap,
              seqSignDays: res?.data?.seqSignDays ?? info.seqSignDays,
              userTotalSign: res?.data?.totalSignDays ?? info.userTotalSign
            },
            signGifts: Array.isArray(res?.data?.giftList) ? res.data.giftList : [],
            signDate: res?.data?.signDate || ''
          })
          okCount++
        } else if (verdict === 'already') {
          // 服务端说今天签过了 —— 也算正常结果（可能刚在别处签的）
          views.push({
            name, campId, stateClass: 'done', stateText: '今天已签',
            info, roleName: role.roleName
          })
          alreadyCount++
        } else if (verdict === 'too-fast') {
          views.push({
            name, campId, stateClass: 'fail', stateText: '操作太频繁',
            info, roleName: role.roleName,
            failReason: '这次请求得太快了，过一会儿再发一次 #王者签到'
          })
          failCount++
        } else if (verdict === 'missing-role') {
          // roleId 传了还不认 —— 通常是角色和登录态对不上
          views.push({
            name, campId, stateClass: 'fail', stateText: '角色签不了',
            info, roleName: role.roleName,
            failReason: '这个角色签不了，去营地 App 里确认一下角色绑定'
          })
          failCount++
        } else {
          views.push({
            name, campId, stateClass: 'fail', stateText: '签到失败',
            info, roleName: role.roleName,
            failReason: `${res?.returnMsg || `错误码 ${res?.returnCode}`}`
          })
          failCount++
        }
      } catch (error) {
        logger.warn(`[王者签到] ${campId} 失败: ${error?.message || error}`)
        views.push({
          name, campId, stateClass: 'fail', stateText: '签到失败',
          failReason: apiService.formatUserFacingError(error)
        })
        failCount++
      }
    }

    await this.#render(e, views, { mode: 'sign', okCount, alreadyCount, failCount })
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
