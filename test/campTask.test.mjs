/**
 * 福利中心任务解析：**「做完了」和「领了」是两回事**。
 *
 * 这个判据就是用户那个 bug 的全部成因 —— 签到把任务做掉（`finishStatus=1`），
 * 但奖励没领（`packageStatus=0`），营地币不到账。所以这里主要钉三件事：
 *   ① `claimable` 必须同时看两个状态位，不能用进度（`1/1`）或 currency 推
 *   ② 字段缺失/脏值**不能**被当成「未领取」——那会每轮重复领、白撞频控
 *   ③ 领取 body 的形态跟 gameId 绑定（50001 不带角色）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CAMP_GAME_ID, normalizeTask, parseTaskList, rewardBody,
  cleanMsg, describeClaimed, describeTodo, pickInfoId
} from '../utils/campTask.js'

/* --------------------------------------------------- 真机原文（2026-10-10） */

/** 已完成但**没领**——就是截图里那条「每日前往游戏专区签到(1/1) + 领取」 */
const TASK_SIGNED_UNCLAIMED = {
  title: '每日前往游戏专区签到',
  desc: '限时任务：前往任意游戏专区签到',
  taskScore: 1,
  userScore: 1,
  gifts: [{ packageId: 0, packageNum: 25, name: '营地币', desc: '营地币*25', gameId: '50001' }],
  func: 'dailySigned',
  jumpUrl: 'smobagamehelper://mygameprofile',
  currency: 25,
  taskId: '2024010800002',
  finishStatus: 1,
  packageStatus: 0,
  gameId: '50001'
}

/** 没做完 */
const TASK_NEWS_TODO = {
  title: '浏览资讯',
  desc: '当日浏览营地1篇资讯',
  taskScore: 1,
  userScore: 0,
  gifts: [{ packageNum: 25, name: '营地币' }],
  func: 'todayViewNews',
  currency: 25,
  taskId: '2024010800001',
  finishStatus: 0,
  packageStatus: 0,
  gameId: '50001'
}

/** 做完且已领（领取后再查就是这个样子，实测 packageStatus 0→1） */
const TASK_CLAIMED = { ...TASK_SIGNED_UNCLAIMED, packageStatus: 1 }

/** 不给营地币的任务（实测「关注作者」给的是亲密玫瑰，currency 为 0） */
const TASK_NO_COIN = {
  title: '关注作者',
  taskScore: 3,
  userScore: 0,
  gifts: [{ packageNum: 1, name: '亲密玫瑰' }],
  func: 'addedAuthor',
  currency: 0,
  taskId: '2024010900001',
  finishStatus: 0,
  packageStatus: 0,
  gameId: '50001'
}

/* ------------------------------------------------------------ normalizeTask */

test('⭐ 做完了但没领 → claimable（这就是「签到了没到账」那条）', () => {
  const t = normalizeTask(TASK_SIGNED_UNCLAIMED)
  assert.equal(t.finished, true)
  assert.equal(t.claimed, false)
  assert.equal(t.claimable, true, '做完+没领 = 可领取')
  assert.equal(t.currency, 25)
  assert.equal(t.progressText, '1/1')
})

test('⭐ 已领过的**不能**再算可领取（否则每轮重复领）', () => {
  const t = normalizeTask(TASK_CLAIMED)
  assert.equal(t.finished, true)
  assert.equal(t.claimed, true)
  assert.equal(t.claimable, false)
})

test('没做完的不可领取', () => {
  assert.equal(normalizeTask(TASK_NEWS_TODO).claimable, false)
})

test('⭐ 进度 1/1 **不能**当成已领取的判据', () => {
  // 只有进度满、两个状态位都没给 —— 必须按「没做完」处理，不能擅自去领
  const t = normalizeTask({ taskId: 'x', title: 'a', taskScore: 1, userScore: 1 })
  assert.equal(t.progressText, '1/1')
  assert.equal(t.finished, false, '缺 finishStatus 不能靠进度推')
  assert.equal(t.claimable, false)
})

test('⭐ 状态位是脏值时一律按「没完成/没领」（Number 陷阱）', () => {
  // Number(null)/Number('')/Number([]) 都是 0，直接转数字会把这些当成「未领取」
  for (const bad of [null, undefined, '', [], {}, 'yes', 2, '0']) {
    const t = normalizeTask({ taskId: 'x', title: 'a', finishStatus: 1, packageStatus: bad })
    assert.equal(t.claimed, false, `packageStatus=${JSON.stringify(bad)} 应判为未领`)
  }
  // 反过来：只有 1 / '1' 才算已领
  assert.equal(normalizeTask({ taskId: 'x', packageStatus: 1 }).claimed, true)
  assert.equal(normalizeTask({ taskId: 'x', packageStatus: '1' }).claimed, true)
})

test('没有 taskId 的条目直接丢掉（没 id 就没法领）', () => {
  assert.equal(normalizeTask({ title: '无名' }), null)
  assert.equal(normalizeTask({ taskId: '  ' }), null)
  assert.equal(normalizeTask(null), null)
})

test('奖励用 name + packageNum（跟签到那边的 giftText/giftNum 不是一套）', () => {
  const t = normalizeTask(TASK_SIGNED_UNCLAIMED)
  assert.deepEqual(t.gifts, [{ name: '营地币', num: 25 }])
})

/* ------------------------------------------------------------ parseTaskList */

