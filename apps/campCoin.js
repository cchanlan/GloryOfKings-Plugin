/**
 * 营地币与营地商城（`#营地币` / `#营地商城`）。
 *
 * ## 能做什么、不能做什么（2026-10-10 探到底的边界）
 *
 * ✅ **营地币余额**：`/play/h5lotteryquery` 的 `data.userCurrencyCnt`。
 *    端点名字叫「抽奖查询」，但一次把余额、兑换活动、抽奖信息都给全了。
 *
 * ✅ **商城商品**：`/mall/tabgoodslist`，实测 67 页、单页 15 条，字段很全
 *    （名称/海报/价格/币种/是否已拥有/限购）。可以出图给用户逛。
 *
 * ❌ **下单兑换做不到**：真实下单走的是 WebView 的 JS 桥
 *    （APK 里是 `SmobaWebJsInterface$payForGoods` / `METHOD_PAY_FOR_GOODS`），
 *    不是 HTTP 接口。HTTP 层的 `/mall/order/buy` 无论怎么填参数都回
 *    `-20011 参数错误`；而 `/play/h5lotterygetgift` 又是**参数完全不校验**的
 *    （乱填也返回 0），说明它也不是真正的下单口。
 *    → 所以这里**只做「查余额 + 逛商城」**，不提供兑换指令。硬凑一个假兑换
 *      比没有更糟：用户以为兑到了、实际什么都没有。
 *
 * ## 币种
 *
 * `currencyType` 实测取值：`1` = 营地币（签到给的那种）、`3` = 人民币、
 * `4` = 另一种券。接口**没给币种文案**，所以映射表写在 utils/campMall.js，
 * 拿不准的一律显示 `币种N` 而不是瞎猜。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { shouldQuote, getImgType, AT_HEAD, AT_TAIL } from '#utils'
import authStore from '../utils/authStore.js'
import apiService from '../utils/api.js'
import { parseCoinBalance, parseGoodsList, balanceLineOf } from '../utils/campMall.js'

/** 一页拉多少条（服务端默认 15，正好铺一屏） */
const PAGE_SIZE = 15

export class CampCoin extends plugin {
  constructor () {
    super({
      name: '王者营地币',
      dsc: '营地币余额与营地商城',
      event: 'message',
      priority: 0,
      rule: [
        {
          // ⚠️ 只认带「营地」前缀的写法。裸 `#商城` / `#余额` 太泛，
          //    带货类插件都可能合理地用它们
          reg: new RegExp(`${AT_HEAD}#营地商城(?:\\s*(\\d+))?${AT_TAIL}`),
          fnc: 'mall'
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
    lines.push('', '营地币来自每日签到与营地任务；兑换要去营地 App 里操作')
    await e.reply(lines.join('\n'), shouldQuote())
  }

  /** `#营地商城 [页码]` —— 逛商城（只读，不涉及下单） */
  async mall (e) {
    const accounts = this.#myAccounts(e)
    if (!accounts.length) return this.#noAccountHint(e)

    const match = String(e.msg || '').match(/营地商城\s*(\d+)/)
    // 页码对用户从 1 开始，接口从 0 开始
    const userPage = match ? Math.max(1, parseInt(match[1], 10) || 1) : 1

    let data
    try {
      data = (await apiService.getMallGoods({ page: userPage - 1, pageSize: PAGE_SIZE }))?.data || {}
    } catch (error) {
      logger.warn(`[营地商城] 拉列表失败: ${error?.message || error}`)
      await e.reply(`商城拉取失败 —— ${apiService.formatUserFacingError(error)}`, shouldQuote())
      return
    }

    const view = parseGoodsList(data, { page: userPage, pageSize: PAGE_SIZE })

    let image = null
    try {
      image = await puppeteer.screenshot('campMall', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/CampMall.html',
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        imgType: getImgType(),
        ...view
      })
    } catch (error) {
      logger.error(`[营地商城] 出图失败: ${error.message}`)
    }

    // ⚠️ screenshot 失败返回 false 而不是抛错，光靠 try/catch 拦不住
    if (image) {
      await e.reply(image, shouldQuote())
      return
    }

    const lines = [`营地商城 第 ${userPage}/${view.totalPage} 页`]
    for (const g of view.goods) {
      lines.push(`${g.name}${g.sub ? `（${g.sub}）` : ''} —— ${g.priceText}${g.ownedText || ''}`)
    }
    lines.push('', '（出图失败，先用文字版）兑换要去营地 App 里操作')
    await e.reply(lines.join('\n'), shouldQuote())
  }
}

export default CampCoin
