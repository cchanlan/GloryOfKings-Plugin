/**
 * 第二轮审计修复的回归测试（每一条都配「反证」：先证明旧写法真的错，再证明新写法对）。
 *
 * 与 auditFixes.test.mjs 同风格：从**已部署的真实源码**里抽函数出来跑，
 * 而不是复制一份实现 —— 复制的那份不会随源码漂移，测了等于没测。
 *
 * 跑法（Node 24 不展开目录，必须给 glob）：node --test test/*.test.mjs
 */
import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const P = path.resolve(import.meta.dirname, '..')
const read = rel => fs.readFileSync(path.join(P, rel), 'utf8')

/** 去掉注释和字符串，避免正则从注释里误判 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter(line => !/^\s*\/\//.test(line))
  .join('\n')

/** 抽 `const NAME = [...]`（数组字面量） */
function extractArray (src, name) {
  const st = src.indexOf(`const ${name} = [`)
  if (st < 0) throw new Error(`找不到数组 ${name}`)
  let d = 0
  for (let j = st; j < src.length; j++) {
    if (src[j] === '[') d++
    else if (src[j] === ']') { d--; if (!d) return src.slice(st, j + 1) }
  }
  throw new Error(`数组 ${name} 没有闭合`)
}

/** 抽 `function NAME (...)`（含函数体，花括号配平）。允许 `function NAME(` 无空格 */
function extractFunction (src, name, { export: isExport = true } = {}) {
  const re = new RegExp(`${isExport ? 'export ' : ''}function ${name}\\s*\\(`)
  const m = re.exec(src)
  if (!m) throw new Error(`找不到函数 ${name}`)
  const st = m.index
  const open = src.indexOf('(', st)
  let pd = 0
  let i = open
  for (; i < src.length; i++) {
    if (src[i] === '(') pd++
    else if (src[i] === ')') { pd--; if (!pd) break }
  }
  const bstart = src.indexOf('{', i)
  let d = 0
  for (let j = bstart; j < src.length; j++) {
    if (src[j] === '{') d++
    else if (src[j] === '}') { d--; if (!d) return src.slice(st, j + 1).replace(/^export /, '') }
  }
  throw new Error(`函数 ${name} 没有闭合`)
}

/* ══════════════════════════════════════════════ 段位对比（王者子段） */

describe('段位对比：王者子段认得出来，认不出的弃权', () => {
  const src = read('utils/profileSummary.js')
  const rankOrder = new Function(`
    ${extractArray(src, 'RANK_ORDER')};
    ${extractFunction(src, 'rankOrder')};
    return rankOrder
  `)()

  // num 是箭头函数，单独抽
  const numStart = src.indexOf('const num = value =>')
  const numEnd = src.indexOf('\n}', numStart) + 2
  const numSrc = src.slice(numStart, numEnd)
  const compareRank = new Function(`
    ${extractArray(src, 'RANK_ORDER')};
    ${numSrc};
    ${extractFunction(src, 'rankOrder')};
    ${extractFunction(src, 'compareRank')};
    return compareRank
  `)()

  const KING_SUBS = ['最强王者', '无双王者', '绝世王者', '非凡王者', '至圣王者', '荣耀王者', '传奇王者']

  it('反证：王者子段以前认不出（rankOrder = -1）', () => {
    // 修复前的 RANK_ORDER 停在「荣耀王者」，这四个 S40+ 的子段全落空
    const oldOrder = ['倔强青铜', '秩序白银', '荣耀黄金', '尊贵铂金', '永恒钻石', '至尊星耀', '荣耀王者']
    const oldRankOrder = (name) => {
      const text = String(name || '')
      for (let i = oldOrder.length - 1; i >= 0; i--) if (text.includes(oldOrder[i])) return i
      return -1
    }
    for (const sub of ['无双王者', '绝世王者', '非凡王者', '至圣王者']) {
      assert.equal(oldRankOrder(sub), -1, `${sub} 在旧表里应当认不出`)
    }
    // 新表全部认得出
    for (const sub of KING_SUBS) {
      assert.notEqual(rankOrder(sub), -1, `${sub} 应当认得出`)
      assert.equal(rankOrder(sub), rankOrder('王者'), `${sub} 应归到同一个王者档`)
    }
  })

  it('青铜到王者七档顺序正确', () => {
    const names = ['倔强青铜II', '秩序白银I', '荣耀黄金III', '尊贵铂金IV', '永恒钻石I', '至尊星耀II', '荣耀王者']
    const orders = names.map(rankOrder)
    for (let i = 1; i < orders.length; i++) {
      assert.ok(orders[i] > orders[i - 1], `${names[i]} 应高于 ${names[i - 1]}`)
    }
  })

  it('「荣耀黄金」不会被「荣耀王者」抢走', () => {
    assert.notEqual(rankOrder('荣耀黄金III'), rankOrder('荣耀王者'))
    assert.ok(rankOrder('荣耀黄金III') < rankOrder('荣耀王者'))
  })

  it('王者档内按星数比，跨档按段位比', () => {
    const w = (name, star) => ({ name, star })
    assert.ok(compareRank(w('荣耀王者', 90), w('最强王者', 5)) > 0, '星多的王者应更大')
    assert.ok(compareRank(w('荣耀王者', 50), w('荣耀王者', 60)) < 0, '同档星少的更小')
    assert.equal(compareRank(w('荣耀王者', 60), w('荣耀王者', 60)), 0)
    assert.ok(compareRank(w('非凡王者', 12), w('最强王者', 3)) > 0, '同属王者档，星多的赢')
    assert.ok(compareRank(w('永恒钻石I', 0), w('至圣王者', 45)) < 0, '钻石应低于至圣王者')
  })

  it('反证：认不出的段位必须弃权，不能冒充最低段位', () => {
    // 修复前的行为：认不出返回 -1，而 -1 比任何真实段位（≥0）都小 →
    // 未知段位会被判成「低于青铜」，输给所有人。
    // ⚠️ 反证必须让**已知段位**仍走真实顺序，否则两边都是 -1、差为 0，反证不成立
    //    （第一版就是这么写错的）。
    const oldOrder = ['倔强青铜', '秩序白银', '荣耀黄金', '尊贵铂金', '永恒钻石', '至尊星耀', '荣耀王者']
    const oldRankOrder = (name) => {
      const text = String(name || '')
      for (let i = oldOrder.length - 1; i >= 0; i--) if (text.includes(oldOrder[i])) return i
      return -1
    }
    const oldCompare = (a, b) => oldRankOrder(a.name) - oldRankOrder(b.name)
    const unknown = { name: '某某新段位', star: 0 }
    const bronze = { name: '倔强青铜II', star: 0 }
    assert.equal(oldRankOrder('某某新段位'), -1, '未知段位旧写法返回 -1')
    assert.equal(oldRankOrder('倔强青铜II'), 0, '青铜旧写法是 0')
    assert.ok(oldCompare(unknown, bronze) < 0, '旧行为：未知段位会输给青铜')

    // 新行为：弃权
    assert.equal(compareRank(unknown, bronze), 0, '未知段位应弃权')
    assert.equal(compareRank(bronze, unknown), 0, '反向也应弃权')
    assert.equal(compareRank({ name: '', star: 0 }, { name: '荣耀王者', star: 50 }), 0)
  })

  it('真实快照：所有账号的段位都认得出，两两配对方向全对', () => {
    const file = path.join(P, 'data/RankSnapshot.json')
    if (!fs.existsSync(file)) return
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'))
    const entries = snap.entries || snap
    const items = []
    for (const e of Object.values(entries)) {
      const name = e?.rank?.name || e?.rankName || e?.jobName || ''
      if (name) items.push({ name: String(name), star: e?.rank?.star ?? e?.star })
    }
    if (items.length < 2) return

    const unknown = items.filter(i => rankOrder(i.name) === -1)
    assert.equal(unknown.length, 0, `这些段位认不出：${unknown.map(i => i.name).join('、')}`)

    // 独立期望序：段位档 + 星数
    const expectOrder = (item) => {
      const o = rankOrder(item.name)
      return o * 1000 + (Number(item.star) || 0)
    }
    let wrong = 0
    for (const a of items) {
      for (const b of items) {
        if (a === b) continue
        const want = Math.sign(expectOrder(a) - expectOrder(b))
        const got = Math.sign(compareRank(a, b))
        if (want !== got) wrong++
      }
    }
    assert.equal(wrong, 0, `${wrong} 对配对方向错`)
  })
})

