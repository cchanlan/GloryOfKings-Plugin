/**
 * `#发起开黑` 的参数解析（`utils/teamParse.js`）。
 *
 * 钉住 2026-10-16 主人报的那个 bug：
 *   `#发起开黑 发育 辅助 打野 3排 1点40` 回的是「你玩发育路 · 缺 2 个位置都行」——
 *   **第二个及以后的分路被当成备注丢了**，图上两个空位都标「都行」。
 *   群友是顺着写下来的（不写「缺」字），所以第二个起一律当缺口。
 *
 * 顺带钉住房间号：带前缀（`房间号123456` / `房号 998877`）和裸的 4~6 位数字都认，
 * 但**不能把别的参数吃掉**（时间、几排、分路各是各的）。
 *
 * teamParse 是零依赖的纯函数，直接 import 跑，不用沙箱。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCreate, matchRoomNo, parseJoin } from '../utils/teamParse.js'

test('第二个及以后的分路是「缺的位置」，不是备注', () => {
  const r = parseCreate('发育 辅助 打野 3排 1点40')

  assert.equal(r.lane, '发育路', '第一个分路是发起人的位置')
  assert.deepEqual(r.needLanes, ['辅助', '打野'], '后面两个是缺口')
  assert.equal(r.size, 3)
  assert.equal(r.note, '', '不该有东西落进备注')
})

test('显式写「缺」的照旧，且顺序按用户写的来', () => {
  const r = parseCreate('打野 缺辅助发育 3排 20:30')

  assert.equal(r.lane, '打野')
  assert.deepEqual(r.needLanes, ['辅助', '发育路'])
  assert.equal(r.size, 3)
})

test('缺口写得比排数多时按前几个算', () => {
  const r = parseCreate('打野 辅助 中路 发育路 对抗路 3排')

  assert.equal(r.size, 3)
  assert.deepEqual(r.needLanes, ['辅助', '中路'], '3 排只要 2 个队友')
})

test('「都行」不算缺口，还是留在备注里', () => {
  const r = parseCreate('打野 都行 3排')

  assert.equal(r.lane, '打野')
  assert.deepEqual(r.needLanes, [])
  assert.equal(r.note, '都行')
})

test('备注不会被误当成分路或缺口', () => {
  const r = parseCreate('打野 3排 来个大神带飞')

  assert.equal(r.lane, '打野')
  assert.deepEqual(r.needLanes, [])
  assert.equal(r.note, '来个大神带飞')
})

test('房间号：带前缀、分开写、裸数字都认', () => {
  assert.equal(parseCreate('打野 3排 房间号123456').roomNo, '123456')
  assert.equal(parseCreate('打野 3排 房号 998877').roomNo, '998877')
  assert.equal(parseCreate('打野 3排 123456').roomNo, '123456')
  assert.equal(parseCreate('打野 3排 1234').roomNo, '1234', '4 位的也认')
})

test('没写房间号时是空串（图上走「QQ 联系」）', () => {
  assert.equal(parseCreate('打野 缺辅助 3排 20:30').roomNo, '')
})

test('房间号不会把时间/排数/分路吃掉', () => {
  const r = parseCreate('发育 辅助 3排 20:30 123456')

  assert.equal(r.lane, '发育路')
  assert.deepEqual(r.needLanes, ['辅助'])
  assert.equal(r.size, 3)
  assert.equal(r.meetText, '20:30', '时间照旧认出来')
  assert.equal(r.roomNo, '123456')
})

test('matchRoomNo 的边界：3 位和 7 位都不当房间号', () => {
  assert.equal(matchRoomNo('123'), '')
  assert.equal(matchRoomNo('1234567'), '')
  assert.equal(matchRoomNo('房间号'), '')
  assert.equal(matchRoomNo('12:30'), '')
})

test('加入指令的房号仍是两位，别被房间号规则影响', () => {
  const r = parseJoin('12 辅助')

  assert.equal(r.code, '12')
  assert.equal(r.lane, '辅助')
})
