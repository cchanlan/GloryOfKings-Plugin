/**
 * 营地币余额的**纯数据解析**（`#营地币` 用）。
 *
 * > 早先这个文件还负责营地商城的商品列表（`parseGoodsList` 等），
 * > **2026-10-11 随 `#营地商城` 一起删掉了** —— 那个指令只能看不能买
 * > （下单走米大师 SDK，HTTP 到不了），而且主人在营地 App 里根本找不到它的入口。
 * > 要恢复见 git 历史。
 */

/**
 * 币种数字 → 可读名字。
 *
 * `currencyType` 实测取值：`1` = 营地币（签到给的那种）、`3` = 人民币、
 * `4` = 另一种券。接口**没给币种文案**，所以这张表是**硬编码**的 ——
 * 认不出来的一律显示 `币种N`，不瞎猜（猜错了比不显示更误导）。
 */
const CURRENCY_NAMES = {
  1: '营地币',
  3: '人民币',
  4: '券'
}

/**
 * 币种数组 → 可读名字数组。
 * 数组里每一项都转，转不出来就 `币种N`。
 */
export function describeCurrencies (types) {
  const list = Array.isArray(types) ? types : (types === null || types === undefined ? [] : [types])

  return list
    .map(type => {
      const numeric = Number(type)
      if (!Number.isFinite(numeric)) return ''
      return CURRENCY_NAMES[numeric] || `币种${numeric}`
    })
    .filter(Boolean)
}

/**
 * 解析营地币余额响应（`/play/h5lotteryquery` 的 `data`）。
 *
 * 实测形状（2026-10-10，号 1536597962）：
 * ```json
 * { "serverTime": "0", "exchangeInfo": null, "userCurrencyCnt": 25,
 *   "gamesList": [{ "name": "王者荣耀", "gameId": "20001" }],
 *   "exchangeBanners": [], "lotteryInfo": null }
 * ```
 *
 * ⚠️ `exchangeInfo` / `lotteryInfo` 为 `null`、`exchangeBanners` 为 `[]`
 *    **是「当前没有活动」的正常状态**，不是接口坏了 —— 上层别报成错误。
 *
 * @param {object} data 接口响应的 `data`
 * @returns {{coin: number|null, hasExchange: boolean, exchangeText: string, serverTime: string}}
 *   `coin` 读不到是 `null`（**不是 0** —— 「读不到余额」和「余额是 0」对用户是两件事）
 */
export function parseCoinBalance (data) {
  const raw = data?.userCurrencyCnt
  const coin = (raw === null || raw === undefined || raw === '') ? null : (Number(raw) || 0)

  const banners = Array.isArray(data?.exchangeBanners) ? data.exchangeBanners : []
  const hasExchange = Boolean(data?.exchangeInfo) || banners.length > 0

  let exchangeText = ''
  if (data?.exchangeInfo?.endTime) {
    exchangeText = `兑换活动到 ${String(data.exchangeInfo.endTime).slice(0, 10)} 截止`
  } else if (banners.length) {
    exchangeText = `有 ${banners.length} 个活动入口`
  }

  return {
    coin,
    hasExchange,
    exchangeText,
    serverTime: String(data?.serverTime ?? '')
  }
}

/**
 * 一个号的余额行 —— **该不该显示、显示成什么，判据都在这儿**。
 *
 * 为什么单独一个函数：这两个「不显示」的规则很容易在调用方漏掉或写反，
 * 而它们都是主人明确要求过的：
 *   · **余额为 0 的号不显示**（2026-09-13 主人要求）—— 没绑角色的号读出来必然是 0
 *     （币是签到/任务给的，没角色就没做过任务），一大堆「0 营地币」纯属噪音
 *   · **读不到余额**（`coin === null`）**要显示**成「读取失败」—— 那是异常，得让人看见
 *
 * @param {string} label 展示名（`昵称（营地号）`）
 * @param {object} view parseCoinBalance 的结果
 * @returns {string|null} 该行文案；`null` = 这个号不用显示
 */
export function balanceLineOf (label, view) {
  if (view?.coin === null) return `${label}：读取失败`

  const coin = Number(view?.coin) || 0
  if (coin <= 0) return null

  return `${label}：${coin} 营地币`
}
