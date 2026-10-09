/**
 * 营地币余额与营地商城的纯解析。
 *
 * 钉住的是「接口字段怎么解读」这一层，全部来自 2026-10-10 的真机实测：
 *   · `userCurrencyCnt` 缺失时**不能**显示 0（`Number(null)===0` 的老坑）
 *   · `exchangeInfo: null` 是「没活动」，不是「出错」
 *   · `currencyType` 只有编号、没有文案，认不出的要兜底成 `币种N`
 *   · `page` 接口从 0 开始、给用户看要从 1 开始
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  describeCurrencies, parseCoinBalance, parseGoodsList,
  truncateName, describePageAge
} from '../utils/campMall.js'

/* ------------------------------------------------------------ describeCurrencies */

test('describeCurrencies：已知币种编号转成名字', () => {
  assert.deepEqual(describeCurrencies([1]), ['营地币'])
  assert.deepEqual(describeCurrencies([1, 4]), ['营地币', '营地券'])
  assert.deepEqual(describeCurrencies([3]), ['人民币'])
})

test('describeCurrencies：认不出的编号兜底成「币种N」，不瞎猜名字', () => {
  // 猜错会让用户以为某件商品能用营地币买，实际要花钱
  assert.deepEqual(describeCurrencies([9]), ['币种9'])
  assert.deepEqual(describeCurrencies([1, 9]), ['营地币', '币种9'])
})

test('describeCurrencies：空 / 非法输入返回空数组，不抛', () => {
  assert.deepEqual(describeCurrencies(null), [])
  assert.deepEqual(describeCurrencies(undefined), [])
  assert.deepEqual(describeCurrencies([]), [])
  assert.deepEqual(describeCurrencies(['x']), [])
  // 单个数字（不是数组）也要认
  assert.deepEqual(describeCurrencies(1), ['营地币'])
})

/* --------------------------------------------------------------- parseCoinBalance */

/** 2026-10-10 实测原文（号 1536597962） */
const COIN_RESP = {
  serverTime: '0',
  exchangeInfo: null,
  userCurrencyCnt: 25,
  gamesList: [{ name: '王者荣耀', gameId: '20001' }],
  exchangeBanners: [],
  lotteryInfo: null
}

test('parseCoinBalance：读出营地币余额', () => {
  const v = parseCoinBalance(COIN_RESP)
  assert.equal(v.coin, 25)
  assert.equal(v.coinText, '25 枚')
})

test('parseCoinBalance：没有兑换活动时 hasExchange=false（这是常态，不是错误）', () => {
  const v = parseCoinBalance(COIN_RESP)
  assert.equal(v.hasExchange, false)
  assert.equal(v.exchangeText, '')
})

test('parseCoinBalance：有兑换活动时带出活动信息', () => {
  const v = parseCoinBalance({ userCurrencyCnt: 100, exchangeInfo: { title: '春节兑换' }, exchangeBanners: [{}] })
  assert.equal(v.hasExchange, true)
  assert.equal(v.exchangeText, '春节兑换')

  // 只有横幅、没有 exchangeInfo 也算有活动
  const v2 = parseCoinBalance({ userCurrencyCnt: 5, exchangeInfo: null, exchangeBanners: [{}, {}] })
  assert.equal(v2.hasExchange, true)
  assert.equal(v2.exchangeText, '有 2 个兑换活动')
})

test('parseCoinBalance：余额字段缺失时是 null，不是 0', () => {
  // ⚠️ Number(null)/Number('')/Number([]) 全是 0 —— 直接转数字会显示
  //    「0 枚营地币」，看着像余额被清零了
  for (const bad of [null, undefined, '', [], {}]) {
    const v = parseCoinBalance({ userCurrencyCnt: bad })
    assert.equal(v.coin, null, `输入 ${JSON.stringify(bad)} 时该是 null`)
    assert.equal(v.coinText, '读取失败')
  }
})

test('parseCoinBalance：0 枚是合法余额（要跟「读不到」区分开）', () => {
  const v = parseCoinBalance({ userCurrencyCnt: 0 })
  assert.equal(v.coin, 0)
  assert.equal(v.coinText, '0 枚')
})

test('parseCoinBalance：data 整个缺失也不抛', () => {
  const v = parseCoinBalance(null)
  assert.equal(v.coin, null)
  assert.equal(v.hasExchange, false)
})

/* ------------------------------------------------------------------ pickPrice / 列表 */

/** 2026-10-10 实测的「一念神魔」原文 */
const GOODS_314 = {
  goodsId: 314, djcId: '23369', name: '一念神魔', subName: '李信',
  posterUrl: 'https://p.qpic.cn/x.jpg', goodsBust: 'https://pvppic/x.jpg',
  curPrice: '16880', orgPrice: '16880', discountPrice: '13500',
  currencyType: [1], type: 1, isOwn: false, limitBuy: 0, tabs: [1]
}

test('parseGoodsList：优先用折后价，并标出是折扣', () => {
  const v = parseGoodsList({ list: [GOODS_314], totalPage: 67, curPage: 0 }, { page: 1 })
  const g = v.goods[0]
  assert.equal(g.price, '13500', '有 discountPrice 就用它')
  assert.equal(g.discounted, true)
  assert.equal(g.priceText, '13500 营地币')
  assert.equal(g.orgPrice, '16880', '原价留着给模板划线')
})

