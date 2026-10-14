/**
 * 营地**隐私开关**（`#隐私帮助` / `#隐私公开` / `#隐私隐藏` / `#隐藏我的战绩`）。
 *
 * 把营地 App「设置 → 隐私」那 16 项搬到指令上：一条指令就能把战绩对陌生人藏起来，
 * 不用翻 App。读写两条通道的实测结论全在 `utils/campPrivacy.js` 的文件头。
 *
 * ## 为什么**全部指令只在私聊可用**
 *
 *   · 隐私状态本身是个人信息 —— 把「我对谁藏了什么」出图发到群里就没意义了；
 *   · 这些指令是**写操作**，改的是发指令那个人**自己账号**的设置，群里误触代价真实。
 * 所以群里一律拒绝，连状态都不回。帮助图里那条入口照常留着（功能本身不是秘密），
 * 但说明里写明「私聊发」。
 *
 * ## 三条硬约束（踩过才知道的）
 *
 * 1. **必须锁定「这个人当前选中的那个营地号」**，不能走全局账号轮转 ——
 *    隐私是账号级写操作，拿轮转到的号去写等于**改了别人的设置**。
 *    选号口径和 `#营地币` / `#营地兑换` 完全一致（`authStore.getCurrentCampUserId`）。
 * 2. ⚠️⚠️ **菜单读回的 `status` 是假的**（2026-10-14 实测，详见 `utils/campPrivacy.js`
 *    文件头）：别人明明已经看不到战绩了，`getprivacymenu` 还在说「全部联系人可查看」。
 *    所以这里**不显示每档的开关状态**，也**不做「已经是目标状态就跳过」的优化**。
 *    唯一能验证的真实状态是战绩那一块 —— 拿**别人的** token 查
 *    `morebattlelist` 的 `invisible`（`#battleSeenByOthers`），图上第一行就是它。
 * 3. ⭐⭐ **「藏」和「放开」走的不是同一个网关**（见 `utils/campPrivacy.js` 那张表）：
 *    藏走 form 网关、放开走主网关并且**必须带王者主角色的 `roleId`**。
 *    两个方向都是 30 秒左右生效。写请求回成功 ≠ 生效（走错方向也照样回成功），
 *    所以多档改动要先回一句「正在改」，并提醒「别反复发」——
 *    反复发容易撞频控，命中一次这个号静默 12 小时。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { shouldQuote, getImgType, AT_HEAD, AT_TAIL } from '#utils'
import authStore from '../utils/authStore.js'
import apiService from '../utils/api.js'
import {
  parsePrivacyMenu, pickItem, matchDetail, planWrites, describeItem, toCard, isVisibleItem,
  battleVisibility, battleVisibilityText, gatewayFor,
  VISIBLE, HIDDEN, BATTLE_PRIVACY_IDS, WRITE_GAP_MS, EFFECT_DELAY_SEC
} from '../utils/campPrivacy.js'

/**
 * 正在改隐私的营地号。
 *
 * 为什么要锁：一次改动是「读菜单 → 逐档写 → 等生效」，中间好几十秒。
 * 同一个号这期间再来一条指令，第二条读到的还是**改之前**的状态，
 * 于是它算出的「要发哪几发」是基于过期数据的 —— 两条交叉写，结果谁也说不准。
 *
 * ⚠️ 放模块顶层，不能放 constructor —— 云崽**每收到一条消息就 new 一个实例**，
 *    挂在实例上等于每条消息都是一把新锁，锁不住任何东西。
 */
const writing = new Set()

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 私聊上下文：群里改隐私既没意义也容易误触（判据同 apps/dataBackup.js） */
function isPrivate (e) {
  return !e.isGroup && !e.group_id && !e.group
}