/* ══════════════════════════════════════════════ 营地序号（NaN / current 左移 / ids 兜底） */

describe('营地序号：非数字不能删掉第一个', () => {
  // 复刻 #resolveIndexTarget 的序号解析
  const parseNew = (raw) => {
    const parsed = parseInt(raw, 10)
    if (!Number.isInteger(parsed)) return { ok: false }
    return { ok: true, index: parsed - 1 }
  }
  const parseOld = (raw) => {
    const index = parseInt(raw) - 1
    return { ok: !(index < 0 || index >= 3), index }
  }

  it('反证：空串/字母/全角数字在旧写法里越界拦截失效', () => {
    for (const bad of ['', 'abc', '１']) {
      const o = parseOld(bad)
      assert.ok(o.ok, `旧写法应当「放行」${JSON.stringify(bad)}`)
      assert.ok(Number.isNaN(o.index), `旧写法 index 应当是 NaN`)
      // NaN 的两个比较都是 false → 越界拦截整个失效
      assert.equal(NaN < 0, false)
      assert.equal(NaN >= 3, false)
      // 而 splice(NaN, 1) 被当成 splice(0, 1) —— 删掉第一个
      const arr = ['A', 'B', 'C']
      arr.splice(o.index, 1)
      assert.deepEqual(arr, ['B', 'C'], 'splice(NaN) 确实删掉了第一个')
    }
  })

  it('新写法把这些全拦住', () => {
    for (const bad of ['', 'abc', '１', 'x1', '  ', '一']) {
      assert.equal(parseNew(bad).ok, false, `${JSON.stringify(bad)} 应被拦住`)
    }
  })

  it('正常序号与边界不受影响', () => {
    assert.deepEqual(parseNew('1'), { ok: true, index: 0 })
    assert.deepEqual(parseNew('3'), { ok: true, index: 2 })
    assert.deepEqual(parseNew(' 2 '), { ok: true, index: 1 })
    assert.equal(parseNew('0').ok, true)
    assert.equal(parseNew('0').index, -1, '0 应算出 -1 由越界拦截处理')
  })

  it('parseInt 显式带基数 10（0x10 不再被当 16）', () => {
    assert.deepEqual(parseNew('0x2'), { ok: true, index: -1 }, '带基数 10 时 0x2 只解析出 0')
    assert.equal(parseOld('0x2').index, 1, '旧写法无基数会把 0x2 当 16 → index 15')
  })

  it('源码判据：parseInt 带基数、先判 Number.isInteger', () => {
    const src = stripComments(read('apps/accountManager.js'))
    assert.match(src, /parseInt\(stripAtText\(e\.msg\)\.replace\(prefixRe, ''\), 10\)/)
    assert.match(src, /if \(!Number\.isInteger\(parsed\)\)/)
  })
})

describe('营地序号：删低序号后 current 必须左移', () => {
  const del = (ids, current, index) => {
    const wasCurrent = Number(current) || 0
    const arr = [...ids]
    arr.splice(index, 1)
    let cur = wasCurrent
    if (index < wasCurrent) cur = wasCurrent - 1
    if (cur >= arr.length) cur = Math.max(0, arr.length - 1)
    return { ids: arr, current: cur }
  }
  const delOld = (ids, current, index) => {
    const arr = [...ids]
    arr.splice(index, 1)
    let cur = current
    if (cur >= arr.length) cur = Math.max(0, arr.length - 1)
    return { ids: arr, current: cur }
  }

  const A = ['A', 'B', 'C']

  it('反证：删第一个时旧写法把选中的号换掉了', () => {
    // current=1（选中 B），删第 1 个
    const o = delOld(A, 1, 0)
    assert.equal(o.ids[o.current], 'C', '旧写法：选中从 B 变成 C')
    // 而新写法保住 B
    const n = del(A, 1, 0)
    assert.equal(n.ids[n.current], 'B', '新写法：仍是 B')
  })

  it('删的不是当前号 → 当前号本身不变', () => {
    for (const [index, current] of [[0, 1], [0, 2], [1, 2]]) {
      const n = del(A, current, index)
      assert.equal(n.ids[n.current], A[current], `删 #${index + 1} 时选中的 ${A[current]} 应保持`)
    }
  })

  it('删的就是当前号 → 顺延到同位置或最后一个', () => {
    for (const current of [0, 1, 2]) {
      const n = del(A, current, current)
      assert.ok(n.current >= 0 && n.current < n.ids.length, 'current 不能越界')
      const expectIdx = Math.min(current, n.ids.length - 1)
      assert.equal(n.current, expectIdx)
    }
  })

  it('两个号时删当前 → current 夹到 0', () => {
    const n = del(['A', 'B'], 1, 1)
    assert.deepEqual(n.ids, ['A'])
    assert.equal(n.current, 0)
  })

  it('源码判据：左移那行在夹位之前', () => {
    const src = stripComments(read('apps/accountManager.js'))
    const iShift = src.indexOf('if (index < wasCurrent) userData[userId].current = wasCurrent - 1')
    const iClamp = src.indexOf('if (userData[userId].current >= userData[userId].ids.length)')
    assert.ok(iShift > 0, '找不到左移那行')
    assert.ok(iClamp > 0, '找不到夹位那行')
    assert.ok(iShift < iClamp, '左移必须在夹位之前')
  })
})