test('parseGoodsList：没有折后价时退回现价，且 discounted=false', () => {
  const v = parseGoodsList({ list: [{ ...GOODS_314, discountPrice: '0' }], totalPage: 1, curPage: 0 })
  const g = v.goods[0]
  assert.equal(g.price, '16880')
  assert.equal(g.discounted, false)
})

test('parseGoodsList：两个价都没有时 priceText 是「—」，不是空串或 0', () => {
  const v = parseGoodsList({ list: [{ name: '无价商品', curPrice: '', discountPrice: '0' }], totalPage: 1, curPage: 0 })
  assert.equal(v.goods[0].priceText, '—')
})

test('parseGoodsList：页码两边差 1（接口 0 起、用户 1 起）', () => {
  const v = parseGoodsList({ list: [GOODS_314], totalPage: 67, curPage: 0 }, { page: 1 })
  assert.equal(v.page, 1, 'curPage=0 显示成第 1 页')
  assert.equal(v.pageText, '第 1/67 页')

  const v2 = parseGoodsList({ list: [], totalPage: 67, curPage: 2 }, { page: 3 })
  assert.equal(v2.page, 3)
  assert.equal(v2.pageText, '第 3/67 页')
})

test('parseGoodsList：翻页提示只在有下一页时出现', () => {
  const mid = parseGoodsList({ list: [GOODS_314], totalPage: 67, curPage: 0 }, { page: 1 })
  assert.ok(mid.nextHint.includes('#营地商城 2'))

  const last = parseGoodsList({ list: [GOODS_314], totalPage: 3, curPage: 2 }, { page: 3 })
  assert.equal(last.nextHint, '已经是最后一页')
})

test('parseGoodsList：已拥有标记与 class', () => {
  const owned = parseGoodsList({ list: [{ ...GOODS_314, isOwn: true }], totalPage: 1, curPage: 0 })
  assert.equal(owned.goods[0].owned, true)
  assert.equal(owned.goods[0].ownedClass, 'owned')
  assert.ok(owned.goods[0].ownedText.includes('已拥有'))

  // 接口偶尔给字符串 '1'
  const ownedStr = parseGoodsList({ list: [{ ...GOODS_314, isOwn: '1' }], totalPage: 1, curPage: 0 })
  assert.equal(ownedStr.goods[0].owned, true)
})

test('parseGoodsList：限购 0 不显示，有限购才提示', () => {
  const none = parseGoodsList({ list: [GOODS_314], totalPage: 1, curPage: 0 })
  assert.equal(none.goods[0].limitText, '')

  const limited = parseGoodsList({ list: [{ ...GOODS_314, limitBuy: 3 }], totalPage: 1, curPage: 0 })
  assert.equal(limited.goods[0].limitText, '限购 3')
})

test('parseGoodsList：海报缺失时退回半身像；都没有就空串', () => {
  const bust = parseGoodsList({ list: [{ ...GOODS_314, posterUrl: '' }], totalPage: 1, curPage: 0 })
  assert.equal(bust.goods[0].image, 'https://pvppic/x.jpg')

  const none = parseGoodsList({ list: [{ ...GOODS_314, posterUrl: '', goodsBust: '' }], totalPage: 1, curPage: 0 })
  assert.equal(none.goods[0].image, '')
})

test('parseGoodsList：空列表 / 缺字段不抛，totalPage 兜底成 1', () => {
  const v = parseGoodsList({}, { page: 1 })
  assert.equal(v.goods.length, 0)
  assert.equal(v.totalPage, 1)
  assert.equal(v.count, 0)

  assert.equal(parseGoodsList(null).totalPage, 1)
})

test('parseGoodsList：没名字的商品显示「未命名」，不是 undefined', () => {
  const v = parseGoodsList({ list: [{ goodsId: 1 }], totalPage: 1, curPage: 0 })
  assert.equal(v.goods[0].name, '未命名')
  assert.ok(!JSON.stringify(v.goods).includes('undefined'))
})

/* -------------------------------------------------------- truncateName / 页龄提示 */

test('truncateName：超长截断带省略号，短的原样', () => {
  assert.equal(truncateName('一念神魔'), '一念神魔')
  assert.equal(truncateName('三丽鸥家族祈愿币礼包10抽'), '三丽鸥家族祈愿币礼包10抽')
  const long = truncateName('这是一个名字特别特别特别特别长的商品', 10)
  assert.ok(long.endsWith('…'))
  assert.equal(long.length, 10)
  assert.equal(truncateName(null), '')
})

test('describePageAge：靠后的页给一句实话，前几页不啰嗦', () => {
  assert.equal(describePageAge(1, 67), '', '第一页不用说')
  assert.equal(describePageAge(10, 67), '', '中间页不用说')
  assert.ok(describePageAge(60, 67).includes('已下架'), '很靠后的页要提示')
  assert.equal(describePageAge(1, 1), '', '只有一页时不用说')
})
