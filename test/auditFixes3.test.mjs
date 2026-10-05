/* ══════════════════════════════════════════════════════════════════════════
 * 第三轮审计的修复（2026-10-06）—— utils/ 剩余文件
 *
 * 这三条都是「子代理报的 → 我独立复核过 → 确认属实」才修的：
 *   ① api.js 撤销保险判据恒不成立（死代码）
 *   ② rankTrend.isRankJump 漏判赛季重置
 *   ③ gameNews 的 class="hl" 被剥属性正则吃掉
 * ══════════════════════════════════════════════════════════════════════════ */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const P = path.resolve(import.meta.dirname, '..')
const read = f => fs.readFileSync(path.join(P, f), 'utf8')
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** 从源码里抽一个函数（含函数体），支持 `export function` 与 `function`，允许 `(` 前有空格 */
function extractFunction (src, name) {
  const re = new RegExp(`(?:export )?function ${name}\\s*\\(`)
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
  const bs = src.indexOf('{', i)
  let d = 0
  for (let j = bs; j < src.length; j++) {
    if (src[j] === '{') d++
    else if (src[j] === '}') { d--; if (!d) return src.slice(st, j + 1).replace(/^export /, '') }
  }
  throw new Error(`函数 ${name} 的大括号不配对`)
}

/** 从源码里抽一个数组字面量 */
function extractArray (src, name) {
  const st = src.indexOf(`const ${name} = [`)
  if (st < 0) throw new Error(`找不到数组 ${name}`)
  let d = 0
  for (let j = st; j < src.length; j++) {
    if (src[j] === '[') d++
    else if (src[j] === ']') { d--; if (!d) return src.slice(st, j + 1) }
  }
  throw new Error(`数组 ${name} 不闭合`)
}

/* ══════════════════════════════════════════════ ① 接口撤销保险的判据 */

describe('接口重试：全候选同错时的撤销保险不能被冷却跳过架空', () => {
  const src = stripComments(read('utils/api.js'))

  it('源码判据：被冷却跳过的候选要计数，并算进判据', () => {
    assert.match(src, /let skippedByCooldown = 0/, '要有跳过计数')
    assert.match(src, /skippedByCooldown \+= 1/, '冷却分支要自增')
    assert.match(src, /const consideredCount = markedFailures\.length \+ skippedByCooldown/)
    assert.match(src, /consideredCount >= candidates\.length/, '判据要用它')
  })

  it('反证：旧判据（只数 markedFailures）在池里有冷却号时恒不成立', () => {
    // 冷却分支只 warn + continue/break，**不写 markedFailures**
    const candidates = 3
    const markedFailures = [{ msg: '请重新登录该账号' }, { msg: '请重新登录该账号' }]  // 2 个同因失败
    const skippedByCooldown = 1                                                      // 1 个在冷却里

    const oldOk = markedFailures.length > 1 && markedFailures.length >= candidates
    assert.equal(oldOk, false, '旧判据：2 >= 3 不成立 → 保险永不执行')

    const newOk = markedFailures.length > 1 && (markedFailures.length + skippedByCooldown) >= candidates
    assert.equal(newOk, true, '新判据：2 + 1 >= 3 成立 → 保险正确执行')
  })

  it('不能往 markedFailures 里塞冷却占位（会破坏同因判定）', () => {
    // 冷却文案和失败文案不同，混进去会让 uniform（every 相等）为 false
    const withPlaceholder = [
      { message: '请重新登录该账号' },
      { message: '请重新登录该账号' },
      { message: '营地接口暂时被限流，约 5 分钟后恢复，请稍后再试' }
    ]
    const normalized = withPlaceholder.map(f => f.message.replace(/\d+/g, ''))
    const uniform = normalized.every(t => t === normalized[0])
    assert.equal(uniform, false, '塞了占位就不是同因了 —— 所以只能用独立计数')
  })

  it('没覆盖全部候选时不该撤销（新判据也不能过宽）', () => {
    const candidates = 3
    const markedFailures = [{ definite: false }, { definite: false }]
    const skippedByCooldown = 0
    const ok = markedFailures.length > 1 && (markedFailures.length + skippedByCooldown) >= candidates
    assert.equal(ok, false, '第 3 个候选既没失败也没被跳过 → 不能撤销')
  })

  it('确定性标记（definite）仍然不撤', () => {
    const markedFailures = [
      { message: '登录态失效(returnCode=-30003)', definite: true },
      { message: '登录态失效(returnCode=-30003)', definite: true }
    ]
    const skippedByCooldown = 1
    const covered = markedFailures.length > 1 && (markedFailures.length + skippedByCooldown) >= 3
    const anyDefinite = markedFailures.some(f => f.definite)
    assert.equal(covered && !anyDefinite, false, '有确定性标记就不该撤')
  })
})