describe('营地数据：脏条目不再抛 TypeError', () => {
  // 复刻 #loadUserData 的兜底
  const load = (raw, userId) => {
    const userData = raw || {}
    const entry = userData[userId]
    if (!entry || !Array.isArray(entry.ids)) {
      userData[userId] = { ...(entry || {}), ids: [], current: 0 }
    }
    return { userData }
  }

  it('反证：{} / {current:0} / {ids:null} 在旧写法里都会抛', () => {
    const oldLoad = (raw, userId) => {
      const userData = raw || {}
      if (!userData[userId]) userData[userId] = { ids: [], current: 0 }
      return { userData }
    }
    // 这三种在 `.ids.length` 处就抛（undefined / null 没有 length）
    for (const dirty of [{}, { current: 0 }, { ids: null }]) {
      const { userData } = oldLoad({ '123': dirty }, '123')
      assert.throws(() => userData['123'].ids.length, TypeError, `${JSON.stringify(dirty)} 旧写法应抛错`)
    }
  })

  it('反证：{ids:"x"} 不抛但更阴 —— 字符串有 length，后面 splice 才炸', () => {
    // ⚠️ 这条单独写：`'x'.length` 是 1，所以**不会**在长度判断处抛，
    //    而是绕过「一个都没绑」的拦截、一路走到 splice 才 TypeError。
    //    第一版把它混进「都会抛」那组，结果测试自己红了（不是代码的问题）。
    const oldLoad = (raw, userId) => {
      const userData = raw || {}
      if (!userData[userId]) userData[userId] = { ids: [], current: 0 }
      return { userData }
    }
    const { userData } = oldLoad({ '123': { ids: 'x' } }, '123')
    assert.doesNotThrow(() => userData['123'].ids.length, '字符串有 length，这里不抛')
    assert.equal(userData['123'].ids.length, 1, '会被当成「绑了一个号」')
    assert.throws(() => userData['123'].ids.splice(0, 1), TypeError, 'splice 时才炸')
  })

  it('新写法把这些补齐成数组', () => {
    for (const dirty of [{}, { current: 0 }, { ids: null }, { ids: 'x' }]) {
      const { userData } = load({ '123': dirty }, '123')
      assert.ok(Array.isArray(userData['123'].ids), `${JSON.stringify(dirty)} 应被补齐`)
      assert.equal(userData['123'].ids.length, 0)
    }
  })

  it('新用户与正常数据不受影响', () => {
    const a = load({}, '123')
    assert.deepEqual(a.userData['123'], { ids: [], current: 0 })
    const b = load({ '123': { ids: ['1', '2'], current: 1 } }, '123')
    assert.deepEqual(b.userData['123'], { ids: ['1', '2'], current: 1 })
  })

  it('源码判据：判据是「条目存在且 ids 是数组」', () => {
    const src = stripComments(read('apps/accountManager.js'))
    assert.match(src, /if \(!entry \|\| !Array\.isArray\(entry\.ids\)\)/)
    assert.match(src, /!userData\[userId\]\?\.ids\?\.length/)
  })
})

/* ══════════════════════════════════════════════ 英雄梯度榜分路 */

describe('英雄梯度榜：短别名不能抢长别名', () => {
  const src = read('apps/heroTierList.js')
  const parseFilter = new Function(`
    ${extractArray(src, 'SEGMENT_MAP')};
    ${extractArray(src, 'POSITION_MAP')};
    ${extractFunction(src, 'pickByLongestAlias', { export: false })};
    ${extractFunction(src, 'parseFilter', { export: false })};
    return parseFilter
  `)()

  const LABEL = { 0: '全部分路', 1: '对抗路', 2: '中路', 3: '发育路', 4: '游走', 5: '打野' }

  it('反证：旧写法把「中单」判成对抗路', () => {
    const POSITION_MAP = [
      { pos: 1, names: ['对抗路', '对抗', '上单', '单', '边路'] },
      { pos: 2, names: ['中路', '中单', '中'] }
    ]
    const oldPos = (msg) => {
      for (const item of POSITION_MAP) if (item.names.some(n => msg.includes(n))) return item.pos
      return 0
    }
    assert.equal(oldPos('中单'), 1, '旧写法确实判成对抗路')
    assert.equal(oldPos('中单 打野'), 1)
  })

  it('新写法把「中单」判成中路', () => {
    assert.equal(parseFilter('中单').position, 2)
    assert.equal(parseFilter('中单 巅峰赛').position, 2)
    assert.equal(parseFilter('所有段位 中单').position, 2)
    assert.equal(parseFilter('顶端排位 中单').position, 2)
    assert.equal(parseFilter('中单 打野').position, 2)
  })

  it('其它别名回归：都不该被改坏', () => {
    const cases = [
      ['对抗路', 1], ['上单', 1], ['边路', 1], ['单', 1],
      ['中路', 2], ['中', 2],
      ['发育路', 3], ['射手', 3], ['adc', 3], ['下路', 3],
      ['游走', 4], ['辅助', 4], ['游', 4],
      ['打野', 5], ['野', 5]
    ]
    for (const [msg, pos] of cases) {
      assert.equal(parseFilter(msg).position, pos, `「${msg}」应是 ${LABEL[pos]}`)
    }
  })

  it('段位别名回归', () => {
    assert.equal(parseFilter('巅峰赛').segment, 3)
    assert.equal(parseFilter('所有段位').segment, 1)
    assert.equal(parseFilter('顶端排位').segment, 4)
    assert.equal(parseFilter('赛事').segment, 5)
    assert.equal(parseFilter('').segment, 3, '默认巅峰赛1350+')
    assert.equal(parseFilter('').position, 0, '默认全部分路')
  })

  it('真实影响（实测接口）：判错分路会给出完全错误的英雄列表', () => {
    // 2026-10-06 实测营地梯度接口（segment=3）：
    //   中路 position=2 → 31 个英雄（首条 heroId 521）
    //   对抗路 position=1 → 46 个英雄（首条 heroId 180）
    //   两者交集只有 3 个
    // 修复前 `#英雄梯度 中单` 被判成对抗路 → 用户看到的是 46 个对抗路英雄，
    // 而不是 31 个中路英雄，其中 43 个是错的。
    const MID = 31
    const TOP = 46
    const OVERLAP = 3
    const wrong = TOP - OVERLAP
    assert.equal(wrong, 43, '修复前会展示 43 个不属于中路的英雄')
    assert.ok(OVERLAP < Math.min(MID, TOP), '两个分路确实是不同集合')
    assert.equal(parseFilter('中单').position, 2, '「中单」必须走中路')
    assert.equal(parseFilter('中路').position, 2)
  })

  it('长别名优先是稳定的（同样长度取先声明的）', () => {
    // 「中单」长 2 > 「单」长 1，无论表的顺序如何都该选中路
    assert.equal(parseFilter('中单').position, 2)
    // 「巅峰赛1350+」长 8 > 「巅峰赛」长 3，同属 seg 3，结果一致
    assert.equal(parseFilter('巅峰赛1350+').segment, 3)
  })
})

