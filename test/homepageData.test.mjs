/**
 * 主页图的数据整理（`apps/myKingHomepage.js` 的 `buildHomepageData`）。
 *
 * 钉住的是一个 2026-10-06 修的**必崩** bug：
 *   营地会给 `param1` 空串（实测同一响应里 modId 304/408/105/201/409/202 的
 *   param1 全是 `""`），也会整个 mod 都不给 —— 没打过 10v10 的号没有 708、
 *   新号没定级可能没有 701、巅峰赛没打过没有 702。
 *
 *   原实现是 `modePeakRace.param1` / `JSON.parse(mode5v5.param1)` 直接写，
 *   这些情况**每一步都当场抛**，用户只看到「主页数据异常，暂时无法生成图片」。
 *   实测把原逻辑抽出来喂 15 种真实可能的数据形状，**12 种直接崩**。
 *
 * ## 为什么用「抽源码 + eval」而不是直接 import
 *
 * `apps/myKingHomepage.js` 是插件入口，顶层 import 了 `lib/puppeteer`、
 * `#utils`、`moment` —— 都是云崽运行时才有的东西，直接 import 会当场抛。
 * 而 `buildHomepageData` 是模块内的纯函数、没导出，所以这里**按名字从源码里
 * 抽出这几个函数的原文**再 eval。
 *
 * 好处是测的仍然是**真实源码**（不是抄一份到测试里）：
 * 哪天有人把 `parseParam` 改回 `JSON.parse`，这里立刻报红。
 * 代价是函数名/签名不能随便改 —— 改了这里会找不到并**明确报错**（不会静默通过）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(PLUGIN_DIR, 'apps/myKingHomepage.js'), 'utf8')

/** 从源码里按名字抽一个函数（含函数体），靠大括号配对找结尾 */
function extractFunction (source, name) {
  const start = source.indexOf(`function ${name} (`)
  assert.ok(start >= 0, `源码里找不到 function ${name}，测试需要同步更新`)

  let i = source.indexOf('{', start)
  assert.ok(i > 0, `${name} 没有函数体`)

  let depth = 0
  for (let j = i; j < source.length; j += 1) {
    const ch = source[j]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, j + 1)
    }
  }
  throw new Error(`${name} 的大括号没有配对`)
}

/** 抽一段 `const NAME = {...}` 常量 */
function extractConst (source, name) {
  const start = source.indexOf(`const ${name} = {`)
  assert.ok(start >= 0, `源码里找不到 const ${name}`)
  const end = source.indexOf('}', start)
  return source.slice(start, end + 1)
}

/** 把源码里的函数拼成一个可调用的 buildHomepageData */
function loadBuilder () {
  const pieces = [
    extractConst(SRC, 'MOD_ID'),
    extractConst(SRC, 'ONLINE_TEXT'),
    extractFunction(SRC, 'parseParam'),
    extractFunction(SRC, 'parseFlagPag'),
    extractFunction(SRC, 'resolveFlagImg'),
    extractFunction(SRC, 'buildHomepageData')
  ]

  const resPath = SRC.match(/const RES_PATH = '([^']*)'/)?.[1]
  assert.ok(resPath, '源码里找不到 const RES_PATH')

  const factory = new Function(`
    // 运行时依赖的替身：只求不抛，返回值不参与断言
    const moment = () => ({ locale: () => ({ calendar: () => '时间' }) })
    const getImgType = () => 'png'
    const RES_PATH = ${JSON.stringify(resPath)}
    ${pieces.join('\n')}
    return { buildHomepageData, parseParam, parseFlagPag }
  `)

  return factory()
}

const { buildHomepageData, parseParam, parseFlagPag } = loadBuilder()

/** 造一份 roleData（字段照真实响应抄） */
const role = () => ({
  roleId: '4238108432',
  roleName: 'Cchanlan',
  roleIcon: 'https://example/icon.png',
  gameLevel: 18,
  gameOnline: 0,
  areaName: '手Q安卓',
  roleText: '安卓手Q524区',
  onlineTime: 1789325180,
  offlineTime: 1789857411
})

