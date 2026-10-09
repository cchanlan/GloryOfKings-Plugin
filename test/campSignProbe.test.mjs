/**
 * 签到账号编排层：**没绑角色的号怎么判** + 静默跳过的口径。
 *
 * ## 这轮（2026-10-10）新增的核心判据
 *
 * 主人要求「没有角色的直接静默处理，不需要渲染也不需要告知，直接跳过」。
 * 而「没角色」这件事**只有 `/game/rolelist` 能看出来** —— 实测对照：
 *
 * | 号 | `20001.roles` | `signinfo.weekSignMap` | `seqSignDays` |
 * |---|---|---|---|
 * | 没绑角色 | `[]` ← 只有这里能看出来 | `'0000000'` | `0` |
 * | 有角色但没签过 | 有 | `'0000000'` | `0` |
 *
 * 两者在 `signinfo` 上**一模一样**。所以这里钉住两件事：
 *   ① `probeAccount` 对没角色的号必须给出 `noRole: true`
 *   ② **不能**拿 `weekSignMap === '0000000'` 当判据（否则新号被永久跳过）
 *
 * 用桩替掉 `api.js`（真跑会打营地接口），所以是脱机测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------- 桩：替换 api.js
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gok-probe-'))
const PLUGIN_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

/** 每个用例前把要返回的响应塞进来 */
const state = {
  roleList: null,
  roleListThrows: null,
  signInfo: null,
  signInfoThrows: null,
  signResult: null,
  signCalls: 0
}

fs.writeFileSync(path.join(tmp, 'api-stub.mjs'), `
const s = globalThis.__probeState
export default {
  async getRoleList () {
    if (s.roleListThrows) throw s.roleListThrows
    return s.roleList
  },
  async getCampSignInfo () {
    if (s.signInfoThrows) throw s.signInfoThrows
    return s.signInfo
  },
  async doCampSign () {
    s.signCalls++
    return s.signResult
  },
  formatUserFacingError (e) { return '出错了：' + (e?.message || e) }
}
`)
globalThis.__probeState = state

fs.writeFileSync(path.join(tmp, 'loader.mjs'), `
export async function resolve (spec, ctx, next) {
  if (spec.endsWith('/api.js') || spec === './api.js') {
    return { url: ${JSON.stringify(pathToFileURL(path.join(tmp, 'api-stub.mjs')).href)}, shortCircuit: true }
  }
  return next(spec, ctx)
}
`)
register(pathToFileURL(path.join(tmp, 'loader.mjs')).href, pathToFileURL(tmp + '/'))

const { probeAccount, signOneAccount } = await import(
  pathToFileURL(path.join(PLUGIN_DIR, 'utils', 'campSignTask.js')).href
)

// ---------------------------------------------------------------- 桩数据（真实形状）

/** 没绑王者角色：20001 的 roles 是空数组（2026-10-10 真机原文） */
const ROLELIST_NO_ROLE = {
  userId: '1476924610',
  gameList: [
    { gameId: 30005, roles: [] },
    { gameId: 30001, roles: [] },
    { gameId: 20001, roles: [] }
  ]
}

/** 有王者角色（真机原文，2 个角色取第一个） */
const ROLELIST_HAS_ROLE = {
  userId: '1536597962',
  gameList: [
    { gameId: 30001, roles: [] },
    { gameId: 20001, roles: [
      { roleId: '4419152782', roleName: '昨日花昨日开', areaId: '1', serverId: '1' },
      { roleId: '4419152783', roleName: '另一个角色', areaId: '2', serverId: '2' }
    ] }
  ]
}

/** 没绑角色的号打 signinfo 的真实返回：全 0，看着像「今天还没签」 */
const SIGNINFO_EMPTY = {
  returnCode: 0,
  data: { weekSignMap: '0000000', seqSignDays: 0, userTotalSign: 0, weekList: [], totalList: [] }
}

/** 有角色、今天已签（真机原文） */
const SIGNINFO_SIGNED = {
  returnCode: 0,
  data: { weekSignMap: '0000010', seqSignDays: 1, userTotalSign: 1 }
}

function reset () {
  state.roleList = null
  state.roleListThrows = null
  state.signInfo = null
  state.signInfoThrows = null
  state.signResult = null
  state.signCalls = 0
}

/* ============================================================ probeAccount */

test('probeAccount：没绑王者角色 → noRole=true，且**不发**签到请求', async () => {
  reset()
  state.roleList = ROLELIST_NO_ROLE
  state.signInfo = SIGNINFO_EMPTY

  const view = await probeAccount('1476924610', { name: 'A' })
  assert.equal(view.noRole, true, '必须标出 noRole，调用方靠它静默跳过')
  assert.equal(view.campId, '1476924610')
  assert.equal(view.name, 'A')
})

test('probeAccount：没角色的号**根本不该去查 signinfo**（省一次请求）', async () => {
  reset()
  state.roleList = ROLELIST_NO_ROLE
  // signinfo 故意设成会抛 —— 如果代码去查了，这个用例就会失败
  state.signInfoThrows = new Error('不该查 signinfo')

  const view = await probeAccount('1474610')
  assert.equal(view.noRole, true)
  assert.equal(view.failReason.includes('没绑定王者角色'), true)
})

