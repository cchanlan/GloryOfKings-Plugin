/**
 * 段位升降文案的回归测试（2026-10-15 主人报「升段文案读着像掉星」时加的）。
 *
 * 要防的是这个坑：营地对**历史对局**返回的 roleJobName 是「查询那一刻的当前段位」，
 * 同一批请求里所有历史局名字全一样，`jobFrom` 恒等于 `jobTo`，
 * 「段位 A → B」那条分支实际走不到 —— 起点段位名只能靠 roleJob 编号反推。
 * 详见 utils/pushStore.js 里 resolvePrevRankName 的注释。
 *
 * 跑：node test/rankStarChange.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePrevRankName, formatStarChange, formatScoreChange } from '../utils/pushStore.js'

describe('resolvePrevRankName：由终点段位名 + 编号差反推起点名', () => {
  it('编号涨 1（升一小段）→ 起点是更低的那一小段', () => {
    assert.equal(resolvePrevRankName('至尊星耀I', 25, 26), '至尊星耀II')
    assert.equal(resolvePrevRankName('至尊星耀III', 23, 24), '至尊星耀IV')
    assert.equal(resolvePrevRankName('永恒钻石I', 14, 15), '永恒钻石II')
    assert.equal(resolvePrevRankName('荣耀黄金I', 5, 6), '荣耀黄金II')
  })

  it('编号掉 1（掉一小段）→ 起点是更高的那一小段', () => {
    assert.equal(resolvePrevRankName('至尊星耀II', 26, 25), '至尊星耀I')
    assert.equal(resolvePrevRankName('至尊星耀V', 26, 25), '至尊星耀IV')
  })

  it('编号差超过 1 一律不猜：跨大段（钻石 15 → 星耀 22）、赛季重置（26 → 16）都返回空', () => {
    assert.equal(resolvePrevRankName('至尊星耀V', 15, 22), '')
    assert.equal(resolvePrevRankName('至尊星耀I', 26, 16), '')
    assert.equal(resolvePrevRankName('至尊星耀II', 16, 22), '')
    assert.equal(resolvePrevRankName('至尊星耀V', 21, 22), '')
  })

  it('没有小段号的段位（王者系）推不出来', () => {
    assert.equal(resolvePrevRankName('最强王者', 25, 26), '')
    assert.equal(resolvePrevRankName('荣耀王者', 25, 26), '')
  })
})

describe('formatStarChange：收工总结 / 日报周报的段位行', () => {
  const s = (o) => ({ jobFrom: '至尊星耀I', jobTo: '至尊星耀I', starFrom: 3, starTo: 0, jobNumFrom: 25, jobNumTo: 26, ...o })

  it('升一小段：两边段位名和星数都写全（主人 2026-10-14 那次的实际形态）', () => {
    const r = formatStarChange(s({}))
    assert.equal(r.text, '至尊星耀II 3星 → 至尊星耀I 0星（升段）')
    assert.equal(r.tone, 'up')
    assert.equal(r.icon, '📈')
  })

  it('掉一小段：同样写全，并且明确报「掉段」', () => {
    // 线上是「名字撞车」的形态：两边 roleJobName 都是查询时刻的当前段位
    const r = formatStarChange(s({ jobFrom: '至尊星耀II', jobTo: '至尊星耀II', starFrom: 0, starTo: 1, jobNumFrom: 26, jobNumTo: 25 }))
    assert.equal(r.text, '至尊星耀I 0星 → 至尊星耀II 1星（掉段）')
    assert.equal(r.tone, 'down')
    assert.equal(r.icon, '📉')
  })

  it('编号大跳（赛季重置 26 → 16）不下结论，也不编段位名', () => {
    const r = formatStarChange(s({ jobNumFrom: 26, jobNumTo: 16, starFrom: 94, starTo: 0 }))
    assert.equal(r.tone, 'flat')
    assert.ok(!r.text.includes('掉段') && !r.text.includes('升段'), `不该下结论：${r.text}`)
  })

  it('跨大段（编号不连续）保持旧的半截文案，不编起点名', () => {
    const r = formatStarChange(s({ jobNumFrom: 15, jobNumTo: 22, starFrom: 5, starTo: 1 }))
    assert.equal(r.text, '至尊星耀I 5 → 1星（升段）')
  })

  it('同名段同编号只比星数时不受影响', () => {
    const r = formatStarChange(s({ jobNumFrom: 25, jobNumTo: 25, starFrom: 3, starTo: 5 }))
    assert.equal(r.text, '至尊星耀I 3 → 5星（上了2星）')
  })
})

describe('formatScoreChange：单局播报的段位行', () => {
  const item = (o) => ({ roleJobName: '至尊星耀I', roleJob: 26, stars: 1, gameresult: 1, ...o })

  it('升一小段：写全两边', () => {
    const r = formatScoreChange(item({}), { roleJobName: '至尊星耀I', roleJob: 25, stars: 5 })
    assert.equal(r.text, '至尊星耀II 5星 → 至尊星耀I 1星（升段）')
    assert.equal(r.tone, 'up')
  })

  it('编号大跳时维持旧行为（jump 拦下，只报当前段位）', () => {
    const r = formatScoreChange(item({}), { roleJobName: '至尊星耀I', roleJob: 16, stars: 94 })
    assert.equal(r.text, '至尊星耀I 1星')
    assert.equal(r.tone, 'flat')
  })
})
