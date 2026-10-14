/**
 * 「选号闸门」的单元测试（2026-10-14 加，2026-10-15 语义修正后重写）。
 *
 * 营地有「自我豁免」——被查者本人用他自己的号查自己不受战绩隐私限制
 * （主号实测见记忆 gok-camp-privacy-self-exemption）。但**只有本人能享用**：
 * 2026-10-15 主人报了个漏洞 —— 原先只看「被查号在不在池里」，于是 A 艾特 B 查战绩时
 * 机器人拿 **B 自己的 token** 去查，B 关了隐私 A 也照样看得到。
 *
 * 现在 `CampAuthSession#candidates` 分三道：
 *   ① 发起人就是被查号的号主 → 提到队首（吃自我豁免）
 *   ② 发起人不是号主          → 把被查号自己的登录态**从候选里摘掉**
 *   ③ 没传发起人（内部工具）   → 维持旧行为（提队首）
 *
 * 观测手段：`candidates()` 每次都会 logger.debug 打「本次请求鉴权候选列表」，
 * 测试里把 logger.debug 换成捕获器，从日志里读实际顺序 —— 走的是**真实源码路径**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSandbox, run, ensurePluginRoot } from './helpers/sandbox.mjs'

/**
 * 沙箱脚本头部：造假池 + 捕获日志。
 *
 * ⚠️ 账号**必须带 `ownerBotUserId`** —— 判据是「发起人名下有没有这个营地号」，
 *    也就是 `authStore.listGlobalAccountsByOwner(requester)`，
 *    而它读的正是这个字段。不带的话名下恒为空，永远走分支②，测不出分支①。
 */
const prelude = (accounts) => `
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const root = fs.readFileSync('case-root.txt', 'utf8')
const plugin = path.join(root, 'plugins', 'GloryOfKings-Plugin')

const pool = { accounts: ${JSON.stringify(accounts)} }
fs.mkdirSync(path.join(root, 'PluginRoot', 'data'), { recursive: true })
fs.writeFileSync(path.join(root, 'PluginRoot', 'data', 'AuthPool.json'), JSON.stringify(pool))

/** 捕获「本次请求鉴权候选列表」那一发的顺序 */
let lastOrder = []
let lastThrow = ''
globalThis.logger = {
  debug: (msg, ctx) => {
    if (typeof msg === 'string' && msg.includes('鉴权候选列表') && Array.isArray(ctx?.candidates)) {
      lastOrder = ctx.candidates.map(c => String(c.userId))
    }
  },
  info: () => {}, warn: () => {}, error: () => {}, mark: () => {}
}

const { default: api } = await import(pathToFileURL(path.join(plugin, 'utils', 'api.js')).href)

/**
 * 用 getMoreBattleList 触发一次 candidates()。
 * ⚠️ 别用 campRequest —— 它内部把 requesterBotUserId **写死成空串**
 *    （那是有意的：它的调用点都要么锁账号、要么用别人的号当他见观察者），
 *    用它测不出「别人来查」这条路径。
 * fetch 是假的（沙箱里没网），请求必然失败，但 candidates() 在发请求**之前**
 * 就已经跑完并打过日志了。
 */
async function orderFor (target, requester = '') {
  lastThrow = ''
  try { await api.getMoreBattleList(target, requester, { option: 0, lastTime: 0 }) } catch (e) { lastThrow = String(e?.message || e) }
  await new Promise(r => setTimeout(r, 30))
  return { order: lastOrder, thrown: lastThrow }
}
`

const ACC = (id, owner, priority) => ({
  userId: id, token: `tk${id}`, userKey: `uk${id}`,
  isGlobalDefault: true, priority, ownerBotUserId: owner
})
const THREE = {
  111: ACC('111', '9001', 10),
  222: ACC('222', '9002', 20),
  333: ACC('333', '9003', 30)
}

test('① 本人查自己的号 → 排到队首（吃自我豁免）', () => {
  const root = makeSandbox()
  ensurePluginRoot(root)
  const r = run(root, prelude(THREE) + `
const self = await orderFor('222', '9002')
const self2 = await orderFor('333', '9003')
console.log(JSON.stringify({ self, self2 }))
`)
  assert.equal(r.ok, true, `沙箱脚本失败: ${r.stderr}`)
  const out = JSON.parse(r.stdout.trim().split('\n').pop())

  assert.equal(out.self.order?.[0], '222', `本人查 222 应排第一，实际: ${out.self.order}`)
  assert.equal(out.self.order?.length, 3, '候选总数不变（其余号留作回退）')
  assert.equal(out.self2.order?.[0], '333', `本人查 333 应排第一，实际: ${out.self2.order}`)
})

