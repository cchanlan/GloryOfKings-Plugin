/**
 * 「隐藏主页」标注的**有效期**（`utils/hiddenProfiles.js`）。
 *
 * 钉住的是一个 2026-10-06 修的真 bug：**标注永远不解除**。
 *
 * 原实现把过期判定只放在「构建缓存」那一次（`if (hiddenUntil <= now) continue`），
 * 缓存一旦建好就再没人碰过它 —— 于是进程只要不重启，24 小时到期后
 * `isProfileHidden` 照样返回 true，标注等于**永久**。
 *
 * 云崽是长跑进程（实测连续在线 100+ 分钟且不会自动重启），所以这在真实环境里
 * **必定触发**，不是理论边界。用户侧表现：「清了又回来」「明明是临时的却一直跳过」。
 *
 * 顺带钉住三件容易回归的事：
 *   · 剔除必须**精确** —— 只删到期的，没到期的一条都不许动
 *   · 过期项不该被 mark/clear 顺手写回盘上（否则盘上越攒越多）
 *   · 短路优化要真的生效 —— `isProfileHidden` 在「扫几十个账号」的循环里被反复调用，
 *     不能退化成每次全量遍历
 *
 * 用 test/helpers/sandbox.mjs 的沙箱：`#components` 被换成假模块，
 * PluginData 指向临时目录，**绝不碰插件 data/ 里的真标注**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeSandbox, run, cleanup } from './helpers/sandbox.mjs'

/** 跑一段沙箱脚本，返回 stdout */
function inSandbox (source) {
  const root = makeSandbox()
  try {
    const r = run(root, source)
    assert.equal(r.ok, true, `沙箱脚本失败:\n${r.stderr}\n${r.stdout}`)
    return r.stdout
  } finally {
    cleanup(root)
  }
}

/**
 * 沙箱里通用的开头：定位数据文件 + 读写助手。
 *
 * 路径从 case-root.txt 读（sandbox.run 会写好），别在 JS 字符串里拼绝对路径 ——
 * Windows 的反斜杠转义太容易出错。
 */
const PRELUDE = `
import fs from 'node:fs'
import path from 'node:path'

const ROOT = fs.readFileSync('./case-root.txt', 'utf8').trim()
const FILE = path.join(ROOT, 'PluginRoot', 'data', 'HiddenProfiles.json')
fs.mkdirSync(path.dirname(FILE), { recursive: true })

const write = entries => fs.writeFileSync(FILE, JSON.stringify({ updatedAt: Date.now(), entries }))
const read = () => (JSON.parse(fs.readFileSync(FILE, 'utf8')).entries) || {}
const sleep = ms => new Promise(r => setTimeout(r, ms))
`

test('标注到期后必须失效 —— 进程不重启也要失效（原 bug 的核心）', () => {
  const out = inSandbox(`${PRELUDE}
const soon = Date.now() + 1200
write({
  111: { hiddenAt: Date.now(), hiddenUntil: soon, nickname: 'A' },
  222: { hiddenAt: Date.now(), hiddenUntil: soon, nickname: 'B' }
})

// 先写好文件再 import：模块首次读盘才会把短 TTL 读进缓存
const mod = await import('./utils/hiddenProfiles.js')

console.log('刚读盘: ' + [111, 222].map(id => mod.isProfileHidden(id)).join(','))
await sleep(1500)
console.log('到期后: ' + [111, 222].map(id => mod.isProfileHidden(id)).join(','))
console.log('名单条数: ' + mod.listHiddenProfiles().length)
`)

  assert.match(out, /刚读盘: true,true/, '未到期时应认到')
  assert.match(out, /到期后: false,false/, '到期后必须失效（修复前这里恒为 true）')
  assert.match(out, /名单条数: 0/, '到期项不该还留在名单里')
})

