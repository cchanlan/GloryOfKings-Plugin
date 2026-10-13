/**
 * 「自我优先」选号逻辑的单元测试（2026-10-14 加）。
 *
 * 背景：营地有「自我豁免」——被查者本人用他自己的号查自己不受战绩隐私限制
 * （主号实测见记忆 gok-camp-privacy-self-exemption）。
 * `CampAuthSession#candidates` 把**池内的目标号**提到候选队首，其余账号照旧轮转。
 *
 * 观测手段：`candidates()` 每次都会 logger.debug 打「本次请求鉴权候选列表」，
 * 测试里把 logger.debug 换成捕获器，从日志里读实际顺序 —— 走的是**真实源码路径**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSandbox, run, ensurePluginRoot } from './helpers/sandbox.mjs'

/** 沙箱脚本头部：造假池 + 捕获日志 */
const PRELUDE = `
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const root = fs.readFileSync('case-root.txt', 'utf8')
const plugin = path.join(root, 'plugins', 'GloryOfKings-Plugin')

const pool = { accounts: {
  '111': { userId: '111', token: 'tk1', userKey: 'uk1', isGlobalDefault: true, priority: 10 },
  '222': { userId: '222', token: 'tk2', userKey: 'uk2', isGlobalDefault: true, priority: 20 },
  '333': { userId: '333', token: 'tk3', userKey: 'uk3', isGlobalDefault: true, priority: 30 }
} }
fs.mkdirSync(path.join(root, 'PluginRoot', 'data'), { recursive: true })
fs.writeFileSync(path.join(root, 'PluginRoot', 'data', 'AuthPool.json'), JSON.stringify(pool))

/** 捕获「本次请求鉴权候选列表」那一发的顺序 */
let lastOrder = []
globalThis.logger = {
  debug: (msg, ctx) => {
    if (typeof msg === 'string' && msg.includes('鉴权候选列表') && Array.isArray(ctx?.candidates)) {
      lastOrder = ctx.candidates.map(c => String(c.userId))
    }
  },
  info: () => {}, warn: () => {}, error: () => {}, mark: () => {}
}

const { default: api } = await import(pathToFileURL(path.join(plugin, 'utils', 'api.js')).href)

/** 用 campRequest 触发一次 candidates()：mock 掉 fetch 不让真发请求 */
async function orderFor (target) {
  try { await api.campRequest('/game/morebattlelist', {}, target) } catch {}
  await new Promise(r => setTimeout(r, 30))
  return lastOrder
}
`

test('自我优先：被查者本人在池里 → 排到队首', () => {
  const root = makeSandbox()
  ensurePluginRoot(root)
  const r = run(root, PRELUDE + `
try {
  const self = await orderFor('222')
  const self2 = await orderFor('333')
  const notInPool = await orderFor('999')
  const noTarget = await orderFor('')
  console.log(JSON.stringify({ self, self2, notInPool, noTarget }))
} catch (e) { console.log(JSON.stringify({ error: e.message })) }
`)
  assert.equal(r.ok, true, `沙箱脚本失败: ${r.stderr}`)
  const out = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.ok(!out.error, `沙箱内报错: ${out.error}`)

  assert.equal(out.self?.[0], '222', `目标 222 应排第一，实际: ${out.self}`)
  assert.equal(out.self?.length, 3, '候选总数不变（其余号保留作回退）')
  assert.equal(out.self2?.[0], '333', `目标 333 应排第一，实际: ${out.self2}`)
  // 不在池里 / 无目标：顺序与改动前一致
  assert.equal(out.notInPool?.length, 3)
  assert.ok(!out.notInPool?.includes(undefined), '不该出现 undefined')
})

test('自我优先不破坏轮转：目标不在池里时连续请求仍会换队首', () => {
  const root = makeSandbox()
  ensurePluginRoot(root)
  const r = run(root, PRELUDE + `
const seq = []
for (let i = 0; i < 4; i++) seq.push(await orderFor('999'))
console.log(JSON.stringify({ seq }))
`)
  assert.equal(r.ok, true, `沙箱脚本失败: ${r.stderr}`)
  const { seq } = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.equal(seq.length, 4)
  const firsts = seq.map(s => s[0])
  assert.ok(new Set(firsts).size >= 2, `轮转应仍在生效（4 次的队首: ${firsts.join(',')}）`)
})
