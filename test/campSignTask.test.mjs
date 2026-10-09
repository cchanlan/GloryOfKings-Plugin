/**
 * 定时签到的两个纯函数：统计口径 + 按号主分组。
 *
 * 这两个的坑都在「容易写错但不会报错」上：
 *   · `summarizeViews` 里「没绑角色」必须跟「真失败」分开 —— 混在一起
 *     主人那台机器（5 个号里 3 个没角色）就会报「3 个没签上」
 *   · `groupByOwner` 里**空 owner 必须单独归一组**，不能塞给任意一个人 ——
 *     那会把别人的账号状态发错人
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeViews, groupByOwner } from '../utils/campSignTask.js'

/* ------------------------------------------------------------- summarizeViews */

test('summarizeViews：四类各归各的', () => {
  const stats = summarizeViews([
    { signed: true },
    { signed: true },
    { already: true },
    { noRole: true },
    { noRole: true },
    { stateText: '签到失败' }
  ])
  assert.deepEqual(stats, { okCount: 2, alreadyCount: 1, noRoleCount: 2, failCount: 1 })
})

test('summarizeViews：没绑角色**不**算进失败（主人那台机器 3/5 是这种）', () => {
  const stats = summarizeViews([{ noRole: true }, { noRole: true }, { noRole: true }])
  assert.equal(stats.noRoleCount, 3)
  assert.equal(stats.failCount, 0, '没角色不能记成失败')
})

test('summarizeViews：空数组 / 脏输入不炸', () => {
  const zero = { okCount: 0, alreadyCount: 0, noRoleCount: 0, failCount: 0 }
  assert.deepEqual(summarizeViews([]), zero)
  assert.deepEqual(summarizeViews(), zero)
  // ⚠️ `[null, undefined]` 是**两个**元素 —— 两个都认不出，所以是 2 个失败。
  //    早先这里写 1，是把自己的测试写错了（代码本身没问题）
  assert.deepEqual(summarizeViews([null, undefined]), { ...zero, failCount: 2 })
  assert.deepEqual(summarizeViews([null]), { ...zero, failCount: 1 })
})

test('summarizeViews：signed 优先于 already（一个 view 不该同时有两个标记，但真出现了要稳定）', () => {
  assert.equal(summarizeViews([{ signed: true, already: true }]).okCount, 1)
})

/* --------------------------------------------------------------- groupByOwner */

const pairs = [
  { account: { userId: '1', ownerBotUserId: '111' }, view: { campId: '1' } },
  { account: { userId: '2', ownerBotUserId: '111' }, view: { campId: '2' } },
  { account: { userId: '3', ownerBotUserId: '222' }, view: { campId: '3' } },
  { account: { userId: '4', ownerBotUserId: '' }, view: { campId: '4' } },
  { account: { userId: '5' }, view: { campId: '5' } }
]

test('groupByOwner：同一个号主的号归一组', () => {
  const g = groupByOwner(pairs)
  assert.equal(g.get('111').length, 2)
  assert.deepEqual(g.get('111').map(v => v.campId), ['1', '2'])
  assert.equal(g.get('222').length, 1)
})

test('groupByOwner：空 owner 归到 null 组，**不能**塞给第一个人', () => {
  const g = groupByOwner(pairs)
  assert.ok(g.has(null), '必须有 null 这一组')
  assert.equal(g.get(null).length, 2, '空串和缺字段都要落进来')
  // 关键：不能混进 111 那组
  assert.equal(g.get('111').length, 2, '无主号不能混进有主的组')
})

test('groupByOwner：空输入返回空 Map', () => {
  assert.equal(groupByOwner([]).size, 0)
  assert.equal(groupByOwner().size, 0)
})

test('groupByOwner：只保留 view，不把 account 也塞进去', () => {
  const g = groupByOwner(pairs)
  const first = g.get('111')[0]
  assert.deepEqual(Object.keys(first), ['campId'], '组里只该有 view')
})

test('groupByOwner：owner 前后有空格时按去空格后算', () => {
  const g = groupByOwner([{ account: { ownerBotUserId: '  111  ' }, view: { campId: 'x' } }])
  assert.ok(g.has('111'), '要去空格')
  assert.ok(!g.has('  111  '))
})