/** 造 mods；用 over 覆盖某一路，或传 null 表示这一路整个不给 */
function mods (over = {}) {
  const list = []
  if (over.m10 !== null) {
    list.push({ modId: 708, stype: 2, name: '10v10', icon: 'i10', ...(over.m10 || {}), param1: (over.m10 && 'param1' in over.m10) ? over.m10.param1 : JSON.stringify({ rankingStar: '3' }) })
  }
  if (over.m5 !== null) {
    list.push({ modId: 701, stype: 2, name: '5v5', icon: 'i5', ...(over.m5 || {}), param1: (over.m5 && 'param1' in over.m5) ? over.m5.param1 : JSON.stringify({ rankingStar: '5', starImg: 's.png' }) })
  }
  if (over.mp !== null) {
    list.push({ modId: 702, stype: 2, name: '巅峰赛', icon: 'ip', ...(over.mp || {}), param1: (over.mp && 'param1' in over.mp) ? over.mp.param1 : JSON.stringify({ flagPag: 'https://x/flagV3/2.pag', desc: '1582' }) })
  }
  return list
}

const build = (modList, headOver = {}) => buildHomepageData(
  { data: {} },
  role(),
  { mods: modList, ...headOver }
)

test('正常数据：三个模式都在时，段位与旗帜照常解析', () => {
  const d = build(mods())
  assert.equal(d.rank10v10, '10v10 3星')
  assert.equal(d.rank5v5, '5v5 5星')
  assert.equal(d.flagImg, '4', '段位名里没有青铜~王者字样时走默认 4')
  assert.equal(d.modePeakRace.param1.flagPag, '2', '从 flagPag 地址里抠出 2')
  assert.equal(d.isKing, false)
})

test('旗帜编号按段位名分流（判定顺序不能调）', () => {
  const flagOf = name => build(mods({ m5: { name, param1: JSON.stringify({ rankingStar: '5' }) } })).flagImg
  assert.equal(flagOf('倔强青铜'), '1')
  assert.equal(flagOf('荣耀黄金'), '1')
  assert.equal(flagOf('永恒钻石'), '2')
  assert.equal(flagOf('至尊星耀'), '2')
  assert.equal(flagOf('最强王者'), '3')
  // 「最强王者」也含「王者」，必须先判低段位再判高段位，否则会被前面的规则吃掉
  assert.equal(flagOf('最强王者'), '3', '高段位不能被低段位规则抢走')
  assert.equal(flagOf('荣耀王者'), '4', '王者之后不再细分')
})

test('mods 整个缺失 / 为空数组，不再抛错', () => {
  for (const list of [[], null, undefined]) {
    const d = build(list)
    assert.equal(d.rank10v10, '暂无')
    assert.equal(d.rank5v5, '暂无')
  }
})

test('head 整个缺失也不抛错', () => {
  const d = buildHomepageData({ data: {} }, role(), undefined)
  assert.equal(d.rank5v5, '暂无')
})

test('缺 10v10（没打过的号）：只有这一项显示暂无', () => {
  const d = build(mods({ m10: null }))
  assert.equal(d.rank10v10, '暂无')
  assert.equal(d.rank5v5, '5v5 5星', '5v5 不受影响')
})

test('缺 5v5（新号没定级）：不抛错，段位显示暂无', () => {
  const d = build(mods({ m5: null }))
  assert.equal(d.rank5v5, '暂无')
  assert.equal(d.rank10v10, '10v10 3星')
  assert.ok(d.rankIcon, '缺 mode5v5 时 rankIcon 要给兜底图，不能留空（模板会出破图）')
})

test('缺星数时只显示段位名，不拼「暂无星」这种别扭文案', () => {
  const d = build(mods({ m5: { name: '永恒钻石I', param1: JSON.stringify({ starImg: 's.png' }) } }))
  assert.equal(d.rank5v5, '永恒钻石I', '没有星数就只给段位名')
  assert.ok(!d.rank5v5.includes('暂无'), '不该出现「暂无星」')
  assert.ok(!d.rank5v5.includes('undefined'))
})