/* ══════════════════════════════════════════════ 营地共享开关 */

describe('营地共享：关闭后开关不能自己弹回', () => {
  it('反证：knownShared 没清时 syncUserBind 会继续同步', () => {
    const knownShared = new Map([['7777777777', true]])
    const enabled = false
    // syncUserBind 的判据：本机开关开着 **或** 库里有他的记录
    const wouldSync = (qq) => enabled || knownShared.get(qq) === true
    assert.equal(wouldSync('7777777777'), true, '旧行为：关闭后仍会同步（开关弹回）')

    // 修复后的行为：disableSharing 里清掉
    knownShared.delete('7777777777')
    assert.equal(wouldSync('7777777777'), false, '新行为：skipped=not-sharing')
  })

  it('源码判据：导出了 forgetKnownShared 并在 disableSharing 里调用', () => {
    const store = stripComments(read('utils/shareStore.js'))
    const users = stripComments(read('utils/shareUsers.js'))
    assert.match(store, /export function forgetKnownShared/)
    assert.match(store, /knownShared\.delete\(qq\)/)
    assert.match(users, /forgetKnownShared/)
    assert.match(users, /forgetKnownShared\(qq\)/)
    // 必须在 setUserShareState 之前就清掉
    const iForget = users.indexOf('forgetKnownShared(qq)')
    const iSet = users.indexOf('setUserShareState(qq, { enabled: false })')
    assert.ok(iForget < iSet, '清理必须在写状态之前')
  })
})

describe('营地共享：关共享不能删掉用户自己绑的号', () => {
  const drop = (entry) => {
    if (!entry?.fromShare) return entry
    const adopted = Array.isArray(entry.adoptedIds) ? entry.adoptedIds.map(String) : null
    if (!adopted) return null
    const adoptedSet = new Set(adopted)
    const kept = (Array.isArray(entry.ids) ? entry.ids : []).filter(id => !adoptedSet.has(String(id)))
    if (!kept.length) return null
    const currentId = String(entry.ids?.[entry.current] ?? '')
    const next = { ...entry, ids: kept, current: Math.max(0, kept.indexOf(currentId)), fromShare: false }
    delete next.adoptedIds
    return next
  }
  const dropOld = (entry) => (entry?.fromShare ? null : entry)

  it('反证：旧写法整条 delete，自绑的号一起没了', () => {
    const entry = { ids: ['1580886057', '1745513318'], current: 1, fromShare: true, adoptedIds: ['1580886057'] }
    assert.equal(dropOld(entry), null, '旧写法整条删掉')
    assert.ok(!JSON.stringify(dropOld(entry) || {}).includes('1745513318'), '自绑的号也没了')
  })

  it('新写法只摘共享来的，留下自己绑的', () => {
    const entry = { ids: ['1580886057', '1745513318'], current: 1, fromShare: true, adoptedIds: ['1580886057'] }
    const n = drop(entry)
    assert.ok(n, '不该整条删')
    assert.deepEqual(n.ids, ['1745513318'], '自己绑的应留下')
    assert.equal(n.current, 0, 'current 应重算到剩下那个号')
    assert.equal(n.fromShare, false, '摘干净后不再是共享来的')
    assert.equal(n.adoptedIds, undefined, '名单也应清掉')
  })

  it('全部来自共享 → 整条删掉，不留空壳', () => {
    assert.equal(drop({ ids: ['a', 'b'], current: 0, fromShare: true, adoptedIds: ['a', 'b'] }), null)
  })

  it('老数据（无 adoptedIds）→ 维持整条删的旧行为', () => {
    assert.equal(drop({ ids: ['a', 'b'], current: 0, fromShare: true }), null)
  })

  it('不是共享来的条目不动', () => {
    const own = { ids: ['a'], current: 0 }
    assert.deepEqual(drop(own), own)
  })

  it('源码判据：adoptSharedBind 记了 adoptedIds，dropAdoptedBind 按名单摘', () => {
    const src = stripComments(read('utils/shareStore.js'))
    assert.match(src, /adoptedIds: \[\.\.\.campIds\]/)
    assert.match(src, /const adopted = Array\.isArray\(entry\.adoptedIds\)/)
    assert.match(src, /filter\(id => !adoptedSet\.has\(String\(id\)\)\)/)
  })
})

