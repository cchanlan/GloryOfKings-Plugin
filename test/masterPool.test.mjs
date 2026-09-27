/**
 * 大神观战池的筛选与分流（`utils/masterPool.js`）。
 *
 * 钉住四件事：
 *   ① **只认 `tvType === 2` 的对局** —— 池子里混着主播 / 活动 / 节目 / 赛事，
 *      挑错了就是开一个没有画面的房间给群友看
 *   ② **排位 5 + 巅峰 5**，一边不够要用另一边补满
 *      （巅峰赛每天 12:00 才开，那之前池子里一场巅峰都没有）
 *   ③ 分路只认营地给的那五个名字（`roleInfo.tag` 里 `id === 4`），
 *      认不出要如实说「没有」，不能默默当没筛 —— 用户会以为筛过了
 *   ④ 流没就绪（`liveStream.success` 假 / 没地址）的一律丢掉
 *
 * 纯逻辑、零依赖，不用 test/helpers/sandbox.mjs 那套。
 * 条目形状照 2026-09-27 实测的 `/info/tv/choiceitem` 抄。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { toBattles, pickBattles, pickFromBattles, matchLane, LANES, MODE_NAME } from '../utils/masterPool.js'

/** 造一条对局条目 */
function battle (gameType, lane, i = 1, { url = `rtmp://example/${i}`, success = true, battleId = `11381_${i}_1790462951` } = {}) {
  return {
    tvType: 2,
    battle: {
      battleInfo: {
        gameType,
        battleID: battleId,
        heroName: `英雄${i}`,
        desc: `王者${i}星`,
        roleInfo: { roleName: `玩家${i}`, tag: lane ? [{ id: 4, name: lane }] : [] }
      },
      liveStream: { success, stream: url ? { liveStreamUrl: url } : {} }
    }
  }
}

const many = (gameType, lane, n) => Array.from({ length: n }, (_, i) => battle(gameType, lane, i + 1))

test('只认 tvType===2 的对局，主播/节目/赛事都丢掉', () => {
  const items = [
    { tvType: 4, anchor: { name: '某主播' } },
    { tvType: 5, operation: {} },
    { tvType: 6, episode: {} },
    { tvType: 7, eventLive: {} },
    battle(4, '打野')
  ]
  assert.equal(toBattles(items).length, 1)
})

test('流没就绪的对局丢掉（开了也是永远转圈的页面）', () => {
  assert.equal(toBattles([battle(4, '打野', 1, { success: false })]).length, 0)
  assert.equal(toBattles([battle(4, '打野', 1, { url: '' })]).length, 0)
  assert.equal(toBattles([{ tvType: 2, battle: null }]).length, 0)
})

test('解析出的字段：模式 / 分路 / 昵称 / 段位描述', () => {
  const [it] = toBattles([battle(4, '打野', 7)])
  assert.equal(it.gameType, 4)
  assert.equal(it.lane, '打野')
  assert.equal(it.nick, '玩家7·英雄7')
  assert.equal(it.desc, '王者7星')
  assert.equal(it.url, 'rtmp://example/7')
})

test('排位 5 + 巅峰 5', () => {
  const { picked } = pickBattles([...many(4, '打野', 5), ...many(14, '中路', 5)], { count: 10, perMode: 5 })
  assert.equal(picked.length, 10)
  assert.equal(picked.filter((it) => it.gameType === 4).length, 5)
  assert.equal(picked.filter((it) => it.gameType === 14).length, 5)
})

test('只有一种模式时，另一边补满（巅峰 12 点前就是这种情况）', () => {
  const onlyRank = pickBattles(many(4, '打野', 10), { count: 10, perMode: 5 }).picked
  assert.equal(onlyRank.length, 10)
  assert.ok(onlyRank.every((it) => it.gameType === 4))

  const onlyPeak = pickBattles(many(14, '中路', 10), { count: 10, perMode: 5 }).picked
  assert.equal(onlyPeak.length, 10)
  assert.ok(onlyPeak.every((it) => it.gameType === 14))
})

test('两边都不够 5 时，总数是有的那些', () => {
  const { picked } = pickBattles([...many(4, '打野', 3), ...many(14, '中路', 2)], { count: 10, perMode: 5 })
  assert.equal(picked.length, 5)
})

test('分路筛：只留这个分路', () => {
  const { picked, laneMissed } = pickBattles(
    [...many(4, '打野', 6), ...many(4, '中路', 4)],
    { lane: '打野', count: 10, perMode: 5 }
  )
  assert.equal(laneMissed, false)
  assert.ok(picked.length > 0)
  assert.ok(picked.every((it) => it.lane === '打野'))
})

test('分路筛：一个都没有时 laneMissed 为真、不给东西', () => {
  const { picked, laneMissed } = pickBattles(many(4, '打野', 5), { lane: '游走' })
  assert.deepEqual(picked, [])
  assert.equal(laneMissed, true)
})

test('matchLane：五个分路都认，前缀也认，乱写返回空', () => {
  for (const lane of LANES) {
    assert.equal(matchLane(lane), lane)
  }
  assert.equal(matchLane('打野位'), '打野')
  assert.equal(matchLane('对抗'), '')
  assert.equal(matchLane(''), '')
  assert.equal(matchLane(null), '')
})

test('空输入不炸', () => {
  assert.deepEqual(pickBattles([], {}).picked, [])
  assert.deepEqual(pickBattles(null, {}).picked, [])
  assert.deepEqual(pickBattles(undefined, {}).picked, [])
  assert.deepEqual(toBattles(null), [])
})

test('count 截断生效', () => {
  const pool = many(4, '打野', 20)
  assert.equal(pickBattles(pool, { count: 10 }).picked.length, 10)
  assert.equal(pickBattles(pool, { count: 3 }).picked.length, 3)
})

test('模式名覆盖两种可观望模式（4 排位 / 14 巅峰）', () => {
  assert.equal(MODE_NAME[4], '排位')
  assert.equal(MODE_NAME[14], '巅峰')
})

test('battleId 被保留下来（数据的一部分，便于排查同一场）', () => {
  const [it] = toBattles([battle(4, '打野', 9)])
  assert.equal(it.battleId, '11381_9_1790462951')
})

test('pickFromBattles：直接吃转换好的列表，结果和 pickBattles 一致', () => {
  const items = [...many(4, '打野', 6), ...many(14, '中路', 6)]
  const a = pickBattles(items, { count: 10, perMode: 5 }).picked.map((it) => it.battleId)
  const b = pickFromBattles(toBattles(items), { count: 10, perMode: 5 }).picked.map((it) => it.battleId)
  assert.deepEqual(a, b)
})