test('② 别人来查 → 被查号的登录态被摘掉（不能借它绕过隐私）', () => {
  const root = makeSandbox()
  ensurePluginRoot(root)
  const r = run(root, prelude(THREE) + `
const other = await orderFor('222', '9999')
const outsider = await orderFor('999', '9999')
console.log(JSON.stringify({ other, outsider }))
`)
  assert.equal(r.ok, true, `沙箱脚本失败: ${r.stderr}`)
  const out = JSON.parse(r.stdout.trim().split('\n').pop())

  // ⚠️ 光「不提前」不够：池里的号是轮转的，留着它迟早会轮到 —— 必须真被摘掉
  assert.ok(!out.other.order?.includes('222'),
    `别人查 222 时它不该出现在候选里，实际: ${out.other.order}`)
  assert.equal(out.other.order?.length, 2, '只摘掉被查的那一个，其余保留')
  // 查池外的号：谁都不摘，三个号都留着
  assert.equal(out.outsider.order?.length, 3, `查池外号不该摘任何账号，实际: ${out.outsider.order}`)
})

test('③ 没传发起人（内部工具）→ 维持改动前的行为', () => {
  const root = makeSandbox()
  ensurePluginRoot(root)
  const r = run(root, prelude(THREE) + `
const noRequester = await orderFor('222')
console.log(JSON.stringify({ noRequester }))
`)
  assert.equal(r.ok, true, `沙箱脚本失败: ${r.stderr}`)
  const out = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.equal(out.noRequester.order?.[0], '222',
    `取角色名这类内部调用应照旧提队首，实际: ${out.noRequester.order}`)
})

test('② 池里只剩被查号 → 保持原样不摘（单号池没有「别人查」这回事）', () => {
  const root = makeSandbox()
  ensurePluginRoot(root)
  const r = run(root, prelude({ 222: ACC('222', '9002', 20) }) + `
const sole = await orderFor('222', '9999')
console.log(JSON.stringify({ sole }))
`)
  assert.equal(r.ok, true, `沙箱脚本失败: ${r.stderr}`)
  const out = JSON.parse(r.stdout.trim().split('\n').pop())

  // ⚠️ 本机只登了被查者这一个号时**不能摘**（摘了就空池、正常功能被掐死）。
  //    那种场景整个机器人只有他一个登录态，能查到什么都是他自己的号在查，
  //    「别人查」这个前提根本不成立（2026-10-15 主人指出）。
  //
  // ⚠️ 沙箱里 fetch 是假的，请求**必然**报「测试里不该发真请求」—— 那正说明它
  //    **没被隐私闸门拦住、照常往下发**了。所以这里只断言「没回隐私拒绝」，
  //    不能断言「什么都没抛」（那会把沙箱自己的报错也算进去）。
  assert.doesNotMatch(out.sole.thrown || '', /隐私|查不到/,
    `不该被隐私闸门拦下，实际: ${out.sole.thrown}`)
  assert.equal(out.sole.order?.length, 1, `只有一个号时要保留它，实际: ${out.sole.order}`)
  assert.equal(out.sole.order?.[0], '222', '不摘 → 照旧用它查')
})

test('防呆：发起人是字面量 "undefined"（假 e 壳子）时按「没传」处理，不能误摘', () => {
  const root = makeSandbox()
  ensurePluginRoot(root)
  const r = run(root, prelude(THREE) + `
// 定时任务拼的假 e 没有 user_id，调用方一个 String(e.user_id) 就会造出这俩字面量
const undef = await orderFor('222', 'undefined')
const nul = await orderFor('222', 'null')
console.log(JSON.stringify({ undef, nul }))
`)
  assert.equal(r.ok, true, `沙箱脚本失败: ${r.stderr}`)
  const out = JSON.parse(r.stdout.trim().split('\n').pop())

  // 关键：这两个值**绝不能**被当成「别人来查」而摘号（那会误伤定时链路）
  assert.equal(out.undef.order?.length, 3,
    `"undefined" 不该摘任何账号，实际候选: ${out.undef.order}`)
  assert.equal(out.undef.order?.[0], '222', '按「没传发起人」处理 → 照旧提队首')
  assert.equal(out.nul.order?.length, 3, `"null" 不该摘任何账号，实际候选: ${out.nul.order}`)
})

test('轮转没被破坏：查池外号时连续请求仍会换队首', () => {
  const root = makeSandbox()
  ensurePluginRoot(root)
  const r = run(root, prelude(THREE) + `
const seq = []
for (let i = 0; i < 4; i++) seq.push((await orderFor('999', '9999')).order)
console.log(JSON.stringify({ seq }))
`)
  assert.equal(r.ok, true, `沙箱脚本失败: ${r.stderr}`)
  const { seq } = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.equal(seq.length, 4)
  const firsts = seq.map(s => s[0])
  assert.ok(new Set(firsts).size >= 2, `轮转应仍在生效（4 次的队首: ${firsts.join(',')}）`)
})