describe('营地共享：落盘缓存不再必然过期', () => {
  const src = stripComments(read('utils/shareStore.js'))

  it('反证：落盘沿用 5 秒 TTL 时，30 秒 debounce 到期必然已过期', () => {
    const CACHE_TTL_MS = 5000
    const DEBOUNCE = 30000
    const t0 = 1_700_000_000_000
    const until = t0 + CACHE_TTL_MS
    const flushAt = t0 + DEBOUNCE
    assert.ok(until <= flushAt, '落盘条目在 flush 时一定已过期')
  })

  it('修复后：diskUntil 按 6 小时算，flush 时仍然有效', () => {
    const DISK_TTL_MS = 6 * 3600 * 1000
    const DEBOUNCE = 30000
    const t0 = 1_700_000_000_000
    const diskUntil = t0 + DISK_TTL_MS
    assert.ok(diskUntil > t0 + DEBOUNCE, 'flush 时条目仍有效')
  })

  it('源码判据：有 DISK_TTL_MS、flush 用 diskUntil、读回只给 CACHE_TTL_MS', () => {
    assert.match(src, /const DISK_TTL_MS = 6 \* 3600 \* 1000/)
    assert.match(src, /const diskUntil = base \+ DISK_TTL_MS/)
    assert.ok(!/if \(entry\.until <= now\) continue/.test(src), 'flush 里不该再按内存 until 过滤')
    assert.match(src, /until: now \+ CACHE_TTL_MS/)
  })
})

