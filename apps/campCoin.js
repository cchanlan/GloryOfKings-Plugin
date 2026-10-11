/**
 * 营地币余额与**营地币兑换**（`#营地币` / `#营地兑换`）。
 *
 * ## 能做什么、不能做什么（2026-10-11 定）
 *
 * ✅ **营地币余额**：`/operation/lotteryquery` 的 `data.userCurrencyCnt`。
 *    ⚠️ 不带 `type` 时它也回余额，所以查余额不用管 `type`。
 *
 * ✅ **兑换清单**：`/operation/lotteryquery { gameId:'20001', type:'exchange' }`
 *    的 `data.exchangeInfo.giftList[]` —— 实测 **19 件**（皮肤/英雄/改名卡/免卡…）。
 *    ⚠️⚠️ **必须带 `type:'exchange'`**：少了它 `exchangeInfo` 恒为 `null`，
 *       会误判成「没有活动」。另外别用 `/operation/action/tasklist` 里那份
 *       `exchangeList`（只有 6 件，是**残缺子集**，早先被它误导过）。
 *
 * ✅ **兑换**：`/operation/lotterygetgift`，王者的商品（gameId `20001`）实测可兑
 *    （用余额不足当安全阀验到 `-10530338 营地币不足` = 参数全对）。见 utils/campExchange.js。
 *
 * ❌ **曾经有过的 `#营地商城` 已删**（2026-10-11 主人要求）：
 *    那是 `/mall/tabgoodslist` 拉出来的 1000 件商城商品，**只逛不能买** ——
 *    下单要过米大师（Midas）支付 SDK，HTTP 到不了那一步。
 *    而主人在营地 App 里**根本找不到这个入口**（App 里只有「营地币兑换」），
 *    留一个只能看不能用的指令只会让人困惑，所以整块删掉。
 *    被删的实现见 git 历史（`apps/campCoin.js` 的 `mall` 方法 +
 *    `utils/campMall.js` 的 `parseGoodsList` / `utils/api.js` 的 `getMallGoods`）。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { shouldQuote, getImgType, AT_HEAD, AT_TAIL } from '#utils'
import authStore from '../utils/authStore.js'
import apiService from '../utils/api.js'
import { parseCoinBalance, balanceLineOf } from '../utils/campMall.js'
import { parseExchange, canExchange, exchangeBody, cleanExchangeMsg, groupByCycle, numberGifts, toCard, describeGift } from '../utils/campExchange.js'

export class CampCoin extends plugin {
  constructor () {
    super({
      name: '王者营地币',
      dsc: '营地币余额与营地币兑换',
      event: 'message',
      priority: 0,
      rule: [
        {
          // ⚠️ 要排在 `#营地币` 前面：`#营地兑换` 跟它不冲突，但将来谁把
          //    `#营地币` 那条写宽（比如写成 `#营地币?`）就会抢过去
          reg: new RegExp(`${AT_HEAD}#营地兑换(?:\\s*(\\d+))?(?:\\s*确认)?${AT_TAIL}`),
          fnc: 'exchange'
        },
        {
          reg: new RegExp(`${AT_HEAD}#(?:营地币|营地余额)${AT_TAIL}`),
          fnc: 'balance'
        }
      ]
    })
  }

  /**
   * 发指令的人名下的营地号（口径同 `#王者签到` / `#营地观战`）。
   *
   * ⚠️ 余额和商城都是**账号级**的：拿别人的号查出来的是别人的钱，
   * 所以必须按 owner 取，不能用全局轮转。
   */
  #myAccounts (e) {
    return authStore.listGlobalAccountsByOwner(String(e.user_id), {
      includeOrphan: Boolean(e.isMaster)
    })
  }

  /**
   * 这个人**当前选中的**营地号（`UserData.yaml` 的 `current`）对应的账号对象。
   *
   * ⚠️⚠️ **不能用 `#myAccounts(e)[0]` 代替**（2026-10-11 踩到）：
   *    那列表是按 `isGlobalDefault` → `priority` → **userId 字典序**排的，
   *    多号之间前两项往往一模一样（主人 5 个号 priority 都是 100），
   *    于是「第一个」由 ID 大小决定 —— 结果把**别人的号**当成了主人的默认号
   *    显示出来（`1476924610` 排在了 `1580886057` 前面）。
   *    「当前用哪个」只有 `current` 说了算，用户想换发给 `#切换营地` 就行。
   *
   * ⚠️ 当前号不在自己的全局号列表里（还没扫码登录 / 是别人的号）时，
   *    回落到列表第一个 —— **有总比没有好**，兑换前还有余额和角色两道校验兜着。
   *
   * @param {object} e 消息事件
   * @returns {object|null} 账号对象；一个号都没有时 `null`
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

  async #noAccountHint (e) {
    await e.reply([
      '还没有登录过王者营地号，先扫码登录一个：',
      '微信：#营地wx全局登录',
      'QQ：#营地QQ全局登录'
    ].join('\n'), shouldQuote())
  }

  /** `#营地币` —— 查营地币余额 */
  async balance (e) {
    const accounts = this.#myAccounts(e)
    if (!accounts.length) return this.#noAccountHint(e)

    // ⚠️⚠️ **0 枚的号不列出来**（2026-10-10 主人要求：「余额没有的或者没有角色的就别显示了」）。
    //    为什么不另外查一次 `/game/rolelist` 去分开「没绑王者角色」和「余额真是 0」：
    //      · 营地币就是王者营地的签到 / 营地任务发的，**没角色的号必然读成 0**
    //        （实测主人名下 5 个号：有角色的那 2 个是 25 / 225，没角色的 3 个全是 0），
    //        所以 `> 0` 这一条已经把两类一起覆盖 —— 分开了也一样不显示
    //      · 为了把「不显示的原因」分细一点而多打 N 次 rolelist，是白吃一轮频控
    //        （-30107 命中一次静默 12 小时）
    const rows = []

    for (const account of accounts) {
      const campId = String(account.userId)
      const name = String(account.nickname || account.userName || campId)
      const label = `${name}（${campId}）`

      try {
        const data = (await apiService.getCampCoin(campId))?.data || {}
        const view = parseCoinBalance(data)

        // ⚠️ 该不该显示、显示成什么，判据在 utils/campMall.js 的 balanceLineOf 里
        //    （能脱机单测；0 枚 / 没角色都返回 null = 不显示，读不到则照旧报「读取失败」）
        const line = balanceLineOf(label, view)
        if (line) rows.push(line)

        // ⚠️ 没兑换活动是**常态**（实测 exchangeInfo 恒为 null），
        //    别写成「加载失败」那种像出错了的话
        if (line && view.hasExchange) rows.push(`　${view.exchangeText}`)
      } catch (error) {
        logger.warn(`[营地币] ${campId} 查询失败: ${error?.message || error}`)
        rows.push(`${label}：查询失败 —— ${apiService.formatUserFacingError(error)}`)
      }
    }

    const lines = ['营地币余额']
    if (rows.length) {
      lines.push(...rows)
    } else {
      // ⚠️ 一个能显示的都没有时**必须说一句**：只回一个标题看着像坏了。
      //    同时这也是「没绑角色的号」唯一会出声的地方 —— 否则主人会以为指令没反应
      lines.push('', `名下 ${accounts.length} 个营地号现在都没有营地币`)
    }
    lines.push('', '营地币来自每日签到与营地任务；发 #营地兑换 看能换什么')
    await e.reply(lines.join('\n'), shouldQuote())
  }

  /**
   * `#营地兑换` / `#营地兑换 3` / `#营地兑换 3 确认` —— 用营地币换东西。
   *
   * ## 三段式，**不给手滑的机会**
   *
   * 兑换是**花币且不可逆**的：
   *   · `#营地兑换`        → 出图列清单，什么都不做
   *   · `#营地兑换 3`      → 只回「确认要花 X 币换 Y 吗」，**仍然什么都不做**
   *   · `#营地兑换 3 确认` → 这才真发请求
   *
   * 不用「30 秒内回复确认」那种会话态：换个群、换个人、隔一会儿都可能串，
   * 而串掉的代价是**花掉别人的币**。带「确认」两个字最笨也最稳。
   */
  async exchange (e) {
    const account = this.#currentAccount(e)
    if (!account) return this.#noAccountHint(e)

    const text = String(e.msg || '')
    const noMatch = text.match(/营地兑换\s*(\d+)/)
    const confirmed = /确认/.test(text)

    const campId = String(account.userId)
    const who = String(account.nickname || account.userName || campId)

    // ① 拉清单 + 余额（同一个响应）
    let view
    try {
      view = parseExchange((await apiService.getCampExchange(campId))?.data)
    } catch (error) {
      logger.warn(`[营地兑换] ${campId} 拉清单失败: ${error?.message || error}`)
      await e.reply(`兑换清单拉取失败 —— ${apiService.formatUserFacingError(error)}`, shouldQuote())
      return
    }

    if (!view.gifts.length) {
      await e.reply('现在没有可兑换的东西', shouldQuote())
      return
    }

    const coinText = view.coin === null ? '余额读不到' : `${view.coin} 营地币`

    // ② 不带编号 = 出图看清单
    if (!noMatch) {
      await this.#renderExchange(e, view, who, coinText)
      return
    }

    // ⚠️⚠️ 选号必须用**跟图上同一套编号**（先分组、再编号）——
    //    直接拿 `view.gifts.find(g => g.no === N)` 会查错：那个列表还没分组，
    //    编号跟图上的对不上（图按周期分过组），用户按图里的号选会兑到别的东西。
    const ordered = numberGifts(groupByCycle(view.gifts)).flatMap(group => group.gifts)
    const gift = ordered.find(item => item.no === parseInt(noMatch[1], 10))
    if (!gift) {
      await e.reply(`没有 ${noMatch[1]} 号商品，发 #营地兑换 看清单`, shouldQuote())
      return
    }

    // ③ 明知换不了的，在发请求之前就拦掉（省一次写请求，也省一句看不懂的「系统繁忙」）
    const check = canExchange(gift, view.coin)
    if (!check.ok) {
      await e.reply(`${gift.name}：${check.reason}`, shouldQuote())
      return
    }

    // ④ 没带「确认」= 只给确认提示
    if (!confirmed) {
      await e.reply(
        `要用 ${gift.price} 营地币换「${gift.name}」吗？\n` +
        `号：${who}（现有 ${coinText}）\n` +
        `确定就发：#营地兑换 ${gift.no} 确认`,
        shouldQuote()
      )
      return
    }

    // ⑤ 真兑 —— 要带角色（王者的商品发到角色身上）
    let role
    try {
      const games = (await apiService.getRoleList(campId))?.gameList || []
      const game = games.find(item => String(item.gameId) === gift.gameId)
      role = (game?.roles || []).find(item => item.isMain) || (game?.roles || [])[0]
    } catch (error) {
      logger.warn(`[营地兑换] ${campId} 查角色失败: ${error?.message || error}`)
      await e.reply(`查角色失败 —— ${apiService.formatUserFacingError(error)}`, shouldQuote())
      return
    }

    if (!role?.roleId) {
      await e.reply(`${who} 还没绑定对应的游戏角色，换不了（奖励要发到角色身上）`, shouldQuote())
      return
    }

    let res
    try {
      res = await apiService.exchangeCampGift(campId, exchangeBody(gift, role))
    } catch (error) {
      logger.warn(`[营地兑换] ${campId} 兑换异常: ${error?.message || error}`)
      await e.reply(`兑换失败 —— ${apiService.formatUserFacingError(error)}`, shouldQuote())
      return
    }

    if (Number(res?.returnCode) !== 0) {
      const msg = cleanExchangeMsg(res?.returnMsg) || `错误码 ${res?.returnCode}`
      logger.warn(`[营地兑换] ${campId} 兑换 ${gift.name} 失败: ${res?.returnCode} ${res?.returnMsg || ''}`)
      await e.reply(`没换成：${msg}`, shouldQuote())
      return
    }

    logger.info(`[营地兑换] ${campId} 兑换成功：${gift.name}（${gift.price} 币）`)
    await e.reply(
      `换好了：${gift.name}\n` +
      `花了 ${gift.price} 营地币，奖励发到「${role.roleName}」，去游戏内邮件查收`,
      shouldQuote()
    )
  }

  /**
   * 出兑换清单的图（`#营地兑换` 不带编号时走它）。
   *
   * 出图失败退化成纯文字 —— 清单本身比图重要（用户要知道有什么可换）。
   */
  async #renderExchange (e, view, who, coinText) {
    // 按限兑周期分组（本期/本日/本周/本月），跟营地 App 的排版一致；
    // ⚠️ 顺序有讲究：**先分组 → 再编号**（编号要对应图上顺序，见 numberGifts）；
    //    卡片该显示的字段最后在 toCard 里算好，模板不做计算（那样没法单测）
    const groups = numberGifts(groupByCycle(view.gifts)).map(group => ({
      ...group,
      gifts: group.gifts.map(toCard)
    }))

    let image = null
    try {
      image = await puppeteer.screenshot('campExchange', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/CampExchange.html',
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        imgType: getImgType(),
        groups,
        coinText,
        who,
        endTime: view.endTime,
        avatar: `https://q1.qlogo.cn/g?b=qq&s=100&nk=${e.user_id}`
      })
    } catch (error) {
      logger.error(`[营地兑换] 出图失败: ${error.message}`)
    }

    // ⚠️ screenshot 失败返回 false 而不是抛错，光靠 try/catch 拦不住
    if (image) {
      await e.reply(image, shouldQuote())
      return
    }

    const lines = [`营地币兑换（${who}　${coinText}）`]
    for (const group of groups) {
      lines.push('', `${group.title} · 限兑`)
      for (const gift of group.gifts) lines.push(describeGift(gift))
    }
    lines.push('', '发 #营地兑换 编号 选一件；真要换再加「确认」两个字')
    await e.reply(lines.join('\n'), shouldQuote())
  }
}

export default CampCoin
