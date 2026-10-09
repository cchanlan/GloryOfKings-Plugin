/**
 * 营地币与营地商城的**纯数据解析**。
 *
 * 零 import，为了能脱开云崽运行时直接单测（`test/campMall.test.mjs`）——
 * 这一块的风险全在「接口字段怎么解读」上（币种编号、价格口径、缺字段兜底），
 * 不在请求编排上，所以判据要能被钉住。
 */

/**
 * `currencyType` 数字 → 币种名。
 *
 * ⚠️ **接口不给币种文案**，这张表是「实测 + 常识」推断出来的，
 * 拿不准的取值**必须**落到 `币种N` 兜底，不许瞎猜一个像模像样的名字 ——
 * 猜错会让用户以为某件商品能用营地币买，实际要花钱。
 *
 * 2026-10-10 实测分布（扫了 66 件商品）：`[1]` 58 条、`[3]` 4 条、`[4]` 2 条、
 * `[4,1]` 1 条、`[1,4]` 1 条。其中 `[3]` 那 4 条是实体手办（28800 价位的
 * 「繁星吟游蔡文姬Q版手办」），所以 `3` 判为人民币。
 */
const CURRENCY_NAMES = {
  1: '营地币',
  3: '人民币',
  4: '营地券'
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
 * @returns {{coin: number, hasExchange: boolean, exchangeText: string, serverTime: string}}
 */
export function parseCoinBalance (data) {
  const raw = data?.userCurrencyCnt
  const coin = Number(raw)

  // ⚠️⚠️ 这里**必须先看类型**，不能只判 null/空串。三个经典坑：
  //    `Number(null)` / `Number('')` / **`Number([])`** 全都等于 **0**
  //    → 字段缺失或形状异常时会显示「0 枚营地币」，用户以为余额被清零了。
  //    只有 `number` 和非空字符串才算「真的读到了」。
  const known = (typeof raw === 'number' && Number.isFinite(raw)) ||
    (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(coin))

  const banners = Array.isArray(data?.exchangeBanners) ? data.exchangeBanners : []
  const hasExchange = Boolean(data?.exchangeInfo) || banners.length > 0

  let exchangeText = ''
  if (hasExchange) {
    const info = data?.exchangeInfo || {}
    const title = String(info.title || info.name || '').trim()
    const count = banners.length
    exchangeText = title || (count ? `有 ${count} 个兑换活动` : '有兑换活动')
  }

  return {
    coin: known ? coin : null,
    coinText: known ? `${coin} 枚` : '读取失败',
    hasExchange,
    exchangeText,
    serverTime: String(data?.serverTime || '')
  }
}

/** 价格口径：优先折后价，没有就用现价；都为 0 时返回空 */
function pickPrice (goods) {
  const discount = String(goods?.discountPrice ?? '').trim()
  const current = String(goods?.curPrice ?? '').trim()

  // 「0」和空串都算没有。注意 discountPrice 为 "0" 时不算打折
  const usable = value => value && value !== '0'
  if (usable(discount)) return { value: discount, discounted: true }
  if (usable(current)) return { value: current, discounted: false }

  return { value: '', discounted: false }
}

/**
 * 解析商城列表响应（`/mall/tabgoodslist` 的 `data`）→ 出图要的结构。
 *
 * 实测字段（2026-10-10，`goodsId=314` 的「一念神魔」）：
 * `goodsId` / `djcId` / `name` / `subName` / `posterUrl` / `goodsBust` /
 * `curPrice`（"16880"）/ `orgPrice` / `discountPrice`（"13500"）/
 * `currencyType`（`[1]`）/ `type`（1=皮肤 6=英雄 7=个性按键）/
 * `isOwn`（false）/ `limitBuy`（0）/ `tabs`（`[1]`）
 *
 * @param {object} data 接口响应的 `data`
 * @param {object} [opts]
 * @param {number} [opts.page=1] 用户视角的页码（从 1 开始）
 * @param {number} [opts.pageSize=15]
 */
export function parseGoodsList (data, { page = 1, pageSize = 15 } = {}) {
  const list = Array.isArray(data?.list) ? data.list : []
  const totalPage = Math.max(1, Number(data?.totalPage) || 1)
  const curPage = Math.max(1, Number(data?.curPage ?? (page - 1)) + 1)

  const goods = list.map(item => {
    const price = pickPrice(item)
    const currencies = describeCurrencies(item?.currencyType)

    // 价格后面缀上币种；币种认不出来时只显示数字，别硬贴一个假名字
    const priceText = price.value
      ? `${price.value}${currencies[0] ? ` ${currencies[0]}` : ''}`
      : '—'
    const own = item?.isOwn === true || item?.isOwn === 1 || item?.isOwn === '1'
    const limit = Number(item?.limitBuy) || 0

    return {
      goodsId: String(item?.goodsId ?? ''),
      name: truncateName(String(item?.name || '未命名').trim(), 30),
      sub: String(item?.subName || '').trim(),
      // 海报优先，没有再退回半身像
      image: String(item?.posterUrl || item?.goodsBust || '').trim(),
      price: price.value,
      priceText,
      // 「—」是「接口没给价」（英雄类商品就是这样），模板用它把字压暗，
      // 免得一个大灰杠看着像渲染坏了
      priceClass: price.value ? '' : 'none',
      discounted: price.discounted,
      orgPrice: String(item?.orgPrice || '').trim(),
      currencies,
      owned: own,
      // 模板用的 class 名（art-template 里拼字符串容易写错，这里先算好）
      ownedClass: own ? 'owned' : '',
      ownedText: own ? ' · 已拥有' : '',
      // 限购 0 = 不限购，不显示；有限购才提示
      limit,
      limitText: limit > 0 ? `限购 ${limit}` : ''
    }
  })

  const ageHint = describePageAge(curPage, totalPage)

  return {
    title: '营地商城',
    page: curPage,
    totalPage,
    pageText: `第 ${curPage}/${totalPage} 页`,
    count: goods.length,
    goods,
    // 翻页提示：让用户知道有下一页可以发
    nextHint: curPage < totalPage ? `发 #营地商城 ${curPage + 1} 看下一页` : '已经是最后一页',
    ageHint,
    footText: '价格与库存以营地 App 为准；兑换要在 App 里操作',
    goodsJson: JSON.stringify(goods)
  }
}

/**
 * 商品名太长时的截断（出图卡片放不下）。
 * 中英混排按字符数算就够了，不搞像素测量。
 */
export function truncateName (name, maxLength = 16) {
  const text = String(name ?? '').trim()
  if (text.length <= maxLength) return text

  return `${text.slice(0, maxLength - 1)}…`
}

/**
 * 页面尺寸提示：页面越靠后越旧，给用户一句实话。
 * 实测总页数 67，翻到后面多半是下架/售罄的。
 */
export function describePageAge (page, totalPage) {
  if (totalPage <= 1) return ''
  if (page <= 1) return ''

  const ratio = page / totalPage
  if (ratio > 0.8) return '这一页比较靠后，商品可能已下架或售罄'

  return ''
}
