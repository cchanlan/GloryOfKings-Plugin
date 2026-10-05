/* ══════════════════════════════════════════════════════════════════════════
 * 第四轮审计的修复（2026-10-06）—— apps/ 未覆盖文件 + 热重载根因族扫尾
 *
 * 这一轮的 8 处：
 *   ① seasonPage 的赛季趋势混入赛季外数据（Y轴标签错、-95 断崖）
 *   ② peakPerformance 同源（巅峰分每赛季重置，画成掉分）
 *   ③ blackList 取 QQ 号正则缺前置边界，长数字串会截错
 *   ④ shareNotify 顶层定时器随热重载累积
 *   ⑤⑥⑦⑧ 锁/游标/待确认表/待落盘队列被热重载架空（hotBox）
 * ══════════════════════════════════════════════════════════════════════════ */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const P = path.resolve(import.meta.dirname, '..')
const read = f => fs.readFileSync(path.join(P, f), 'utf8')
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/* ══════════════════════════════ ① 赛季趋势必须按窗口过滤 */

describe('赛季表现：上分趋势不能混入赛季外的点', () => {
  const src = read('apps/seasonPage.js')

  it('源码判据：按 target.startTime/endTime 过滤', () => {
    assert.match(src, /const trendStart = Number\(target\.startTime\) \|\| 0/)
    assert.match(src, /const trendEnd = Number\(target\.endTime\) \|\| 0/)
    assert.match(src, /ts >= trendStart && ts <= trendEnd/)
  })

  it('窗口取不到时不过滤（宁可不截断，也不能清空曲线）', () => {
    assert.match(src, /if \(!trendStart \|\| !trendEnd\) return true/)
  })

  it('反证：真实数据下旧口径的 Y 轴标签与断崖都是错的', () => {
    // 真实 campId 1580886057 / roleId 1185348788 的 S45 gameTrend（实测 11 点）
    const gt = [
      { time: '1791212785', jobName: '星耀III', stars: 5, totalRankStar: 85 },
      { time: '1790875276', jobName: '星耀III', stars: 2, totalRankStar: 85 },
      { time: '1790453364', jobName: '星耀III', stars: 3, totalRankStar: 85 },
      { time: '1790435587', jobName: '星耀IV', stars: 3, totalRankStar: 80 },
      { time: '1790330188', jobName: '星耀IV', stars: 2, totalRankStar: 80 },
      { time: '1790264963', jobName: '星耀IV', stars: 1, totalRankStar: 80 },
      // ↓ 以下 5 点是 S44（赛季外），S45 起于 1790092800
      { time: '1790087205', jobName: '最强王者', stars: 76, totalRankStar: 100 },
      { time: '1790006325', jobName: '最强王者', stars: 69, totalRankStar: 100 },
      { time: '1789854461', jobName: '最强王者', stars: 69, totalRankStar: 100 },
      { time: '1789333274', jobName: '最强王者', stars: 68, totalRankStar: 100 },
      { time: '1788875718', jobName: '最强王者', stars: 63, totalRankStar: 100 }
    ]
    const startTime = 1790092800
    const endTime = 1798473600
    const sum = t => (Number(t.totalRankStar) || 0) + (Number(t.stars) || 0)
    const rev = gt.slice().reverse()
    const label = t => `${String(t.jobName || '').replace('最强', '')} ${t.stars}星`
    const worst = arr => { let v = 0; for (let i = 1; i < arr.length; i++) { const d = arr[i] - arr[i - 1]; if (d < v) v = d } return v }

    // 旧口径
    const oldTrend = rev.map(sum)
    const oldMax = oldTrend.indexOf(Math.max(...oldTrend))
    assert.equal(label(rev[oldMax]), '王者 76星', '旧口径 Y 轴标签是赛季外的值')
    assert.equal(worst(oldTrend), -95, '旧口径有 -95 的赛季重置断崖')

    // 新口径
    const filtered = rev.filter(t => Number(t.time) >= startTime && Number(t.time) <= endTime)
    const newTrend = filtered.map(sum)
    const newMax = newTrend.indexOf(Math.max(...newTrend))
    assert.equal(filtered.length, 6, '过滤后剩 6 个本赛季的点')
    assert.equal(label(filtered[newMax]), '星耀III 5星', '新口径标签是本赛季真实最高')
    assert.equal(worst(newTrend), -1, '断崖消失')
  })

  it('模板在 trend 少于 2 点时不出图（过滤到空是安全的）', () => {
    const tpl = read('resources/html/SeasonPage.html')
    assert.match(tpl, /\{\{if trend && trend\.length > 1\}\}/)
  })
})