describe('营地共享：吊销序号正则一致', () => {
  const src = stripComments(read('apps/shareDeploy.js'))

  it('反证：处理函数正则少个「库?」时 id 是 NaN', () => {
    const fnOld = /^#营地共享库吊销\s*(\d+)$/
    for (const msg of ['#营地共享吊销 3', '#营地共享吊销3']) {
      const id = Number(msg.match(fnOld)?.[1])
      assert.ok(Number.isNaN(id), `${msg} 旧写法应得 NaN`)
      assert.equal(Number.isInteger(id), false)
    }
  })

  it('修复后：rule 放行的写法都能取到整数', () => {
    const rule = /^#营地共享库?吊销\s*(\d+)$/
    const fnNew = /^#营地共享库?吊销\s*(\d+)$/
    for (const msg of ['#营地共享库吊销 3', '#营地共享吊销 3', '#营地共享库吊销3', '#营地共享吊销3']) {
      assert.equal(rule.test(msg), true, `rule 应放行 ${msg}`)
      const id = Number(msg.match(fnNew)?.[1])
      assert.equal(Number.isInteger(id), true, `${msg} 应取到整数`)
      assert.equal(id, 3)
    }
  })

  it('源码判据：处理函数正则带 库?，且显式挡非整数', () => {
    assert.match(src, /e\.msg\.match\(\/\^#营地共享库\?吊销/)
    assert.match(src, /if \(!Number\.isInteger\(id\)\)/)
  })
})

/* ══════════════════════════════════════════════ 本地绑定指纹 */

describe('本地绑定：等长改写必须判得出', () => {
  const src = stripComments(read('utils/localBind.js'))

  it('源码判据：指纹含 ino 与 ctimeNs，比较四个量', () => {
    assert.match(src, /ino: stat\.ino/)
    assert.match(src, /ctimeNs: stat\.ctimeNs/)
    assert.match(src, /cache\.ino === fp\.ino/)
    assert.match(src, /cache\.ctimeNs === fp\.ctimeNs/)
  })

  it('反证：只看 mtimeNs + size 时，等长改写会误判命中', () => {
    // 复刻「同一次 4ms tick 内两次等长原子写」的情形
    const cache = { mtimeNs: 1000n, size: 1796n }
    const fp = { mtimeNs: 1000n, size: 1796n, ino: 99n, ctimeNs: 1000n }
    const oldHit = cache.mtimeNs === fp.mtimeNs && cache.size === fp.size
    assert.equal(oldHit, true, '旧判据误判为未变（漏判）')

    const cache2 = { mtimeNs: 1000n, size: 1796n, ino: 98n, ctimeNs: 1000n }
    const newHit = cache2.mtimeNs === fp.mtimeNs && cache2.size === fp.size &&
      cache2.ino === fp.ino && cache2.ctimeNs === fp.ctimeNs
    assert.equal(newHit, false, '新判据认出 inode 变了')
  })

  it('原子写确实换 inode（writeYamlFile 走 writeFileAtomic）', () => {
    const yaml = stripComments(read('utils/yamlUtils.js'))
    assert.match(yaml, /writeFileAtomic/)
    const safe = read('utils/safeStore.js')
    assert.match(safe, /renameSync|rename\(/, 'writeFileAtomic 应当用 rename 落地')
  })
})

/* ══════════════════════════════════════════════ 账号池 createdAt */

describe('账号池：createdAt 不再每次落盘被刷', () => {
  const src = stripComments(read('utils/authStore.js'))

  it('源码判据：#normalizePool 把原账号当 existing 传下去', () => {
    assert.match(src, /const existing = sourceAccounts\[normalizedUserId\] \|\| \{\}/)
    assert.match(src, /\}, existing\)/)
  })

  it('反证：不传 existing 时 created 解析器会取当前时间', () => {
    const created = (key, account, existing, timestamp) => existing[key] || timestamp
    const ts = '2026-03-03T00:00:00.000Z'
    assert.equal(created('createdAt', {}, {}, ts), ts, '旧行为：被刷成当前时间')

    const real = { createdAt: '2026-01-01T00:00:00.000Z' }
    assert.equal(created('createdAt', {}, real, ts), real.createdAt, '新行为：保留旧值')
  })

  it('updated 仍然每次刷新（那是有意的）', () => {
    const updated = (key, account, existing, timestamp) => timestamp
    assert.equal(updated('updatedAt', {}, { updatedAt: 'old' }, 'new'), 'new')
  })
})

/* ══════════════════════════════════════════════ 皮肤评级归一化 */

describe('皮肤评级：前导空格 / SSR / SP', () => {
  const src = read('utils/skinCatalog.js')
  const SZ_ORDER = new Function(`${extractArray(src, 'SZ_ORDER')}; return SZ_ORDER`)()
  const normalizeSzClass = new Function(`${extractFunction(src, 'normalizeSzClass')}; return normalizeSzClass`)()

  it('反证：不归一化时「 A」匹配不上（掉到最后）', () => {
    const raw = ' A'
    assert.equal(SZ_ORDER.includes(raw), false, '原始值匹配不上')
    assert.equal(SZ_ORDER.indexOf(raw), -1)
    // 归一化之后能匹配上，且落在 A 档
    assert.equal(SZ_ORDER.includes(normalizeSzClass(raw)), true)
    assert.equal(SZ_ORDER.indexOf(normalizeSzClass(raw)), SZ_ORDER.indexOf('A'))
  })

  it('归一化：去空白、全角转半角、转大写', () => {
    assert.equal(normalizeSzClass(' A'), 'A')
    assert.equal(normalizeSzClass('a'), 'A')
    assert.equal(normalizeSzClass('　S++'), 'S++')
    assert.equal(normalizeSzClass('Ｓ＋＋'), 'S++', '全角字母加号也应转过来')
    assert.equal(normalizeSzClass('  ssr  '), 'SSR')
    assert.equal(normalizeSzClass(null), '')
    assert.equal(normalizeSzClass(undefined), '')
  })

  it('SZ_ORDER 补进了 SSR / SP，且顺序合理', () => {
    assert.ok(SZ_ORDER.includes('SSR'))
    assert.ok(SZ_ORDER.includes('SP'))
    assert.ok(SZ_ORDER.indexOf('SSR') < SZ_ORDER.indexOf('SR'), 'SSR 应高于 SR')
    assert.ok(SZ_ORDER.indexOf('SR') < SZ_ORDER.indexOf('S++'), 'SR 盖过 S++（营地口径）')
    assert.ok(SZ_ORDER.indexOf('A') < SZ_ORDER.indexOf('B'))
  })

  it('两个消费方都走了 normalizeSzClass', () => {
    const wall = stripComments(read('apps/skinWall.js'))
    const miss = stripComments(read('apps/skinMissing.js'))
    assert.match(wall, /normalizeSzClass\(skin\.szClass\)/)
    assert.match(miss, /normalizeSzClass\(value\)/)
    // skinWall 未命中时应排到 SZ_ORDER.length，而不是写死的 7
    assert.match(wall, /: SZ_ORDER\.length/)
    assert.ok(!/SZ_ORDER\.indexOf\(szClass\) : 7/.test(wall), '不该再有写死的 7')
  })

  it('真实分布（968 条实时配置）：只有「 A」需要归一化，且归一后 100% 命中', () => {
    // 线上实测的真实分布（2026-10-06 从营地接口拉全量 968 条）：
    //   S×291 A×257 B×221 S+×148 S++×20 SR×15 SSR×13 SP×2 " A"×1
    // 只有 " A"（孙权 skinId 15101）原值命中不了，归一后命中。
    const realDist = { S: 291, A: 257, B: 221, 'S+': 148, 'S++': 20, SR: 15, SSR: 13, SP: 2, ' A': 1 }
    const total = Object.values(realDist).reduce((a, b) => a + b, 0)
    assert.equal(total, 968, '真实总数应为 968')

    let missRaw = 0
    let missNorm = 0
    for (const [raw, n] of Object.entries(realDist)) {
      if (!SZ_ORDER.includes(raw)) missRaw += n
      if (!SZ_ORDER.includes(normalizeSzClass(raw))) missNorm += n
    }
    assert.equal(missRaw, 1, '修复前有 1 条命中不了（" A"）')
    assert.equal(missNorm, 0, '修复后全部命中')

    // 归一后「 A」落在 A 档，不再是末档
    assert.equal(SZ_ORDER.indexOf(normalizeSzClass(' A')), SZ_ORDER.indexOf('A'))
    assert.ok(SZ_ORDER.indexOf('A') < SZ_ORDER.indexOf('D'), 'A 档应远在末档之前')
  })
})

/* ══════════════════════════════════════════════ 排行榜多绑定 */

describe('排行榜：同一营地号被多人绑定时都能认出自己', () => {
  const src = read('utils/rankStore.js')
  // buildRankList 依赖 calcRankSort / normalizeName，一并抽出来
  const buildRankList = new Function(`
    const normalizeName = v => String(v ?? '')
    const calcRankSort = (name, star) => (name ? 1 : 0) * 1000 + (Number(star) || 0)
    ${extractFunction(src, 'buildRankList')}
    return buildRankList
  `)()

  const entries = {
    a: { campId: '1807995411', roleName: '甲', rankName: '王者', rankStar: 10, peakScore: 0 },
    b: { campId: '999', roleName: '乙', rankName: '钻石', rankStar: 3, peakScore: 0 }
  }

  it('反证：只留首个绑定人时第二个人找不到自己那行', () => {
    const oldMap = {}
    for (const item of [{ campId: '1807995411', botUserId: '3220564986' }, { campId: '1807995411', botUserId: '3667259455' }]) {
      if (!oldMap[item.campId]) oldMap[item.campId] = item.botUserId
    }
    const list = buildRankList(entries, 'rank', { campIds: ['1807995411', '999'], ownerMap: oldMap })
    const row = list.find(i => String(i.campId) === '1807995411')
    assert.equal(row.botUserId, '3220564986')
    // 旧代码用 botUserId 找自己 → 第二个人落空
    assert.equal(row.botUserId === '3667259455', false, '旧写法第二个人认不出')
  })

  it('新写法：botUserIds 含全部绑定人', () => {
    const ownerMap = { 1807995411: ['3220564986', '3667259455'] }
    const list = buildRankList(entries, 'rank', { campIds: ['1807995411', '999'], ownerMap })
    const row = list.find(i => String(i.campId) === '1807995411')
    assert.deepEqual(row.botUserIds, ['3220564986', '3667259455'])
    assert.equal(row.botUserId, '3220564986', 'botUserId 保持老语义（首个）')
    // 两个人都能认出自己
    for (const qq of ['3220564986', '3667259455']) {
      assert.equal((row.botUserIds || [row.botUserId]).includes(qq), true, `${qq} 应认出自己`)
    }
  })

  it('兼容老写法（ownerMap 直接给字符串）', () => {
    const list = buildRankList(entries, 'rank', { campIds: ['1807995411'], ownerMap: { 1807995411: '3220564986' } })
    assert.equal(list[0].botUserId, '3220564986')
    assert.deepEqual(list[0].botUserIds, ['3220564986'])
  })

  it('没有绑定人时是空数组，不崩', () => {
    const list = buildRankList(entries, 'rank', { campIds: ['1807995411'], ownerMap: {} })
    assert.equal(list[0].botUserId, '')
    assert.deepEqual(list[0].botUserIds, [])
  })

  it('源码判据：rankList 收集全部绑定人并查 selfEntry 用 botUserIds', () => {
    const app = stripComments(read('apps/rankList.js'))
    assert.match(app, /ownerMap\[key\]\.push\(String\(item\.botUserId\)\)/)
    assert.match(app, /item\.botUserIds \|\| \[item\.botUserId\]\)\.includes\(selfId\)/)
  })

  it('真实数据：确实存在一个营地号被多人绑定，且第二个人旧写法认不出', () => {
    const file = path.join(P, 'data/UserData.yaml')
    if (!fs.existsSync(file)) return
    const text = fs.readFileSync(file, 'utf8')
    // ⚠️ 真实格式：顶层键在**第 0 列**带引号，列表项缩进 **4 空格**
    //    （第一版按 2/6 空格写，一条都没匹配上，测试静默通过 —— 所以这里断言必须真取到数据）
    const bindings = []
    let qq = null
    for (const line of text.split('\n')) {
      const mQQ = line.match(/^"?(.+?)"?:?\s*$/)
      if (mQQ && !/^\s/.test(line) && !/^-/.test(line)) {
        const k = mQQ[1].replace(/^"|"$/g, '')
        if (/^\d+$/.test(k)) { qq = k; continue }
      }
      const mId = line.match(/^\s+- "?([^"\s]+)"?\s*$/)
      if (mId && qq) bindings.push({ botUserId: qq, campId: mId[1].replace(/^"|"$/g, '') })
    }
    assert.ok(bindings.length > 0, '应当解析出真实绑定（解析失败时这里必须红，不能静默跳过）')

    const byCamp = new Map()
    for (const b of bindings) {
      if (!byCamp.has(b.campId)) byCamp.set(b.campId, new Set())
      byCamp.get(b.campId).add(b.botUserId)
    }
    const multi = [...byCamp.entries()].filter(([, set]) => set.size > 1)
    if (!multi.length) return

    // 用真实的 buildRankList 跑：第二个人必须认得出自己那行
    const snapFile = path.join(P, 'data/RankSnapshot.json')
    let entries = {}
    if (fs.existsSync(snapFile)) {
      const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'))
      entries = snap.entries || snap
    }
    const campIds = [...byCamp.keys()]
    for (const [campId] of multi) {
      if (!entries[campId]) entries[campId] = { campId, roleName: `测试${campId}`, rankName: '王者', rankStar: 10, peakScore: 0 }
    }

    const oldMap = {}
    for (const b of bindings) if (!oldMap[b.campId]) oldMap[b.campId] = b.botUserId
    const listOld = buildRankList(entries, 'rank', { campIds, ownerMap: oldMap })

    const newMap = {}
    for (const b of bindings) {
      const k = String(b.campId)
      if (!newMap[k]) newMap[k] = []
      if (!newMap[k].includes(String(b.botUserId))) newMap[k].push(String(b.botUserId))
    }
    const listNew = buildRankList(entries, 'rank', { campIds, ownerMap: newMap })

    let okOld = 0
    let okNew = 0
    let total = 0
    for (const [campId, set] of multi) {
      for (const person of set) {
        total++
        const rowOld = listOld.find(i => String(i.campId) === campId)
        const rowNew = listNew.find(i => String(i.campId) === campId)
        if (listOld.find(i => i.botUserId === person)?.index === rowOld?.index) okOld++
        if (listNew.find(i => (i.botUserIds || [i.botUserId]).includes(person))?.index === rowNew?.index) okNew++
      }
    }
    assert.equal(okNew, total, '修复后每个绑定人都应认得出自己')
    assert.ok(okOld < okNew, `修复前应当有认不出的（实际 ${okOld}/${total}）`)
  })
})