test('缺巅峰赛（没打过）：modePeakRace 为 undefined，不抛错', () => {
  const d = build(mods({ mp: null }))
  assert.equal(d.modePeakRace, undefined)
  assert.equal(d.rank5v5, '5v5 5星', '其它模式照常')
})

test('param1 是空串（营地真实会给）：按没有数据处理', () => {
  const d = build(mods({
    mp: { param1: '' },
    m5: { param1: '' },
    m10: { param1: '' }
  }))
  // 段位名本身有效，只是缺星数 —— 只显示段位名，不拼「暂无星」
  assert.equal(d.rank5v5, '5v5')
  assert.equal(d.rank10v10, '10v10')
  assert.equal(d.modePeakRace.param1.flagPag, d.flagImg, '抠不到旗帜编号时退回 5v5 旗帜')
})

test('param1 是 null / 非法 JSON：按没有数据处理', () => {
  for (const bad of [null, undefined, '{不是JSON', '[1,2,3]', 'null']) {
    const d = build(mods({ mp: { param1: bad }, m5: { param1: bad } }))
    assert.equal(d.modePeakRace.param1.flagPag, d.flagImg, '退回 5v5 旗帜')
    assert.equal(d.rank5v5, '5v5')
  }
})

test('flagPag 缺失 / 为 null / 不是 .pag 结尾：不再崩，且退回 5v5 旗帜', () => {
  for (const bad of [undefined, null, '', 'https://x/flagV3/2.png', 'https://x/a']) {
    const d = build(mods({ mp: { param1: JSON.stringify({ flagPag: bad, desc: '1' }) } }))
    // 抠不到编号时不能留空串（模板会去请求不存在的 flag.png → 破图），
    // 退回 5v5 用的旗帜编号
    assert.equal(
      d.modePeakRace.param1.flagPag,
      d.flagImg,
      `flagPag=${JSON.stringify(bad)} 应退回 5v5 旗帜`
    )
    assert.notEqual(d.modePeakRace.param1.flagPag, '', '不能是空串')
  }
})

test('flagPag 正则的 . 必须转义：2xpag / 12-pag 不该被当成合法 .pag', () => {
  // 未转义的 /(\d+).pag/ 会把这些也匹配上并取出错误数字
  assert.equal(parseFlagPag('https://x/a/2xpag'), '', '2xpag 不是 .pag')
  assert.equal(parseFlagPag('https://x/a/12-pag'), '', '12-pag 不是 .pag')
  assert.equal(parseFlagPag('https://x/a/123pag'), '', '123pag 不是 .pag')
  // 真正合法的仍要取到
  assert.equal(parseFlagPag('https://x/flagV3/2.pag'), '2')
  assert.equal(parseFlagPag('https://x/flagV3/12.pag'), '12')
})

test('parseParam 的边界', () => {
  assert.deepEqual(parseParam(''), {})
  assert.deepEqual(parseParam('   '), {})
  assert.deepEqual(parseParam(null), {})
  assert.deepEqual(parseParam(undefined), {})
  assert.deepEqual(parseParam('不是JSON'), {})
  assert.deepEqual(parseParam('null'), {}, 'null 解析出来不是对象，按空处理')
  assert.deepEqual(parseParam('[1,2]'), {}, '数组也不是我们要的形状')
  assert.deepEqual(parseParam('{"a":1}'), { a: 1 })
  // 已经是对象就直接用（营地偶尔直接给对象）
  assert.deepEqual(parseParam({ a: 1 }), { a: 1 })
})