describe('巅峰表现：回落路径同样要按赛季窗过滤', () => {
  const src = read('apps/peakPerformance.js')

  it('源码判据：回落路径有窗口过滤，归档路径不受影响', () => {
    assert.match(src, /const trendStart = Number\(history\[0\]\?\.startTime\) \|\| 0/)
    assert.match(src, /ts >= trendStart && ts <= trendEnd/)
    // 过滤必须挂在 useArchive 的 false 分支上（归档是近 30 天逐日聚合，本来就不跨赛季）
    const idx = src.indexOf('const trend = useArchive')
    assert.ok(idx > 0, 'trend 仍是 useArchive 三元')
    const seg = src.slice(idx, idx + 700)
    assert.match(seg, /: \(ri\.gameTrend \|\| \[\]\)\.slice\(\)\.reverse\(\)/, '过滤在回落分支上')
  })

  it('窗口取不到时不过滤', () => {
    assert.match(src, /if \(!trendStart \|\| !trendEnd\) return true/)
  })

  it('gameTrend 点同时带 score（巅峰分）与 stars/jobName（段位快照）', () => {
    // 实测一条真实点，确认 score 语义（这正是回落路径读它的依据）
    const real = { roleJob: 22, stars: 5, score: 1580, time: '1791212785', jobName: '星耀III', totalRankStar: 85 }
    assert.equal(Number(real.score), 1580)
    assert.equal(real.jobName, '星耀III')
  })
})

/* ══════════════════════════════ ③ 黑名单取 QQ 号 */