test('parseTaskList：挑出可领取的那几条', () => {
  const view = parseTaskList({
    returnCode: 0,
    data: { myCurrency: 25, taskList: [TASK_SIGNED_UNCLAIMED, TASK_NEWS_TODO, TASK_CLAIMED, TASK_NO_COIN] }
  })
  assert.equal(view.ok, true)
  assert.equal(view.coin, 25)
  assert.equal(view.tasks.length, 4)
  assert.deepEqual(view.claimable.map(t => t.taskId), ['2024010800002'])
})

test('parseTaskList：非 0 业务码 = 失败，且把码前缀去掉', () => {
  const view = parseTaskList({ returnCode: -105201, returnMsg: '-105201:任务未找到' })
  assert.equal(view.ok, false)
  assert.equal(view.failReason, '任务未找到')
  assert.deepEqual(view.claimable, [])
})

test('parseTaskList：余额读不到是 null，**不是 0**', () => {
  // 0 会显示成「0 枚营地币」，用户以为余额被清空了
  assert.equal(parseTaskList({ returnCode: 0, data: {} }).coin, null)
  assert.equal(parseTaskList({ returnCode: 0, data: { myCurrency: [] } }).coin, null)
  assert.equal(parseTaskList({ returnCode: 0, data: { myCurrency: 0 } }).coin, 0, '真的 0 要照实显示')
})

test('parseTaskList：taskList 缺失/脏值不炸', () => {
  for (const d of [{}, { taskList: null }, { taskList: 'x' }, { taskList: [null, {}] }]) {
    const view = parseTaskList({ returnCode: 0, data: d })
    assert.equal(view.ok, true)
    assert.deepEqual(view.claimable, [])
  }
})

/* -------------------------------------------------------------- rewardBody */

test('⭐ 50001（营地任务）领取时 mRoleIds 是空数组，不带角色', () => {
  assert.deepEqual(rewardBody(['a', 'b']), { taskIds: ['a', 'b'], mRoleIds: [] })
  assert.equal(CAMP_GAME_ID, '50001')
})

test('非 50001 才带角色', () => {
  assert.deepEqual(
    rewardBody(['a'], '20001', { roleId: '123' }),
    { taskIds: ['a'], mRoleIds: [{ roleId: '123', gameId: '20001' }] }
  )
})

test('rewardBody：脏 taskId 过滤掉', () => {
  assert.deepEqual(rewardBody(['a', '', null, '  ', 'b']).taskIds, ['a', 'b'])
  assert.deepEqual(rewardBody(null).taskIds, [])
})

/* ----------------------------------------------------------------- 文案 */

test('describeClaimed：带上到手的币数', () => {
  const tasks = [normalizeTask(TASK_SIGNED_UNCLAIMED), normalizeTask({ ...TASK_NO_COIN, finishStatus: 1 })]
  assert.equal(describeClaimed(tasks), '每日前往游戏专区签到 +25、关注作者')
  assert.equal(describeClaimed([]), '')
  assert.equal(describeClaimed(), '')
})

test('describeTodo：只统计还能拿营地币的（0 币任务不进总数）', () => {
  const tasks = [TASK_NEWS_TODO, TASK_NO_COIN].map(normalizeTask)
  const text = describeTodo(tasks)
  assert.match(text, /还有 1 个任务没做/, '关注作者给的不是营地币，不该计入')
  assert.match(text, /再得 25 营地币/)
  assert.equal(describeTodo([normalizeTask(TASK_CLAIMED)]), '', '都做完了就不提示')
})

test('cleanMsg：去掉码前缀；本来就没前缀的不动', () => {
  assert.equal(cleanMsg('-105201:任务未找到'), '任务未找到')
  assert.equal(cleanMsg('1:服务繁忙，请稍后再试'), '服务繁忙，请稍后再试')
  assert.equal(cleanMsg('就是一句话'), '就是一句话')
  assert.equal(cleanMsg(null), '')
})

/* ------------------------------------------- pickInfoId：挑一条能做任务的资讯 */

test('pickInfoId：只认 type=14 的资讯卡，普通动态/帖子跳过', () => {
  const feed = [
    { type: 2, momentId: '1' },                                     // 普通动态
    { type: 3, iDocId: '9', title: '长文' },                          // 帖子
    { type: 14, infoContent: { infoId: '180810733' } },              // ← 这个
    { type: 14, infoContent: { infoId: '180810600' } }
  ]
  assert.equal(pickInfoId(feed), '180810733', '取第一个能用的，不排序')
})

test('pickInfoId：type=14 但 infoContent 为 null 的要跳过', () => {
  const feed = [
    { type: 14, infoContent: null },
    { type: 14, infoContent: { infoId: '  180810600  ' } }
  ]
  assert.equal(pickInfoId(feed), '180810600', '顺带把首尾空格去掉')
})

test('pickInfoId：挑不到就回空串，**不是**抛错也不是 null', () => {
  assert.equal(pickInfoId([]), '')
  assert.equal(pickInfoId(null), '')
  assert.equal(pickInfoId(undefined), '')
  assert.equal(pickInfoId('不是数组'), '')
  assert.equal(pickInfoId([{ type: 2 }]), '', '只有非资讯卡')
  assert.equal(pickInfoId([{ type: 14, infoContent: { infoId: '' } }]), '', 'infoId 是空串')
})

test('pickInfoId：type 是字符串也要认（接口可能回字符串）', () => {
  assert.equal(pickInfoId([{ type: '14', infoContent: { infoId: '123' } }]), '123')
})