test('全部 15 种真实可能的数据形状，一种都不许抛', () => {
  const shapes = [
    ['正常', mods()],
    ['mods 为空', []],
    ['mods 为 null', null],
    ['缺 708', mods({ m10: null })],
    ['缺 701', mods({ m5: null })],
    ['缺 702', mods({ mp: null })],
    ['三个全缺', mods({ m10: null, m5: null, mp: null })],
    ['702 空串', mods({ mp: { param1: '' } })],
    ['702 为 null', mods({ mp: { param1: null } })],
    ['702 无 flagPag', mods({ mp: { param1: JSON.stringify({ desc: '1' }) } })],
    ['flagPag 非 .pag', mods({ mp: { param1: JSON.stringify({ flagPag: 'https://x/2.png' }) } })],
    ['flagPag 空串', mods({ mp: { param1: JSON.stringify({ flagPag: '' }) } })],
    ['flagPag 为 null', mods({ mp: { param1: JSON.stringify({ flagPag: null }) } })],
    ['701 空串', mods({ m5: { param1: '' } })],
    ['708 空串', mods({ m10: { param1: '' } })]
  ]

  for (const [name, list] of shapes) {
    assert.doesNotThrow(() => build(list), `「${name}」不该抛错`)
  }
})

test('段位名缺失时不能拼出给用户看的 undefined', () => {
  const d = build(mods({
    m5: { param1: JSON.stringify({ starImg: 's.png' }) },
    m10: { param1: JSON.stringify({}) }
  }))
  assert.ok(!d.rank5v5.includes('undefined'), `rank5v5 不该含 undefined: ${d.rank5v5}`)
  assert.ok(!d.rank10v10.includes('undefined'), `rank10v10 不该含 undefined: ${d.rank10v10}`)
})

test('不许就地改写传入的响应数据（否则同一份数据二次渲染会出破图）', () => {
  // 实测踩到过：原实现写 `modePeakRace.param1 = {...}`，把调用方响应对象里的
  // param1 从字符串改成了对象；同一份数据再渲染一次时，flagPag 已经是裸编号
  // '2'，正则匹配不到 `.pag` → 旗帜变成破图。
  const list = mods()
  const before = JSON.parse(JSON.stringify(list))
  build(list)
  assert.deepEqual(list, before, 'buildHomepageData 不能改写入参')

  // 二次渲染必须和首次结果一致
  const first = build(list)
  const second = build(list)
  assert.equal(second.modePeakRace.param1.flagPag, first.modePeakRace.param1.flagPag)
  assert.equal(second.modePeakRace.param1.flagPag, '2', '二次渲染仍要抠出 2')
})

test('图片地址缺失时给兜底图，不留破图占位', () => {
  // 巅峰赛整块缺失：rankIcon 要有兜底
  const noPeak = build(mods({ mp: null }))
  assert.ok(noPeak.rankIcon, 'rankIcon 不能为空')

  // 星条图缺失 → 给空串，交给模板 {{if}} 跳过（不能拿单颗星去糊）
  const noStar = build(mods({ m5: { param1: JSON.stringify({ rankingStar: '5' }) } }))
  assert.equal(noStar.starImg, '', '星条缺失给空串')
  assert.equal(noStar.rank5v5, '5v5 5星', '星数还在，文案照常')

  // 巅峰赛在但旗帜抠不到 → 退回 5v5 的旗帜编号，而不是空串
  const badFlag = build(mods({ mp: { param1: JSON.stringify({ flagPag: 'https://x/2.png' }) } }))
  assert.equal(badFlag.modePeakRace.param1.flagPag, badFlag.flagImg, '抠不到应退回 5v5 旗帜')
  assert.notEqual(badFlag.modePeakRace.param1.flagPag, '', '不能是空串（模板会渲染破图）')
  assert.equal(badFlag.modePeakRace.param1.desc, '未定级', '描述缺失给「未定级」')
})

test('模板里用到的字段在缺数据时都不是 undefined（避免破图/空白）', () => {
  const d = build([])
  assert.ok(d.rankIcon, 'rankIcon 要有兜底')
  assert.ok(d.flagImg, 'flagImg 要有值')
  assert.ok(d._res_path, '_res_path 要有值')
  assert.equal(d.modePeakRace, undefined, '巅峰赛整块缺失时模板走 {{if}} 不渲染它')
})