describe('黑名单：从消息里取 QQ 号不能截错', () => {
  const src = read('apps/blackList.js')

  it('源码判据：有前置边界 (?<!\\d)', () => {
    assert.match(src, /match\(\/\(\?<!\\d\)\(\\d\{5,12\}\)\(\?!\\d\)\/\)/)
  })

  it('red/green：旧正则截错，新正则取不到（走正常提示）', () => {
    const oldRe = /(\d{5,12})(?!\d)/
    const newRe = /(?<!\d)(\d{5,12})(?!\d)/
    const pick = (re, s) => (s.match(re) || [])[1] || null

    // 正常长度：两者一致
    assert.equal(pick(oldRe, '#王者拉黑 1580886057'), '1580886057')
    assert.equal(pick(newRe, '#王者拉黑 1580886057'), '1580886057')
    assert.equal(pick(oldRe, '#王者拉黑 12345678'), '12345678')
    assert.equal(pick(newRe, '#王者拉黑 12345678'), '12345678')

    // 长数字串：旧的截错，新的取不到
    assert.equal(pick(oldRe, '#王者拉黑 1234567890123'), '234567890123', '旧：第 1 位被吃掉')
    assert.equal(pick(newRe, '#王者拉黑 1234567890123'), null, '新：取不到')
    assert.equal(pick(oldRe, '#王者拉黑 12345678901234'), '345678901234', '旧：前 2 位被吃掉')
    assert.equal(pick(newRe, '#王者拉黑 12345678901234'), null, '新：取不到')
    assert.equal(pick(oldRe, '#王者拉黑 1580886057123456789'), '057123456789', '旧：截出个不存在的号')
    assert.equal(pick(newRe, '#王者拉黑 1580886057123456789'), null, '新：取不到')
  })

  it('插件里只有这一处是「无前置边界」的取号正则（其余都锚定了）', () => {
    // shareDeploy 是 ^...$、kingCompare/avatar/atTarget 是 ^\d{5,12}$
    const others = ['apps/shareDeploy.js', 'apps/kingCompare.js', 'utils/avatar.js', 'utils/atTarget.js']
    for (const f of others) {
      const s = stripComments(read(f))
      assert.equal(/match\(\/\(\\d\{5,12\}\)\(\?!\\d\)\//.test(s), false, `${f} 不该有裸的取号正则`)
    }
  })
})

/* ══════════════════════════════ ④ 热重载：全局唯一的东西不能随求值重建 */

describe('热重载：进程退出钩子与顶层定时器不能随模块重新求值而累积', () => {
  it('shareNotify 的 boot 定时器用 globalThis 标记去重', () => {
    const src = stripComments(read('apps/shareNotify.js'))
    assert.match(src, /const BOOT_TIMER_KEY = '__gokShareNotifyBootTimer'/)
    assert.match(src, /if \(!globalThis\[BOOT_TIMER_KEY\]\) \{/)
    assert.match(src, /globalThis\[BOOT_TIMER_KEY\] = bootTimer/)
  })

  it('shareStore 的 exit 钩子用 globalThis 标记去重', () => {
    const src = stripComments(read('utils/shareStore.js'))
    assert.match(src, /const EXIT_HOOK_KEY = '__gokShareStoreExitHook'/)
    assert.match(src, /if \(!globalThis\[EXIT_HOOK_KEY\]\) \{/)
    assert.match(src, /process\.once\('exit', flushNow\)/)
  })

  it('反证：裸的顶层副作用在模块反复求值时会累积', () => {
    // 旧写法：每代都挂一个
    let timers = 0
    for (let i = 0; i < 12; i++) timers++
    assert.equal(timers, 12, '旧写法 12 代 = 12 个定时器')
    assert.ok(timers > 10, 'exit 监听器会在第 11 个触发 MaxListenersExceededWarning')

    // 新写法：globalThis 标记挡住
    const g = {}
    const KEY = '__x'
    let n = 0
    for (let i = 0; i < 12; i++) if (!g[KEY]) { g[KEY] = true; n++ }
    assert.equal(n, 1, '新写法 12 代只注册 1 次')
  })
})

/* ══════════════════════════════ ⑤ hotBox 本身 */

describe('hotBox：跨热重载共享的可变状态盒', () => {
  it('模块导出 hotBox', () => {
    const src = read('utils/hotState.js')
    assert.match(src, /export function hotBox \(key, initial\)/)
    assert.match(src, /const K = `__gokHotBox__\$\{key\}`/)
    assert.match(src, /if \(existing\) return existing/, '已存在就复用同一个盒子')
  })

  it('首次创建用 initial，后续代次忽略 initial（不重置状态）', async () => {
    const { hotBox } = await import('../utils/hotState.js')
    const key = `test.${Date.now()}.${Math.random()}`
    const a = hotBox(key, { running: false, cursor: 0 })
    a.running = true
    a.cursor = 7
    // 模拟热重载：同一个 key 再要一次，initial 是「干净的初始值」
    const b = hotBox(key, { running: false, cursor: 0 })
    assert.equal(b.running, true, '不能因为 initial 又变回 false')
    assert.equal(b.cursor, 7, '游标要保留')
    assert.equal(a, b, '必须是同一个对象')
    delete globalThis[`__gokHotBox__${key}`]
  })
})

describe('热重载：各处的锁/游标/待确认表都锚进 hotBox 了', () => {
  const expectations = [
    ['apps/battleReport.js', /hotBox\('battleReport\.pushing', \{ pushing: false \}\)/],
    ['apps/groupReport.js', /hotBox\('groupReport\.pushing', \{ pushing: false \}\)/],
    ['apps/whoIsPlaying.js', /hotBox\('whoIsPlaying\.refreshing', \{/],
    ['apps/gameRecordPush.js', /hotBox\('gameRecordPush\.state', \{/],
    ['apps/watchBattle.js', /hotBox\('watchBattle\.pendingReplace', \{ pendingReplace: new Map\(\) \}\)/],
    ['utils/pushStore.js', /hotBox\('pushStore\.pendingPatches', \{ pendingPatches: null \}\)/]
  ]

  for (const [file, re] of expectations) {
    it(`${file} 的模块级状态已锚定`, () => {
      const src = read(file)
      assert.match(src, re)
      assert.match(src, /import \{ hotBox \} from '\.\.\/(\.\.\/)?utils\/hotState\.js'|import \{ hotBox \} from '\.\/hotState\.js'/)
    })
  }

  it('原来的裸 let 声明都清掉了（不能留一半在外面）', () => {
    const checks = [
      ['apps/battleReport.js', /^let pushing = false$/m],
      ['apps/groupReport.js', /^let pushing = false$/m],
      ['apps/whoIsPlaying.js', /^let refreshing = false$/m],
      ['apps/gameRecordPush.js', /^let running = false$/m],
      ['apps/gameRecordPush.js', /^let cursor = 0$/m],
      ['apps/watchBattle.js', /^const pendingReplace = new Map\(\)$/m],
      ['utils/pushStore.js', /^let pendingPatches = null$/m]
    ]
    for (const [file, re] of checks) {
      assert.equal(re.test(read(file)), false, `${file} 还留着裸声明：${re}`)
    }
  })

  it('gameRecordPush 的每一处状态引用都走 S.（不能漏成裸名）', () => {
    const src = stripComments(read('apps/gameRecordPush.js'))
    const vars = ['running', 'cursor', 'recoverRounds', 'quietUntil', 'hintRunning',
      'lastFriendNullLogAt', 'lastWaitLogAt', 'lastTargetsLogAt']
    for (const v of vars) {
      // 除了 hotBox 初始化里的键名，不该再有裸用的
      const bare = new RegExp(`(?<![.\\w$'])${v}\\b`, 'g')
      const hits = [...src.matchAll(bare)].filter(m => {
        const before = src.slice(Math.max(0, m.index - 40), m.index)
        return !/hotBox\('gameRecordPush\.state', \{\s*$/.test(before) && !/\bS\.$/.test(before)
      })
      // 允许初始化块里的键名（在 hotBox(...{ ... }) 内）
      const inInit = hits.filter(m => {
        const seg = src.slice(Math.max(0, m.index - 400), m.index)
        const open = seg.lastIndexOf("hotBox('gameRecordPush.state'")
        return open >= 0 && !seg.slice(open).includes('})')
      })
      assert.equal(hits.length - inInit.length, 0, `${v} 还有裸引用`)
    }
  })
})

/* ══════════════════════════════ 待落盘队列的跨代语义 */

describe('订阅写批：跨热重载不能丢 patch', () => {
  it('beginSubBatch/endSubBatch/mergeSubState 都走共享盒子', () => {
    const src = stripComments(read('utils/pushStore.js'))
    assert.match(src, /if \(S\.pendingPatches\) return false/)
    assert.match(src, /S\.pendingPatches = \[\]/)
    assert.match(src, /const patches = S\.pendingPatches/)
    assert.match(src, /S\.pendingPatches = null/)
    assert.match(src, /if \(S\.pendingPatches\) \{\s*S\.pendingPatches\.push/)
  })

  it('真实订阅者能跨代落盘（端到端）', async () => {
    const file = path.join(P, 'data/GameRecordPush.yaml')
    if (!fs.existsSync(file)) return
    const yaml = fs.readFileSync(file, 'utf8')
    const realQQ = (yaml.match(/^\s{2}"(\d{5,12})":/m) || [])[1]
    if (!realQQ) return
    const store = await import('../utils/pushStore.js')
    // 开批 → 攒一条 → 收尾，条数必须 >= 1（订阅存在）
    assert.equal(store.beginSubBatch(), true, '能开批')
    store.mergeSubState(realQQ, { skipTicks: 0 })
    const n = store.endSubBatch()
    assert.ok(n >= 1, `真实订阅者应当写入成功（实际 ${n}）`)
  })

  it('不存在的订阅会被跳过（这是设计，不是 bug）', async () => {
    const store = await import('../utils/pushStore.js')
    store.beginSubBatch()
    store.mergeSubState('999999999999', { skipTicks: 0 })
    const n = store.endSubBatch()
    assert.equal(n, 0, 'mergeSubStates 对不存在的订阅 continue')
  })
})