test('剔除必须精确：只删到期的，没到期的一条都不许动', () => {
  const out = inSandbox(`${PRELUDE}
const now = Date.now()
write({
  // A 已过期、B 还有很久、C 快到期
  111: { hiddenAt: now - 90000, hiddenUntil: now - 1000, nickname: 'A-已过期' },
  222: { hiddenAt: now, hiddenUntil: now + 3600000, nickname: 'B-很久' },
  333: { hiddenAt: now, hiddenUntil: now + 1200, nickname: 'C-快到期' }
})

const mod = await import('./utils/hiddenProfiles.js')

console.log('首次读盘 A/B/C: ' + [111, 222, 333].map(id => mod.isProfileHidden(id)).join(','))

await sleep(1500)
console.log('C 到期后 A/B/C: ' + [111, 222, 333].map(id => mod.isProfileHidden(id)).join(','))
console.log('剩余名单: ' + mod.listHiddenProfiles().map(x => x.campId).join(','))
`)

  // 首次读盘就该把已经过期的 A 挡在外面
  assert.match(out, /首次读盘 A\/B\/C: false,true,true/)
  // C 到期只影响 C，B 必须毫发无伤
  assert.match(out, /C 到期后 A\/B\/C: false,true,false/)
  assert.match(out, /剩余名单: 222/)
})

test('过期项不该被 mark / clear 顺手写回盘上', () => {
  const out = inSandbox(`${PRELUDE}
const now = Date.now()
write({
  111: { hiddenAt: now - 90000, hiddenUntil: now - 1000, nickname: 'A-已过期' },
  222: { hiddenAt: now, hiddenUntil: now + 3600000, nickname: 'B-有效' }
})

const mod = await import('./utils/hiddenProfiles.js')
mod.isProfileHidden(111)   // 触发一次读盘（缓存建立）

mod.markProfileHidden('444', 'D-新命中')
const afterMark = Object.keys(read()).sort().join(',')
console.log('mark 后盘上: ' + afterMark)

const cleared = mod.clearAllHiddenProfiles()
console.log('clearAll 清掉: ' + cleared)
console.log('clearAll 后盘上: ' + Object.keys(read()).join(',') + '(空)')

mod.markProfileHidden('555', 'E-重标')
console.log('重标后能查到: ' + mod.isProfileHidden(555))
`)

  // 过期的 111 不该被写回；有效的 222 和新加的 444 要在
  assert.match(out, /mark 后盘上: 222,444/)
  // clearAll 只该数到「缓存里还活着的」条数
  assert.match(out, /clearAll 清掉: 2/)
  assert.match(out, /clearAll 后盘上: \(空\)/)
  assert.match(out, /重标后能查到: true/)
})

test('短路优化真的生效：空集合上的查询不退化成全量遍历', () => {
  const out = inSandbox(`${PRELUDE}
write({ 111: { hiddenAt: Date.now(), hiddenUntil: Date.now() + 3600000, nickname: 'A' } })

const mod = await import('./utils/hiddenProfiles.js')

const t0 = Date.now()
for (let i = 0; i < 20000; i++) mod.isProfileHidden('111')
const hitMs = Date.now() - t0

mod.clearAllHiddenProfiles()

const t1 = Date.now()
for (let i = 0; i < 20000; i++) mod.isProfileHidden('111')
const emptyMs = Date.now() - t1

console.log('hit=' + hitMs + ' empty=' + emptyMs)
`)

  const m = out.match(/hit=(\d+) empty=(\d+)/)
  assert.ok(m, `没拿到耗时: ${out}`)
  const [, hitMs, emptyMs] = m.map(Number)
  // 空集合时 cacheNextExpiry 是 Infinity，短路恒成立 → 不该比「有命中」更慢
  assert.ok(emptyMs <= hitMs + 50, `空集合查询(${emptyMs}ms) 明显慢于命中查询(${hitMs}ms)，短路可能失效`)
})

test('非法输入不报错、也不误判', () => {
  const out = inSandbox(`${PRELUDE}
write({ 555: { hiddenAt: Date.now(), hiddenUntil: Date.now() + 3600000, nickname: 'E' } })

const mod = await import('./utils/hiddenProfiles.js')

console.log('空串: ' + mod.isProfileHidden(''))
console.log('null: ' + mod.isProfileHidden(null))
console.log('undefined: ' + mod.isProfileHidden(undefined))
console.log('非数字: ' + mod.isProfileHidden('abc'))
console.log('带空格数字: ' + mod.isProfileHidden(' 555 '))
console.log('mark 非法ID返回: ' + mod.markProfileHidden('abc'))
console.log('clear 非法ID返回: ' + mod.clearHiddenProfile('abc'))
`)

  assert.match(out, /空串: false/)
  assert.match(out, /null: false/)
  assert.match(out, /undefined: false/)
  assert.match(out, /非数字: false/)
  // 归一化之后要能认出来
  assert.match(out, /带空格数字: true/)
  assert.match(out, /mark 非法ID返回: 0/)
  assert.match(out, /clear 非法ID返回: false/)
})