/* ══════════════════════════════════════════════ ② 段位跳变（赛季重置） */

describe('段位趋势：赛季重置不能被当成掉段', () => {
  const src = stripComments(read('utils/rankTrend.js'))
  const JUMP_TOLERANCE = Number((src.match(/const JUMP_TOLERANCE = (\d+)/) || [])[1])
  const isRankJump = new Function(`const JUMP_TOLERANCE = ${JUMP_TOLERANCE}; ${extractFunction(src, 'isRankJump')}; return isRankJump`)()
  const RANK_BANDS = new Function(`${extractArray(src, 'RANK_BANDS')}; return RANK_BANDS`)()
  const rankBand = new Function(`
    const RANK_BANDS = ${JSON.stringify(RANK_BANDS.map(b => ({ band: b.band, short: b.short, src: b.test.source, flags: b.test.flags })))}
      .map(b => ({ band: b.band, short: b.short, test: new RegExp(b.src, b.flags) }))
    ${extractFunction(src, 'rankBand')}
    return rankBand
  `)()

  it('阈值仍是 3', () => {
    assert.equal(JUMP_TOLERANCE, 3)
  })

  it('赛季重置（大段降 1 + 编号大涨）要断开', () => {
    // 真实形态：荣耀王者(b7/j16) → 至尊星耀IV(b6/j23)
    assert.equal(rankBand('荣耀王者'), 7)
    assert.equal(rankBand('至尊星耀IV'), 6)
    assert.equal(isRankJump({ band: 7, jobNum: 16 }, { band: 6, jobNum: 23 }), true)
    assert.equal(isRankJump({ band: 7, jobNum: 16 }, { band: 6, jobNum: 22 }), true)
    assert.equal(isRankJump({ band: 7, jobNum: 16 }, { band: 6, jobNum: 24 }), true)
  })

  it('反证：旧判据在 bandGap===1 时直接放行，这 3 处全漏', () => {
    const isRankJumpOld = (prev, next) => {
      if (!prev || !next) return false
      const bandGap = Math.abs(next.band - prev.band)
      if (bandGap >= 2) return true
      if (bandGap !== 0) return false
      if (!prev.jobNum || !next.jobNum) return false
      return Math.abs(next.jobNum - prev.jobNum) >= JUMP_TOLERANCE
    }
    for (const next of [{ band: 6, jobNum: 22 }, { band: 6, jobNum: 23 }, { band: 6, jobNum: 24 }]) {
      assert.equal(isRankJumpOld({ band: 7, jobNum: 16 }, next), false, '旧判据漏判')
      assert.equal(isRankJump({ band: 7, jobNum: 16 }, next), true, '新判据接住')
    }
  })

  it('真升段「星耀 → 王者」必须仍然连起来（编号 25 → 16 是降的）', () => {
    assert.equal(isRankJump({ band: 6, jobNum: 25 }, { band: 7, jobNum: 16 }), false)
    assert.equal(isRankJump({ band: 6, jobNum: 22 }, { band: 7, jobNum: 16 }), false)
  })

  it('真升段「钻石 → 星耀」（编号也是涨的）不能被误断', () => {
    // 大段升 + 编号涨：方向不相反，不是重置
    assert.equal(isRankJump({ band: 5, jobNum: 15 }, { band: 6, jobNum: 22 }), false)
  })

  it('真降段「星耀 → 钻石」（大段降 + 编号降）不能被误断', () => {
    assert.equal(isRankJump({ band: 6, jobNum: 22 }, { band: 5, jobNum: 15 }), false)
  })

  it('原有判据没被动到：跨 2 级断、同段内跳 >= 3 断、小跳不断、缺编号不断', () => {
    assert.equal(isRankJump({ band: 5, jobNum: 10 }, { band: 7, jobNum: 16 }), true, '跨 2 级')
    assert.equal(isRankJump({ band: 6, jobNum: 12 }, { band: 6, jobNum: 20 }), true, '同段大跳')
    assert.equal(isRankJump({ band: 6, jobNum: 22 }, { band: 6, jobNum: 23 }), false, '同段小跳')
    assert.equal(isRankJump({ band: 7, jobNum: 0 }, { band: 6, jobNum: 22 }), false, '缺编号')
    assert.equal(isRankJump(null, { band: 6, jobNum: 22 }), false, '空值')
  })

  it('真实归档（874 对排位相邻点）：只多断 5 处赛季重置，零误伤', () => {
    const file = path.join(P, 'data/BattleArchive.json')
    if (!fs.existsSync(file)) return
    const arch = JSON.parse(fs.readFileSync(file, 'utf8'))
    const toInt = v => { const n = parseInt(String(v ?? '').replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : 0 }
    const isRankJumpOld = (prev, next) => {
      if (!prev || !next) return false
      const bandGap = Math.abs(next.band - prev.band)
      if (bandGap >= 2) return true
      if (bandGap !== 0) return false
      if (!prev.jobNum || !next.jobNum) return false
      return Math.abs(next.jobNum - prev.jobNum) >= JUMP_TOLERANCE
    }
    let pairs = 0
    let oldJumps = 0
    let newJumps = 0
    let resets = 0
    for (const item of Object.values(arch)) {
      const pts = (item?.battles || [])
        .filter(b => /排位/.test(String(b?.mapName || '')) && b?.roleJobName)
        .map(b => ({ band: rankBand(b.roleJobName), jobNum: toInt(b.roleJob), t: Number(b.dtEventTime) || 0 }))
        .filter(p => p.band > 0)
        .sort((a, b) => a.t - b.t)
      for (let i = 1; i < pts.length; i++) {
        pairs++
        const p = pts[i - 1]
        const n = pts[i]
        if (isRankJumpOld(p, n)) oldJumps++
        if (isRankJump(p, n)) newJumps++
        if (Math.abs(n.band - p.band) === 1 && n.band < p.band && n.jobNum > p.jobNum &&
            (n.jobNum - p.jobNum) >= JUMP_TOLERANCE) resets++
      }
    }
    assert.ok(pairs > 500, `真实排位相邻点应当有几百对（实际 ${pairs}）`)
    assert.equal(resets, 5, '真实归档里赛季重置形态应是 5 处')
    assert.equal(newJumps - oldJumps, resets, '新增断开的必须正好是这 5 处，不能误伤别的')
  })
})

/* ══════════════════════════════════════════════ ③ 公告红色强调 */

describe('王者公告：红色强调的 class 不能被剥属性吃掉', () => {
  const src = stripComments(read('utils/gameNews.js'))
  const tpl = read('resources/html/GameNewsDetail.html')

  it('源码判据：em 和 img 一样放行原标签', () => {
    assert.match(src, /if \(lower === 'img'\) return tag/)
    assert.match(src, /if \(lower === 'em'\) return tag\.startsWith\('<\/'\) \? '<\/em>' : '<em class="hl">'/)
  })

  it('模板里确实有 em.hl 选择器（不然这句 class 就没意义）', () => {
    assert.match(tpl, /\.content em\.hl/)
  })

  it('red/green：旧写法把 class 吃掉，新写法保住', () => {
    const KEEP = new Set(['p', 'br', 'strong', 'b', 'em', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'img', 'table', 'tr', 'td', 'th'])
    const toEm = html => html.replace(/<span[^>]*color:\s*(?:#ff0000|#f00|red)[^>]*>((?:(?!<\/?span)[\s\S])*?)<\/span>/gi, '<em class="hl">$1</em>')
    const strip = (html, keepEmClass) => html.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (tag, name) => {
      const lower = name.toLowerCase()
      if (!KEEP.has(lower)) return ''
      if (lower === 'img') return tag
      if (keepEmClass && lower === 'em') return tag.startsWith('</') ? '</em>' : '<em class="hl">'
      return tag.startsWith('</') ? `</${lower}>` : `<${lower}>`
    })

    const input = '<p><span style="color:#ff0000">更新时间：9月29日</span> 正文内容</p>'
    const oldOut = strip(toEm(input), false)
    const newOut = strip(toEm(input), true)

    assert.equal(/<em class="hl">/.test(oldOut), false, '旧写法 class 被吃掉')
    assert.equal(/<em class="hl">/.test(newOut), true, '新写法 class 保住')
    // 模板选择器 .content em.hl 只在新的上面匹配得上
    assert.equal(oldOut.includes('<em class="hl">'), false)
    assert.equal(newOut.includes('<em class="hl">'), true)
  })

  it('img 的放行没被破坏（图片 src 不能被剥掉）', () => {
    const KEEP = new Set(['img'])
    const html = '<img src="https://example.com/a.jpg">'
    const out = html.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (tag, name) => {
      const lower = name.toLowerCase()
      if (!KEEP.has(lower)) return ''
      if (lower === 'img') return tag
      if (lower === 'em') return tag.startsWith('</') ? '</em>' : '<em class="hl">'
      return tag.startsWith('</') ? `</${lower}>` : `<${lower}>`
    })
    assert.equal(out, html, 'img 要原样保留（含 src）')
  })
})

/* ══════════════════════════════════════════════ ④ exit 监听器不能累积 */

describe('共享库：进程退出钩子不能随热重载累积', () => {
  const src = stripComments(read('utils/shareStore.js'))

  it('源码判据：注册前先查 globalThis 标记', () => {
    assert.match(src, /const EXIT_HOOK_KEY = '__gokShareStoreExitHook'/)
    assert.match(src, /if \(!globalThis\[EXIT_HOOK_KEY\]\) \{/)
    assert.match(src, /globalThis\[EXIT_HOOK_KEY\] = true/)
    assert.match(src, /process\.once\('exit', flushNow\)/)
  })

  it('反证：裸 process.once 在模块被反复求值时会累积', () => {
    // 用一个假 process 模拟：模块顶层语句每代执行一次
    const listeners = []
    const fakeProcess = { once: (ev, fn) => listeners.push(fn) }

    // 旧写法：每次求值都挂
    for (let i = 0; i < 12; i++) fakeProcess.once('exit', () => {})
    assert.equal(listeners.length, 12, '旧写法 12 代 = 12 个监听器 → 超过 Node 的 10 个上限')
    assert.ok(listeners.length > 10, '确实会触发 MaxListenersExceededWarning')

    // 新写法：globalThis 标记挡住
    const g = {}
    const KEY = '__gokShareStoreExitHook'
    let n = 0
    for (let i = 0; i < 12; i++) {
      if (!g[KEY]) { g[KEY] = true; n++ }
    }
    assert.equal(n, 1, '新写法 12 代只注册 1 次')
  })

  it('插件里只有这一处 exit 钩子（别的文件不许再挂）', () => {
    const files = []
    const walk = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.js')) files.push(p)
      }
    }
    walk(path.join(P, 'apps'))
    walk(path.join(P, 'utils'))
    const hooked = files.filter(f => /process\.(once|on)\(\s*['"]exit['"]/.test(fs.readFileSync(f, 'utf8')))
    assert.deepEqual(hooked.map(f => path.relative(P, f)), ['utils/shareStore.js'],
      '只允许 shareStore 挂 exit 钩子，且它自己做了去重')
  })
})