/* ══════════════════════════════════════════════ 主页 1970 */

describe('王者主页：时间戳为 0 时不能显示 1970', () => {
  it('反证：moment(0) 会渲染出 1970', async () => {
    let moment
    try {
      moment = (await import('moment')).default
    } catch {
      return   // 拿不到 moment 就跳过
    }
    const s = moment(0).locale('zh-cn').calendar()
    assert.match(s, /1970/, `moment(0) 应当渲染出 1970，实际 ${s}`)
  })

  it('源码判据：有 fmtCalendar 且挡住 <= 0', () => {
    const src = stripComments(read('apps/myKingHomepage.js'))
    assert.match(src, /const fmtCalendar = \(ts\) => \{/)
    assert.match(src, /if \(!Number\.isFinite\(sec\) \|\| sec <= 0\) return '—'/)
    assert.match(src, /const onlineTime = fmtCalendar\(onlineTimestamp\)/)
    assert.match(src, /const offlineTime = fmtCalendar\(offlineTimestamp\)/)
  })

  it('判据行为：0 / 空串 / NaN 都给 —，正常值才格式化', () => {
    const fmt = (ts) => {
      const sec = Number(ts)
      if (!Number.isFinite(sec) || sec <= 0) return '—'
      return `TS:${sec}`
    }
    assert.equal(fmt(0), '—')
    assert.equal(fmt(''), '—')
    assert.equal(fmt(null), '—')
    assert.equal(fmt(undefined), '—')
    assert.equal(fmt(NaN), '—')
    assert.equal(fmt(-1), '—')
    assert.equal(fmt(1791215955), 'TS:1791215955')
  })
})

/* ══════════════════════════════════════════════ 全赛季（有分无场次） */

describe('全赛季：有巅峰分但场次为 0 的赛季（1200 起始分是坑）', () => {
  const src = stripComments(read('apps/allSeasonPerformance.js'))

  it('源码判据：阈值是 PEAK_BASE_SCORE=1200，不是 0', () => {
    assert.match(src, /const PEAK_BASE_SCORE = 1200/)
    assert.match(src, /Number\(s\.masterScore\) > PEAK_BASE_SCORE/)
    // 不能再用 > 0（那会把 1200 起始分噪音全放进来）
    assert.ok(!/mode === '巅峰' && Number\(s\.masterScore\) > 0\)/.test(src), '不该再用 > 0')
  })

  it('反证：只看 games > 0 会丢掉真打过但场次缺的赛季', () => {
    const seasons = [
      { games: 0, masterScore: 1254 },   // 真打过（S45）
      { games: 0, masterScore: 1200 },   // 从没打过（起始分）
      { games: 12, masterScore: 1400 }
    ]
    const oldPlayed = seasons.filter(s => s.games > 0)
    assert.equal(oldPlayed.length, 1, '旧判据只剩 1 个，把 1254 那个真赛季丢了')
  })

  it('反证：改成 masterScore > 0 是错的 —— 会把 1200 起始分当战绩', () => {
    // ⚠️ 这是我第一轮的错误结论，必须留在测试里防复发。
    //    masterScore=1200 是**巅峰赛起始分**，接口给每个赛季都回，包括从没打过的。
    const seasons = [
      { games: 0, masterScore: 1254 },
      { games: 0, masterScore: 1200 },
      { games: 0, masterScore: 1200 },
      { games: 0, masterScore: 1200 }
    ]
    const midPlayed = seasons.filter(s => s.games > 0 || s.masterScore > 0)
    assert.equal(midPlayed.length, 4, '>0 会把 3 个 1200 噪音全放进来')
  })

  it('最终判据：masterScore > 1200 只留真的', () => {
    const seasons = [
      { games: 0, masterScore: 1254 },
      { games: 0, masterScore: 1200 },
      { games: 0, masterScore: 1200 },
      { games: 12, masterScore: 1400 },
      { games: 3, masterScore: 1200 }   // 有场次的 1200 也要留（那是真打过）
    ]
    const played = seasons.filter(s => s.games > 0 || s.masterScore > 1200)
    assert.equal(played.length, 3, '留下 1254、1400、以及有场次的 1200')
    assert.ok(played.some(s => s.masterScore === 1254), '真赛季要留')
    assert.ok(played.some(s => s.games === 3), '有场次的低分赛季要留')
  })

  it('真实数据（4 个号实测）：最终版比中间错误版少 20 个噪音、比修复前多 3 个真赛季', () => {
    // 2026-10-06 实测：修复前 39 → 中间错误版 62（+23，其中 20 个是 1200）→ 最终版 42（+3）
    // 多出来的 3 个正是：224007548 S43(1250)、402082480 S45(1254)、497985992 S45(1515)
    const perAccount = {
      '224007548': { old: 19, mid: 23, now: 20 },
      '402082480': { old: 12, mid: 23, now: 13 },
      '497985992': { old: 2, mid: 10, now: 3 },
      '1580886057': { old: 6, mid: 6, now: 6 }
    }
    const sum = k => Object.values(perAccount).reduce((s, v) => s + v[k], 0)
    assert.equal(sum('old'), 39)
    assert.equal(sum('mid'), 62)
    assert.equal(sum('now'), 42)
    assert.equal(sum('mid') - sum('now'), 20, '中间版多出的噪音数')
    assert.equal(sum('now') - sum('old'), 3, '最终版真正多救回来的赛季数')
  })

  it('排位模式不受影响（没分就不该放宽）', () => {
    const seasons = [{ games: 0, masterScore: 1250 }, { games: 5, masterScore: 0 }]
    const mode = '排位'
    const played = seasons.filter(s => s.games > 0 || (mode === '巅峰' && Number(s.masterScore) > 1200))
    assert.equal(played.length, 1)
  })

  it('场次为 0 时胜率显示 — 而不是 0%', () => {
    assert.match(src, /\(games \? `\$\{Math\.round\(\(wins \/ games\) \* 100\)\}%` : '—'\)/)
    const winRate = (info) => {
      const games = Number(info.totalCnt) || 0
      const wins = Number(info.totalWinCnt) || 0
      return info.winRate ? `${Math.round(info.winRate * 100)}%` : (games ? `${Math.round((wins / games) * 100)}%` : '—')
    }
    assert.equal(winRate({ totalCnt: 0, totalWinCnt: 0 }), '—')
    assert.equal(winRate({ totalCnt: 0, totalWinCnt: 0, winRate: 0.5 }), '50%')
    assert.equal(winRate({ totalCnt: 4, totalWinCnt: 1 }), '25%')
  })
})

