/**
 * 账号池整池重写（锅巴保存）**不能静默清掉全局标记**。
 *
 * 背景（2026-09-20 实测踩到）：主人用 `#营地QQ全局登录` 扫进来的号，
 * 在锅巴里保存一次配置之后就不在全局名单里了 —— 于是 `#营地消息开` 再也管不着它
 * （那道筛就是 `isGlobalDefault`），而号本身还是好的（token / userSig 都在），
 * 排查时只能靠翻 `createdAt` 反推，极难对上账。
 *
 * 根因：`replaceAccountsFromGuoba` 里写的是 `Boolean(item.isGlobalDefault)`，
 * payload 少了这个字段（undefined）就被算成 false。
 *
 * 这个文件把两个方向都钉住：
 *   · payload 没带该字段 → **沿用池子里的现状**（不许清零）
 *   · payload 明确带 false → 照改（面板要保留「显式关掉某个全局号」的能力）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { cleanup, makeSandbox, run, PLUGIN_DIR } from './helpers/sandbox.mjs'

const TARGET_ACCOUNT = '1830818743'

/** 拿真实的 AuthPool.json 当输入，并把目标号摆成「刚扫码登录完」的样子 */
function makePool (extra = {}) {
  const real = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'data', 'AuthPool.json'), 'utf8'))
  const id = Object.keys(real.accounts).find(k => String(k) === TARGET_ACCOUNT) || Object.keys(real.accounts)[0]
  real.accounts[id] = { ...real.accounts[id], isGlobalDefault: true, ...extra }
  return { pool: real, id }
}

/** 沙箱里把 authStore 的池子文件指向测试副本（源码逐字复制，只改常量） */
function prepare (root) {
  const { pool, id } = makePool()
  const poolPath = path.join(root, 'pool-under-test.json')
  fs.writeFileSync(poolPath, JSON.stringify(pool, null, 2))

  const f = path.join(root, 'utils', 'authStore.js')
  const src = fs.readFileSync(path.join(PLUGIN_DIR, 'utils', 'authStore.js'), 'utf8')
    .replace(/const AUTH_POOL_FILE = .*/, `const AUTH_POOL_FILE = ${JSON.stringify(poolPath)}`)
    .replace(/const LEGACY_AUTH_POOL_FILE = .*/, `const LEGACY_AUTH_POOL_FILE = ${JSON.stringify(path.join(root, 'none.json'))}`)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, src)
  return { poolPath, id }
}

test('锅巴保存：payload 没带 isGlobalDefault 时，全局标记必须原样保留', () => {
  const root = makeSandbox()
  try {
    const { poolPath, id } = prepare(root)
    const out = run(root, `
import fs from 'node:fs'
globalThis.logger = { info(){}, warn(){}, error(){}, debug(){}, mark(){} }
const authStore = (await import('./utils/authStore.js')).default
const poolPath = ${JSON.stringify(poolPath)}
const id = ${JSON.stringify(id)}

const start = authStore.getPool().accounts[id].isGlobalDefault

// 模拟面板回传：这一条**没带** isGlobalDefault（字段没进表单 / 前端漏了）
const usable = authStore.getGuobaAccounts()
const payload = usable.map(a => a.userId === id
  ? { userId: a.userId, token: a.token, userSig: a.userSig, nickname: a.nickname }
  : a)
authStore.replaceAccountsFromGuoba(payload)

const after = JSON.parse(fs.readFileSync(poolPath, 'utf8')).accounts[id].isGlobalDefault
console.log(JSON.stringify({ start, after }))
`, { timeoutMs: 30000 })
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.start, true, '前置条件不对：目标号起始应为全局')
    assert.equal(r.after, true, '全局标记被静默清掉了（payload 没带该字段）')
  } finally {
    cleanup(root)
  }
})

test('锅巴保存：payload 明确带 false 时照改（保留「显式关掉」的能力）', () => {
  const root = makeSandbox()
  try {
    const { poolPath, id } = prepare(root)
    const out = run(root, `
import fs from 'node:fs'
globalThis.logger = { info(){}, warn(){}, error(){}, debug(){}, mark(){} }
const authStore = (await import('./utils/authStore.js')).default
const poolPath = ${JSON.stringify(poolPath)}
const id = ${JSON.stringify(id)}

authStore.replaceAccountsFromGuoba(
  authStore.getGuobaAccounts().map(a => a.userId === id ? { ...a, isGlobalDefault: false } : a)
)
console.log(JSON.stringify({ after: JSON.parse(fs.readFileSync(poolPath, 'utf8')).accounts[id].isGlobalDefault }))
`, { timeoutMs: 30000 })
    assert.ok(out.ok, out.stderr)
    assert.equal(JSON.parse(out.stdout).after, false, '面板显式关掉时没生效')
  } finally {
    cleanup(root)
  }
})

test('锅巴保存：快照原样回传时不改变任何全局标记', () => {
  const root = makeSandbox()
  try {
    const { poolPath } = prepare(root)
    const out = run(root, `
import fs from 'node:fs'
globalThis.logger = { info(){}, warn(){}, error(){}, debug(){}, mark(){} }
const authStore = (await import('./utils/authStore.js')).default
const poolPath = ${JSON.stringify(poolPath)}
const before = JSON.parse(fs.readFileSync(poolPath, 'utf8')).accounts
const snapshot = authStore.getGuobaAccounts()
authStore.replaceAccountsFromGuoba(snapshot)
const after = JSON.parse(fs.readFileSync(poolPath, 'utf8')).accounts
const diff = Object.keys(before).filter(k => before[k].isGlobalDefault !== after[k].isGlobalDefault)
console.log(JSON.stringify({ diff }))
`, { timeoutMs: 30000 })
    assert.ok(out.ok, out.stderr)
    assert.deepEqual(JSON.parse(out.stdout).diff, [])
  } finally {
    cleanup(root)
  }
})