test('⭐ probeAccount：有角色但**从没签过**的号 ≠ 没角色（这是本轮最容易写错的判据）', async () => {
  reset()
  state.roleList = ROLELIST_HAS_ROLE
  // ⚠️ 关键：新号的 signinfo 跟没角色的号**长得一模一样**
  state.signInfo = SIGNINFO_EMPTY

  const view = await probeAccount('1536597962')
  assert.notEqual(view.noRole, true, '有角色的新号绝不能被当成没角色 —— 否则永远等不到它开始签')
  assert.equal(view.signedToday, false, '它是「今天还没签」，不是「签不了」')
  assert.equal(view.stateText, '今天还没签')
  assert.equal(view.roleName, '昨日花昨日开', '角色名要带出来（图上要显示）')
})

test('probeAccount：已签的号 → already=true + signedToday=true', async () => {
  reset()
  state.roleList = ROLELIST_HAS_ROLE
  state.signInfo = SIGNINFO_SIGNED

  const view = await probeAccount('1536597962')
  assert.equal(view.already, true)
  assert.equal(view.signedToday, true)
  assert.equal(view.stateText, '今天已签')
  assert.equal(view.stateClass, 'done')
})

test('probeAccount：weekSignMap 判不了时 → 既不算已签也不算未签', async () => {
  reset()
  state.roleList = ROLELIST_HAS_ROLE
  state.signInfo = { returnCode: 0, data: { weekSignMap: '坏数据' } }

  const view = await probeAccount('1536597962')
  assert.equal(view.signedToday, null)
  assert.equal(view.already, false, '判不了不能当成已签（那会漏签）')
  assert.equal(view.stateText, '数据异常')
})

test('probeAccount：rolelist 抛错 → 查询失败，不是 noRole', async () => {
  reset()
  state.roleListThrows = new Error('网络炸了')

  const view = await probeAccount('1474610')
  assert.notEqual(view.noRole, true, '查询失败≠没角色，不能静默跳过（那会把真故障藏起来）')
  assert.equal(view.stateText, '查询失败')
  assert.equal(view.failReason, '出错了：网络炸了')
})

test('probeAccount：signinfo 抛错 → 查询失败，且带上角色名', async () => {
  reset()
  state.roleList = ROLELIST_HAS_ROLE
  state.signInfoThrows = new Error('超时')

  const view = await probeAccount('1536597962')
  assert.equal(view.stateText, '查询失败')
  assert.equal(view.roleName, '昨日花昨日开')
})

/* ========================================================= signOneAccount */

test('signOneAccount：没角色时**不签**（不能白发写请求）', async () => {
  reset()
  state.roleList = ROLELIST_NO_ROLE

  const view = await signOneAccount('1474610')
  assert.equal(view.noRole, true)
  assert.equal(state.signCalls, 0, '没角色的号绝不能发 newsignin')
})

test('signOneAccount：已签时**不签**（少一次请求 = 少一分撞频控）', async () => {
  reset()
  state.roleList = ROLELIST_HAS_ROLE
  state.signInfo = SIGNINFO_SIGNED

  const view = await signOneAccount('1536597962')
  assert.equal(view.already, true)
  assert.equal(state.signCalls, 0, '已签的号不该再发写请求')
})

test('signOneAccount：未签时真的去签，并带出奖励', async () => {
  reset()
  state.roleList = ROLELIST_HAS_ROLE
  state.signInfo = SIGNINFO_EMPTY
  state.signResult = {
    returnCode: 0,
    data: {
      userSign: '0000010',
      seqSignDays: 1,
      totalSignDays: 1,
      giftList: [{ giftText: '营地币', giftNum: '25' }]
    }
  }

  const view = await signOneAccount('1536597962')
  assert.equal(state.signCalls, 1, '未签就该发一次写请求')
  assert.equal(view.signed, true)
  assert.equal(view.stateText, '签到成功')
  assert.equal(view.signGifts.length, 1)
  assert.equal(view.info.weekSignMap, '0000010', '要用服务端回的新状态，省一次查询')
})

test('signOneAccount：状态判不了时**不发**写请求（宁可漏签也别乱签）', async () => {
  reset()
  state.roleList = ROLELIST_HAS_ROLE
  state.signInfo = { returnCode: 0, data: { weekSignMap: '???' } }

  const view = await signOneAccount('1536597962')
  assert.equal(state.signCalls, 0, '判不了状态就不该签')
  assert.equal(view.signedToday, null)
})

test('signOneAccount：-105203（服务端说已签）按已签处理，不是失败', async () => {
  reset()
  state.roleList = ROLELIST_HAS_ROLE
  state.signInfo = SIGNINFO_EMPTY
  state.signResult = { returnCode: -105203, returnMsg: '请勿重复签到' }

  const view = await signOneAccount('1536597962')
  assert.equal(view.already, true)
  assert.notEqual(view.stateText, '签到失败')
})

test('signOneAccount：-105204 归类成「角色签不了」，带可操作的建议', async () => {
  reset()
  state.roleList = ROLELIST_HAS_ROLE
  state.signInfo = SIGNINFO_EMPTY
  state.signResult = { returnCode: -105204, returnMsg: '未授权营地' }

  const view = await signOneAccount('1536597962')
  assert.equal(view.stateText, '角色签不了')
  assert.ok(view.failReason.includes('营地 App'), '要给用户一条能照做的路')
})