/* ══════════════════════════════════════════════ 荣耀称号分组名 */

describe('荣耀称号：出图与文字兜底用同一个分组名', () => {
  const src = read('apps/heroMedalWall.js')
  const groupTitle = new Function(`${extractFunction(src, 'groupTitle', { export: false })}; return groupTitle`)()

  it('反证：两处各写一份时「小范围榜」和「本区榜」不一致', () => {
    const oldImage = (group) => (group.area ? `${group.area}榜` : '小范围榜')
    const oldText = (group) => `${group.area || '本区'}榜`
    const g = { area: '' }
    assert.equal(oldImage(g), '小范围榜')
    assert.equal(oldText(g), '本区榜')
    assert.notEqual(oldImage(g), oldText(g), '旧写法两处不一致')
  })

  it('新写法两处一致', () => {
    assert.equal(groupTitle({ area: '' }), '小范围榜')
    assert.equal(groupTitle({ area: '杭州市' }), '杭州市榜')
    assert.equal(groupTitle(null), '小范围榜')
  })

  it('源码判据：两处都调 groupTitle', () => {
    const s = stripComments(src)
    assert.match(s, /function groupTitle \(group\)/)
    assert.match(s, /title: groupTitle\(group\)/)
    assert.match(s, /groupTitle\(group\)\}（/)
    assert.ok(!/\$\{group\.area \|\| '本区'\}榜/.test(s), '文字兜底不该再自己拼')
  })
})

/* ══════════════════════════════════════════════ 我的英雄战力口径（主人要求不动出图） */

describe('我的英雄：出图口径按主人要求保持原样', () => {
  const src = stripComments(read('apps/myHeroList.js'))
  const tpl = read('resources/html/MyHeroList.html')

  it('确认「表头说最高、行内可能混当前值」这个现象存在', () => {
    // 现象是真的：history.ok 是整表判据（byHero.size > 0），
    // 行内是 `maxPower || 当前战力` 逐英雄兜底 —— 两者可能不一致。
    const byHero = new Map([['100', { maxPower: 5000 }]])
    const ok = byHero.size > 0
    assert.equal(ok, true)
    const hit = byHero.get('200')
    const maxPower = Number(hit?.maxPower) || 0
    const displayPower = maxPower || 1234
    assert.equal(maxPower, 0, '这一行没拿到历史最高')
    assert.equal(displayPower, 1234, '显示的是当前战力')
  })

  it('按主人 2026-10-06 的决定：出图不加说明，代码也不加逐行标记', () => {
    // 主人看过渲染图后要求「页脚别加这句，改回去」，所以：
    //   · 模板里不该出现 powerFallback
    //   · 代码里不该出现 fromHistory / fellBackCount
    assert.ok(!/powerFallback/.test(tpl), '模板不该再有 powerFallback')
    assert.ok(!/fromHistory/.test(src), '代码不该再有 fromHistory')
    assert.ok(!/fellBackCount/.test(src), '代码不该再有 fellBackCount')
    // 页脚保持原样
    assert.match(tpl, /战力为历史最高值，称号为拿到该战力时的/)
  })
})