export class CampPrivacy extends plugin {
  constructor () {
    super({
      name: '王者营地隐私',
      dsc: '查看与修改营地隐私设置',
      event: 'message',
      // 和插件里其它新指令一致：0 才能排在 queryGameStats 的宽匹配前面。
      // （`#隐藏我的战绩` 实测不会被 `#?(查询|王者)战绩` 系列吃掉 —— 那几条都锚在
      //   开头认「查询/王者/排位/巅峰/查」，但 priority 还是跟着惯例设 0，
      //   免得哪天谁把那边写宽。）
      priority: 0,
      rule: [
        {
          // ⚠️ 要排在「公开/隐藏」两条前面：`#隐私帮助` 里的「帮助」不是编号，
          //    万一将来那两条的参数写宽，先 return 的是这条
          reg: new RegExp(`${AT_HEAD}#?隐私(?:帮助|设置|状态|列表)${AT_TAIL}`),
          fnc: 'showPrivacy'
        },
        {
          // 快捷：一条顶战绩那 4 项（9/10/11/12）的全部档位
          reg: new RegExp(`${AT_HEAD}#?(隐藏|公开)我的战绩${AT_TAIL}`),
          fnc: 'battleShortcut'
        },
        {
          // `#隐私隐藏 1` / `#隐私隐藏 1 陌生人`
          //
          // ⚠️ 编号写成 `\\d*`（可以不给）而不是 `\\d+`：裸发 `#隐私隐藏` 的人
          //    是**忘了带编号**，不认领的话他什么反应都收不到，只会以为指令坏了。
          //    认下来回一句「要带编号」才是有用的反馈。
          reg: new RegExp(`${AT_HEAD}#?隐私(公开|隐藏)\\s*(\\d*)\\s*(\\S*)${AT_TAIL}`),
          fnc: 'setPrivacy'
        }
      ]
    })
  }

  /* ------------------------------------------------------------ 账号与闸门 */

