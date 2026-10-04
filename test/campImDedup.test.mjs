/**
 * 营地消息「服务端重连补拉重放」去重。
 *
 * 背景（2026-09-20 实测）：gok-im 的 ws 每隔十来秒断一次，重连后会把**离线消息重新补拉进队列**，
 * 同一条游戏消息被分配一个**新的服务端队列 id**、但游戏内容不变。插件原来只按服务端 id
 * 推进游标，于是这些重放的消息每条都被重新推给归属人 —— 用户看到「同一句话推了好几遍」。
 *
 * 这个文件钉住两层：
 *   · `messageKeys`：重放时同一条消息必须能在「游戏消息 id」或「内容指纹」上命中
 *   · `markSeenMessage` / `hasSeenMessage`：键落盘、扛重启
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, ensurePluginRoot, makeSandbox, run } from './helpers/sandbox.mjs'

const CASE = `
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PluginData } from '#components'
import * as store from './utils/campImStore.js'

globalThis.logger = { info(){}, warn(){}, error(){}, debug(){}, mark(){} }

const base = {
  selfUserId: '409420549', fromUserId: '1618788471', fromRoleName: '喵叽小汐',
  text: 'dsh测试1155', time: 1789893406, messageId: '757502449344'
}

// ① 服务端重连补拉：同一条消息、新的服务端 id → 去重键一个不差
const replayed = { ...base, id: 9999999999999 }
assert.deepEqual(store.messageKeys(replayed), store.messageKeys(base))
assert.ok(store.messageKeys(base).includes('409420549:757502449344'))
assert.ok(store.messageKeys(base).includes('409420549:1618788471:1789893406:dsh测试1155'))

// ② 万一服务端连 messageId 都换了，内容指纹仍能命中同一条
const midChanged = { ...base, messageId: '888888888888' }
const overlap = store.messageKeys(midChanged).filter(k => store.messageKeys(base).includes(k))
assert.ok(overlap.length >= 1, '内容指纹没兜住 messageId 变化')

// ③ 真·不同消息（游戏时间戳不同）不会被误判成同一条
const other = { ...base, messageId: '757502288316', time: 1789893355 }
const otherOverlap = store.messageKeys(other).filter(k => store.messageKeys(base).includes(k))
assert.deepEqual(otherOverlap, [])

// ④ 未见 → 记下 → 已见；换一条别的 messageId 不受影响
const keys = store.messageKeys(base)
assert.equal(keys.some(k => store.hasSeenMessage(k)), false)
for (const k of keys) store.markSeenMessage(k)
assert.equal(keys.some(k => store.hasSeenMessage(k)), true)
assert.equal(store.hasSeenMessage('409420549:757502288316'), false)

// ⑤ 落盘并扛得住重载（invalidate 后从 campIm.yaml 重读）
store.invalidate()
assert.equal(store.hasSeenMessage(keys[0]), true, '重启后去重键没读回来')
const raw = fs.readFileSync(path.join(PluginData, 'campIm.yaml'), 'utf8')
assert.ok(raw.includes('seen:'), 'seen 没落盘')
assert.ok(raw.includes('409420549:757502449344'), '去重键没落盘')
console.log(JSON.stringify({ ok: true }))
`

test('营地消息重放：换服务端 id / messageId 都判同一条，且去重键落盘扛重启', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, CASE, { timeoutMs: 30000 })
    assert.ok(out.ok, out.stderr)
    assert.deepEqual(JSON.parse(out.stdout), { ok: true })
  } finally {
    cleanup(root)
  }
})