  /** 发指令的人名下的营地号（口径同 `#营地币` / `#王者签到` / `#营地观战`） */
  #myAccounts (e) {
    return authStore.listGlobalAccountsByOwner(String(e.user_id), {
      includeOrphan: Boolean(e.isMaster)
    })
  }

  /**
   * 这个人**当前选中的**营地号。
   *
   * ⚠️ 不能用 `#myAccounts(e)[0]` —— 那个列表按 `isGlobalDefault` → `priority` →
   *    **userId 字典序**排，多号之间前两项往往一样，于是「第一个」由 ID 大小决定，
   *    会把别人的号当成默认号（`#营地币` 2026-10-11 实测踩过）。
   *    改隐私拿错号 = 改了别人的设置，比显示错更严重。
   */
  #currentAccount (e) {
    const accounts = this.#myAccounts(e)
    if (!accounts.length) return null

    const currentId = authStore.getCurrentCampUserId(String(e.user_id))
    if (currentId) {
      const hit = accounts.find(account => String(account.userId) === currentId)
      if (hit) return hit
    }

    return accounts[0]
  }

  /**
   * 三道闸门：私聊、有号、没在改。
   *
   * @returns {Promise<object|null>} 过了就返回账号对象，没过已经回过话了
   */
  async #gate (e) {
    if (!isPrivate(e)) {
      await e.reply('隐私设置只能私聊我发', shouldQuote())
      return null
    }

    const account = this.#currentAccount(e)
    if (!account) {
      await e.reply([
        '还没有登录过王者营地号，先扫码登录一个：',
        '微信：#营地wx全局登录',
        'QQ：#营地QQ全局登录'
      ].join('\n'), shouldQuote())
      return null
    }

    if (writing.has(String(account.userId))) {
      await e.reply('这个号上一条隐私改动还在跑，等它回话再发', shouldQuote())
      return null
    }

    return account
  }

  /** 读一次隐私菜单；读不到就把原因回给用户 */
  async #readMenu (e, campId) {
    try {
      // ⚠️ 必须走主网关 + 锁账号：form 网关那份缺 4 项、也没有 disableModify；
      //    不锁账号会轮转到别人的号（这接口只认自己 token，轮到别人就读不出东西）
      const res = await apiService.campRequest('/user/getprivacymenu', {}, '', campId)
      const menu = parsePrivacyMenu(res?.data)
      if (!menu.items.length) {
        await e.reply('没读到隐私设置，过会儿再试', shouldQuote())
        logger.warn(`[营地隐私] ${campId} 菜单为空: ${JSON.stringify(res).slice(0, 300)}`)
        return null
      }
      return menu
    } catch (error) {
      logger.warn(`[营地隐私] ${campId} 读菜单失败: ${error?.message || error}`)
      await e.reply(`读取隐私设置失败 —— ${apiService.formatUserFacingError(error)}`, shouldQuote())
      return null
    }
  }

  /* ------------------------------------------------------------ 查看 */

  /**
   * 战绩**实际**被挡住没有 —— 图上那行「别人现在能不能看到你的战绩」。
   *
   * ⚠️⚠️ 必须拿**别人的**号去查：营地有「自我豁免」，自己查自己在隐藏态下
   *    照样是 30 场（实测），用本人的号查会恒定得到「没藏」这个错结论。
   * ⚠️ 这是全插件**唯一**能验证的真实隐私状态 —— 菜单读回的 status 是假的
   *    （见 utils/campPrivacy.js 文件头）。其余 12 项没有「他见」接口，查不了。
   *
   * 池里只有自己一个号时查不了，回 `{known:false}`，图上说「这次没查出来」
   * 而不是编一个状态。
   */
  async #battleSeenByOthers (campId) {
    const observer = authStore.listAccounts()
      .find(account => String(account.userId) !== campId && !account.authInvalid)
    if (!observer) return { known: false, hidden: false, count: 0 }

    try {
      const res = await apiService.campRequest('/game/morebattlelist', {
        lastTime: 0, recommendPrivacy: 0, apiVersion: 5, friendUserId: campId, option: 0
      }, '', String(observer.userId))
      return battleVisibility(res)
    } catch (error) {
      logger.warn(`[营地隐私] ${campId} 他见视角查询失败: ${error?.message || error}`)
      return { known: false, hidden: false, count: 0 }
    }
  }

  /** `#隐私帮助` —— 出图：16 项能改什么 + 编号 + 战绩的实际效果 + 怎么改 */
  async showPrivacy (e) {
    const account = await this.#gate(e)
    if (!account) return

    const campId = String(account.userId)
    const menu = await this.#readMenu(e, campId)
    if (!menu) return

    const seen = await this.#battleSeenByOthers(campId)
    const who = String(account.nickname || account.userName || campId)
    await this.#renderPrivacy(e, menu, who, campId, seen)
  }

  async #renderPrivacy (e, menu, who, campId, seen) {
    // ⚠️ 图上**跳过营地不让改 / 改了不拦数据**的项（皮肤 11、日历 15）——
    //    摆着只会让人以为能用（主人 2026-10-14：「无效的直接去掉」）。
    //    编号**不重编**（编的是服务端 id），所以图上会跳号，这是有意的。
    const classes = menu.classes
      .map(cls => ({ className: cls.className, items: cls.items.filter(isVisibleItem) }))
      .filter(cls => cls.items.length)
      .map(cls => ({ className: cls.className, items: cls.items.map(toCard) }))

    let image = null
    try {
      image = await puppeteer.screenshot('campPrivacy', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/CampPrivacy.html',
        // ⚠️ 这个变量**不是宿主注入的**，漏了会出一张完全没样式的纯文字图
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        imgType: getImgType(),
        classes,
        who,
        campId,
        battleText: battleVisibilityText(seen),
        battleHidden: seen.known && seen.hidden,
        battleUnknown: !seen.known,
        avatar: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${e.user_id}`,
        generatedAt: new Date().toLocaleString()
      })
    } catch (error) {
      logger.error(`[营地隐私] 出图失败: ${error.message}`)
    }

    // ⚠️ screenshot 失败是返回 false 而不是抛错，光靠 try/catch 拦不住
    if (image) {
      await e.reply(image, shouldQuote())
      return
    }

    // 文字兜底和出图**用同一份过滤**（`isVisibleItem`）—— 两边漏一边就会出现
    // 「图上看不到、文字版却有」的不一致。跳过的项在这里也不列（无编号可报，
    // 用户真发了那个号会收到 `#setPrivacy` 里的说明）
    const lines = [`营地隐私设置（${who}）`, battleVisibilityText(seen)]
    for (const cls of menu.classes) {
      const items = cls.items.filter(isVisibleItem)
      if (!items.length) continue
      lines.push('', `【${cls.className}】`)
      for (const item of items) lines.push(describeItem(item))
    }
    lines.push('', ...this.#usageLines())
    await e.reply(lines.join('\n'), shouldQuote())
  }

  /** 怎么改 —— 图和文字兜底共用这一份，免得两边说法漂移 */
  #usageLines () {
    return [
      '#隐私隐藏 1 —— 把第 1 项对所有人藏起来',
      '#隐私公开 1 —— 把第 1 项放开给所有人',
      '#隐私隐藏 1 陌生人 —— 只改一档（档位名照图上写）',
      '#隐藏我的战绩 / #公开我的战绩 —— 一条顶战绩那 4 项'
    ]
  }

  /* ------------------------------------------------------------ 修改 */

  /** `#隐私公开 1` / `#隐私隐藏 1 陌生人` */
  async setPrivacy (e) {
    const account = await this.#gate(e)
    if (!account) return

    const text = String(e.msg || '')
    const match = text.match(/隐私(公开|隐藏)\s*(\d*)\s*(\S*)/)
    if (!match) return false

    const status = match[1] === '隐藏' ? HIDDEN : VISIBLE
    const detailName = String(match[3] || '').trim()

    // 忘了带编号（`#隐私隐藏`）—— 直接把用法回给他，别静悄悄什么都不做
    if (!match[2]) {
      await e.reply([
        `要带编号，比如 #隐私${match[1]} 1`,
        '发 #隐私帮助 看每一项的编号'
      ].join('\n'), shouldQuote())
      return
    }

    const no = parseInt(match[2], 10)

    const campId = String(account.userId)
    const menu = await this.#readMenu(e, campId)
    if (!menu) return

    const item = pickItem(menu.items, no)
    if (!item) {
      await e.reply(`没有第 ${no} 项，发 #隐私帮助 看编号`, shouldQuote())
      return
    }

    // 营地自己不让改的项（实测「王者日历」两个网关都回 -20011）：在发请求前就说清楚。
    // 不拦的话用户会收到一句「没改成」，还以为是插件的问题、反复重试
    if (item.unwritable) {
      await e.reply(`「${item.name}」营地不让用指令改，只能在营地 App 里改`, shouldQuote())
      return
    }

    // 写得进去、但服务端不拿它拦数据（实测「皮肤」两条通道都回成功、他见照样读得到）。
    // 这种必须**提前拦掉**：让它「成功」比报错更坏 —— 用户以为藏好了，实际没有。
    // ⚠️ 措辞要说清「不是改不了，是改了没用」——第一版写「改了也没用」，
    //    主人看成了「关了就开不回来」，两种意思差得远。
    if (item.ineffective) {
      await e.reply(
        `「${item.name}」这项营地不受它约束：设成隐藏，别人照样能查到。\n` +
        '这条指令就不改了，免得你以为藏住了',
        shouldQuote()
      )
      return
    }

    // 指定了档位就只改那一档。对不上（没这档 / 或者像「好友」那样同时像好几档）
    // 就把这项的档位全列出来让用户挑 —— 宁可多问一句，也不要猜着改
    let onlyDetail = null
    if (detailName) {
      onlyDetail = matchDetail(item, detailName)
      if (!onlyDetail) {
        await e.reply(
          `「${item.name}」里对不上「${detailName}」是哪一档，它有：\n` +
          item.details.map(d => d.name).join(' / ') +
          '\n照上面的名字写，不写档位名就是改全部',
          shouldQuote()
        )
        return
      }
    }

    await this.#applyWrites(e, campId, [{ item, status, onlyDetail }], match[1])
  }

  /** `#隐藏我的战绩` / `#公开我的战绩` —— 战绩那 4 项一起改 */
  async battleShortcut (e) {
    const account = await this.#gate(e)
    if (!account) return

    const action = String(e.msg || '').includes('隐藏') ? '隐藏' : '公开'
    const status = action === '隐藏' ? HIDDEN : VISIBLE

    const campId = String(account.userId)
    const menu = await this.#readMenu(e, campId)
    if (!menu) return

    // 按 privacyId 认，不按编号 —— 编号是服务端的展示顺序，privacyId 才是这项的身份
    // ⚠️ 顺带滤掉「写得进去但不生效」和「营地不让改」的项（白名单在 utils 里维护）——
    //    现在战绩这四项都在「已实测有效」名单内，这个过滤是**防御性**的：
    //    哪天营地改了行为、或快捷范围扩到别项，不至于把没作用的项也报成「藏好了」
    const items = menu.items.filter(item =>
      BATTLE_PRIVACY_IDS.includes(item.privacyId) && !item.ineffective && !item.unwritable
    )
    if (!items.length) {
      await e.reply('没读到战绩那几项隐私设置，过会儿再试', shouldQuote())
      return
    }

    await this.#applyWrites(e, campId, items.map(item => ({ item, status, onlyDetail: null })), action)
  }

  /**
   * 真正发写请求的那一段（单项和快捷共用）。
   *
   * @param {Array<{item: object, status: number, onlyDetail: object|null}>} jobs
   * @param {string} action 「隐藏」/「公开」，只用来说话
   */
  /**
   * 王者主角色的 `roleId` —— **「放开」方向的必要参数**。
   *
   * 公开（`status:0`）只有主网关那条路走得通，而主网关不带 `roleId` 就惰性成功、
   * 什么都不改（实测）。取 `gameId=20001` 下 `isMain=true` 那个角色就够。
   *
   * 取不到时返回 `''`，调用方要把「放开可能改不了」说给用户，别闷着发一通没用的请求。
   */
  async #mainRoleId (campId) {
    try {
      const games = (await apiService.getRoleList(campId))?.gameList || []
      const smoba = games.find(game => String(game.gameId) === '20001')
      const roles = smoba?.roles || []
      const role = roles.find(item => item.isMain) || roles[0]
      return String(role?.roleId || '')
    } catch (error) {
      logger.warn(`[营地隐私] ${campId} 取主角色失败: ${error?.message || error}`)
      return ''
    }
  }

  async #applyWrites (e, campId, jobs, action) {
    // ⚠️ `planWrites` **只跳锁住的档，不跳「看起来已达标」的档** —— 菜单读回的 status
    //    是假的（见 utils/campPrivacy.js 文件头），按它跳会把真该发的请求跳掉
    const plans = jobs.map(job => ({ ...job, plan: planWrites(job.item, job.status, job.onlyDetail) }))
    const writes = plans.flatMap(p => p.plan.writes)
    const lockedNames = plans.flatMap(p => p.plan.locked.map(d => `${p.item.name}·${d.name}`))

    const label = jobs.length === 1
      ? `「${jobs[0].item.name}」${jobs[0].onlyDetail ? `的「${jobs[0].onlyDetail.name}」` : ''}`
      : `战绩相关 ${jobs.length} 项`

    // 一档都发不了 = 这项全是锁住的档（观战的「允许观战」那种）
    if (!writes.length) {
      await e.reply(
        lockedNames.length
          ? `${label}这几档营地不让改：${lockedNames.join('、')}`
          : `${label}没有可改的档位`,
        shouldQuote()
      )
      return
    }

    // 预估耗时：发之间要等 3 秒，最后一发不用等
    const estimate = Math.round(((writes.length - 1) * WRITE_GAP_MS) / 1000)
    if (writes.length >= 3) {
      await e.reply(
        `正在把${label}设成「${action}」，要改 ${writes.length} 档、约 ${estimate} 秒，改完我再说一声`,
        shouldQuote()
      )
    }

    // 「放开」方向只有主网关走得通，而它**必须带主角色 roleId**（见文件头第 3 条）。
    // 一次性取好：循环里逐发去取等于把一次请求乘以档位数
    const wantsVisible = writes.some(write => write.status === VISIBLE)
    const roleId = wantsVisible ? await this.#mainRoleId(campId) : ''

    writing.add(campId)
    const done = []
    const failed = []

    try {
      for (let index = 0; index < writes.length; index += 1) {
        const write = writes[index]
        // 第一发不等，之后每发之间隔 3 秒（1.1 秒间隔实测会有一发静默不生效）
        if (index > 0) await sleep(WRITE_GAP_MS)

        const body = {
          privacyId: write.privacyId,
          friendTypeId: write.friendTypeId,
          status: write.status
        }
        const gateway = gatewayFor(write.status)
        // 主网关那条路不带 roleId 就是 no-op，所以只在拿到了才走它；
        // 拿不到角色时退回 form（藏得了、放开不一定成，下面会如实告诉用户）
        const useCamp = gateway === 'camp' && roleId

        try {
          const res = useCamp
            ? await apiService.campRequest('/user/setprivacy', { ...body, roleId }, '', campId)
            : await apiService.gameFormRequest('/user/setprivacy', body, '', campId)

          // form 回裸 `true`（`data:true`）、主网关回 `{success:true}`，returnCode 0 也算。
          // ⚠️ 这只代表「请求被受理」，**不代表已生效** —— 营地对改不动的项、
          //    对走错方向的请求也一样回成功（实测），真正生效要 30 秒后去查
          const ok = res === true || res?.data === true ||
            res?.data?.success === true || Number(res?.returnCode) === 0
          if (ok) {
            done.push(write.name)
          } else {
            failed.push(write.name)
            logger.warn(`[营地隐私] ${campId} 写 ${write.privacyId}/${write.friendTypeId} 没成功(${useCamp ? 'camp' : 'form'}): ${JSON.stringify(res).slice(0, 200)}`)
          }
        } catch (error) {
          failed.push(write.name)
          logger.warn(`[营地隐私] ${campId} 写 ${write.privacyId}/${write.friendTypeId} 异常(${useCamp ? 'camp' : 'form'}): ${error?.message || error}`)
          // 频控（-30107）之后每发都会失败，而且会把这个号整个静默 12 小时
          // （api.js 内部统一处理），接着发只是白烧额度 —— 立刻停，把改成的报出来
          if (String(error?.message || error).includes('30107')) break
        }
      }
    } finally {
      writing.delete(campId)
    }

    const lines = []
    if (done.length) {
      lines.push(`${label}已设成「${action}」：${done.join('、')}`)
    }
    if (failed.length) {
      lines.push(`没改成的：${failed.join('、')}`)
    }
    if (lockedNames.length) {
      lines.push(`营地不让改的：${lockedNames.join('、')}`)
    }
    if (done.length) {
      // ⚠️ 这句不能省：生效是异步的，不说的话用户立刻复查看到没变、以为没改成，
      //    然后反复发 —— 反复发就容易撞频控（命中一次这个号静默 12 小时）
      lines.push('', `营地那边 ${EFFECT_DELAY_SEC} 秒左右生效，别反复发`)
      if (wantsVisible && !roleId) {
        // 「放开」没有角色就走不了那条唯一有效的通道，这事必须说，不然用户
        // 以为改好了、过几天才发现别人还是看不到
        lines.push('这个号没绑王者角色，「公开」这个方向可能改不动 —— 去营地 App 里改')
      }
      // ⭐ 写明这一项到底有没有实测效果（判据见 utils/campPrivacy.js 的白名单）。
      //    营地有「写得进去但服务端不拿它拦数据」的项（皮肤实测就是这样），
      //    对那种项说一句「试试看」，比含糊地说「已设置」诚实得多
      const verified = jobs.filter(job => job.item.verified)
      const unverified = jobs.filter(job => !job.item.verified)
      if (verified.length && !unverified.length) {
        lines.push('这一项实测有效，过会儿发 #隐私帮助 能看出效果')
      } else if (unverified.length && !verified.length) {
        lines.push('这一项营地查不出来到底有没有作用，建议再进营地 App 里看一眼')      } else if (verified.length && unverified.length) {
        lines.push(`其中${verified.map(job => `「${job.item.name}」`).join('')}实测有效；`
          + `${unverified.map(job => `「${job.item.name}」`).join('')}营地查不出来，去 App 里看一眼更稳`)
      }
      if (jobs.some(job => BATTLE_PRIVACY_IDS.includes(job.item.privacyId))) {
        lines.push('过半分钟发 #隐私帮助，图上第一行会告诉你别人还看不看得到你的战绩')
      }
    }
    await e.reply(lines.join('\n'), shouldQuote())
  }
}

export default CampPrivacy
