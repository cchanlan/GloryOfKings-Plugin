/**
 * 开黑播报的**收件人决策**（`utils/teamStore.js`）。
 *
 * 钉住的是 2026-10-16 主人定的那条规则：
 *   · 「有人发起」照旧广播到所有群（招人，人越多越容易凑齐）
 *   · 「人齐了」**只发本机参与过的群**（发起群 + 有人加入的群），并 @ 参与的人；
 *     没发起过、也没人加入过的群一条都不该收到 —— 那是纯噪音
 *
 * 这条规则一旦回归，表现是**别的群被满员播报刷屏**，而且是十几台机器人各刷一遍，
 * 群里很难追溯到是哪次改动引入的，所以用测试锁住。
 *
 * 顺带钉住 `origins` 的**老格式兼容**：它原来是 `roomKey -> 群号`（字符串），
 * 为了记「发起人是谁」（满员要 @ 他）改成了 `{groupId, qq}`。线上的文件里躺着的
 * 还是老格式，读错的话发起群会被判成「没参与」而漏播。
 *
 * 还有两条（同样 2026-10-16 主人定）：
 *   · 群开关**默认关**，只播白名单里的群（`config.teamBroadcastGroups`）
 *   · **发送账**：每发成一个群记一笔，重启后跳过记过的群 ——
 *     不然一轮播到一半被重启，前面收过的群会再收一遍
 *
 * 用 test/helpers/sandbox.mjs 的沙箱：`#components` / `#utils` 换成假模块，
 * PluginData 指向临时目录，**绝不碰插件 data/ 里的真状态表**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSandbox, run, cleanup } from './helpers/sandbox.mjs'

/** 跑一段沙箱脚本，把它的 stdout 当 JSON 收回来 */
function inSandbox (source) {
  const root = makeSandbox()
  try {
    const r = run(root, source)
    assert.equal(r.ok, true, `沙箱脚本失败:\n${r.stderr}\n${r.stdout}`)
    return JSON.parse(r.stdout.trim().split('\n').pop())
  } finally {
    cleanup(root)
  }
}

/**
 * 沙箱里的通用开头：定位状态文件 + 两个小助手。
 *
 * 路径从 case-root.txt 读（sandbox.run 会写好），别在 JS 字符串里拼绝对路径 ——
 * Windows 的反斜杠转义太容易出错。
 */
const PRELUDE = `
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

const ROOT = fs.readFileSync('./case-root.txt', 'utf8').trim()
const FILE = path.join(ROOT, 'PluginRoot', 'data', 'TeamUpPush.yaml')
fs.mkdirSync(path.dirname(FILE), { recursive: true })

/** 一个房。roomKey 认 code + createdAt 两项 */
const room = (code, createdAt) => ({ code, createdAt })
`

test('旧格式 origins（值是群号字符串）要认出来 —— 否则发起群漏播满员', () => {
  const out = inSandbox(`
    ${PRELUDE}
    import { loadTeamStore, originGroupOf } from './utils/teamStore.js'

    fs.writeFileSync(FILE, YAML.stringify({ origins: { '12:100': '555' } }))
    const store = loadTeamStore()
    console.log(JSON.stringify({
      groupId: originGroupOf(store, room('12', 100)),
      qq: store.origins['12:100'].qq
    }))
  `)

  assert.equal(out.groupId, '555', '老格式的群号要还原成 groupId')
  assert.equal(out.qq, '', '老记录里没有发起人，别造一个出来')
})

test('markOrigin / markJoin 记的是「本机哪个群的谁参与了」', () => {
  const out = inSandbox(`
    ${PRELUDE}
    import { loadTeamStore, markOrigin, markJoin, roomGroups } from './utils/teamStore.js'

    const r = room('12', 100)
    markOrigin(r, '111', 'q1')
    markJoin(r, '222', 'q2')
    // 同一个群两个人先后加入：两个都要 @，不能互相盖掉
    markJoin(r, '111', 'q3')
    // 同一个人重复加同一群：不该出现两次
    markJoin(r, '111', 'q3')

    const groups = roomGroups(loadTeamStore(), r)
    console.log(JSON.stringify({
      groups: [...groups.keys()],
      g111: [...(groups.get('111') || [])],
      g222: [...(groups.get('222') || [])]
    }))
  `)

  assert.deepEqual(out.groups.sort(), ['111', '222'], '发起群和加入群都要记到')
  assert.deepEqual(out.g111, ['q1', 'q3'], '发起人 + 后来加入的人')
  assert.deepEqual(out.g222, ['q2'])
})

test('满员只发参与过的群：没参与的群一个新房的满员播报都收不到', () => {
  const out = inSandbox(`
    ${PRELUDE}
    import { loadTeamStore, markOrigin, markJoin, planBroadcast } from './utils/teamStore.js'

    const fresh = room('12', 100)   // 本机在 111 群发起
    const full = room('13', 200)    // 111 群发起人 + 222 群的人加入 → 满了
    markOrigin(fresh, '111', 'q1')
    markOrigin(full, '111', 'q1')
    markJoin(full, '222', 'q2')

    const plan = planBroadcast(['111', '222', '333', '444'], [fresh], [full], loadTeamStore())
    const dump = {}
    for (const [gid, item] of plan) {
      dump[gid] = {
        fresh: item.fresh.map(r => r.code),
        full: item.full.map(r => r.code),
        ats: item.ats
      }
    }
    console.log(JSON.stringify(dump))
  `)

  // 发起群：新房不重复播（当场已回复），满员要播并 @ 发起人
  assert.deepEqual(out['111'], { fresh: [], full: ['13'], ats: ['q1'] })
  // 加入群：新房的招人广播收得到，满员也收得到，@ 加入的人
  assert.deepEqual(out['222'], { fresh: ['12'], full: ['13'], ats: ['q2'] })
  // 无关群：只收招人广播，**满员一条都不该有**
  assert.deepEqual(out['333'], { fresh: ['12'], full: [], ats: [] })
  assert.deepEqual(out['444'], { fresh: ['12'], full: [], ats: [] })
})

test('本机没参与的房满员 —— 一个群都不发（哪怕开着广播）', () => {
  const out = inSandbox(`
    ${PRELUDE}
    import { loadTeamStore, planBroadcast } from './utils/teamStore.js'

    const full = room('13', 200)
    const plan = planBroadcast(['111', '222'], [], [full], loadTeamStore())
    console.log(JSON.stringify({ size: plan.size, keys: [...plan.keys()] }))
  `)

  assert.equal(out.size, 0, '没有新房、也没参与过满员的房 → 这轮没有群要发')
})

test('满员房里的无关群被剔掉，但同一个房的参与群照发', () => {
  const out = inSandbox(`
    ${PRELUDE}
    import { loadTeamStore, markJoin, planBroadcast } from './utils/teamStore.js'

    const full = room('13', 200)
    markJoin(full, '222', 'q2')

    const plan = planBroadcast(['111', '222'], [], [full], loadTeamStore())
    console.log(JSON.stringify({ keys: [...plan.keys()], ats: plan.get('222')?.ats }))
  `)

  assert.deepEqual(out.keys, ['222'], '只有参与过的 222 收得到')
  assert.deepEqual(out.ats, ['q2'])
})

test('群开关默认关：只有进了白名单的群才算开着，写进锅巴配置', () => {
  const out = inSandbox(`
    ${PRELUDE}
    import { setTeamSub, isTeamSub, enabledGroups } from './utils/teamStore.js'
    import { fakeConfig } from './fake-config.mjs'

    const before = isTeamSub('333')   // 从没开过的群
    setTeamSub('111', true)
    setTeamSub('222', true)
    setTeamSub('111', false)          // 又关掉 —— 名单里不该留空壳
    // 重复开同一个群：状态没变化，调用方靠 changed 判断要不要回复
    const again = setTeamSub('222', true)

    console.log(JSON.stringify({
      before,
      cfg: fakeConfig().teamBroadcastGroups,
      is111: isTeamSub('111'),
      is222: isTeamSub('222'),
      enabled: [...enabledGroups()],
      changedAgain: again.changed
    }))
  `)

  assert.equal(out.before, false, '没开过的群默认不收播报')
  assert.deepEqual(out.cfg, ['222'], '写进配置的是「开着的群」名单')
  assert.equal(out.is111, false, '关掉的群不再收')
  assert.equal(out.is222, true)
  assert.deepEqual(out.enabled, ['222'])
  assert.equal(out.changedAgain, false, '状态没变时 changed 必须是 false')
})

test('锅巴勾选存的是数字群号，也要认', () => {
  const out = inSandbox(`
    ${PRELUDE}
    import { setTeamSub, isTeamSub } from './utils/teamStore.js'
    import { fakeConfig, setFakeConfig } from './fake-config.mjs'

    // GSelectGroup 勾选存数字，手输的是字符串（可能带空格）
    setFakeConfig({ teamBroadcastGroups: [111, ' 222 '] })
    const is111 = isTeamSub('111')
    const is222 = isTeamSub('222')
    const reopen = setTeamSub('111', true)   // 已经开着：不该再加一条
    setTeamSub('111', false)

    console.log(JSON.stringify({ is111, is222, reopen: reopen.changed, cfg: fakeConfig().teamBroadcastGroups }))
  `)

  assert.equal(out.is111, true, '数字群号要和字符串群号比得上')
  assert.equal(out.is222, true, '手输带空格的也要认')
  assert.equal(out.reopen, false)
  assert.deepEqual(out.cfg, ['222'], '关掉 111 只删它，别的群原样留着')
})

test('老版本的「关闭名单」不再起作用 —— 默认关之后没开的群本来就收不到', () => {
  const out = inSandbox(`
    ${PRELUDE}
    import { isTeamSub, setTeamSub, loadTeamStore, saveTeamStore } from './utils/teamStore.js'
    import { setFakeConfig } from './fake-config.mjs'

    // 老数据：yaml 里关掉的 999、配置里关掉的 888
    fs.writeFileSync(FILE, YAML.stringify({ offList: { 999: { since: 1 } }, rev: 5 }))
    setFakeConfig({ teamMutedGroups: ['888'] })

    const before = { is999: isTeamSub('999'), is888: isTeamSub('888'), is777: isTeamSub('777') }
    const opened = setTeamSub('999', true)
    saveTeamStore(loadTeamStore())

    console.log(JSON.stringify({
      before, changed: opened.changed, after: isTeamSub('999'),
      offListGone: !('offList' in YAML.parse(fs.readFileSync(FILE, 'utf8')))
    }))
  `)

  assert.deepEqual(out.before, { is999: false, is888: false, is777: false }, '全都默认关')
  assert.equal(out.changed, true, '老名单里的群照样能开')
  assert.equal(out.after, true)
  assert.equal(out.offListGone, true, '老的 offList 下次保存就不再写')
})

test('写配置失败要能告诉用户，不能假装成功', () => {
  const out = inSandbox(`
    ${PRELUDE}
    import { setTeamSub, isTeamSub } from './utils/teamStore.js'
    import { failNextModify } from './fake-config.mjs'

    failNextModify(true)                 // 下一次 Config.modify 抛错
    const r = setTeamSub('111', true)
    console.log(JSON.stringify({ r, stillOff: !isTeamSub('111') }))
  `)

  assert.equal(out.r.failed, true, '要如实告诉调用方「没写进去」')
  assert.equal(out.r.changed, false)
  assert.equal(out.stillOff, true, '没写进配置就别改状态（照样收不到播报，符合事实）')
})

test('发送账：重启前已经发到的群，重启后不再发', () => {
  const out = inSandbox(`
    ${PRELUDE}
    import { loadTeamStore, saveTeamStore, markJoin, recordSent, planBroadcast } from './utils/teamStore.js'

    const fresh = room('12', 100)
    const full = room('13', 200)
    markJoin(full, '111', 'q1')
    markJoin(full, '222', 'q2')

    // 上一轮（重启前）：111 收到了 12 号房的招人和 13 号房的满员，222 只收到了招人
    const store = loadTeamStore()
    recordSent(store, '111', [fresh], [full])
    recordSent(store, '222', [fresh], [])
    saveTeamStore(store)

    const plan = planBroadcast(['111', '222', '333'], [fresh], [full], loadTeamStore())
    const dump = {}
    for (const [gid, item] of plan) dump[gid] = { fresh: item.fresh.map(r => r.code), full: item.full.map(r => r.code) }
    console.log(JSON.stringify(dump))
  `)

  assert.equal(out['111'], undefined, '两条都收过了：这个群这轮一条都不该有')
  assert.deepEqual(out['222'], { fresh: [], full: ['13'] }, '招人收过了只补满员')
  assert.deepEqual(out['333'], { fresh: ['12'], full: [] }, '没收过的照常发')
})

test('发送账落盘读得回，清掉时不留空壳', () => {
  const out = inSandbox(`
    ${PRELUDE}
    import { loadTeamStore, saveTeamStore, recordSent, clearSent } from './utils/teamStore.js'

    const r = room('12', 100)
    const store = loadTeamStore()
    recordSent(store, '111', [r], [r])
    recordSent(store, '111', [r], [])        // 同一个群记两次：不该出现两条
    recordSent(store, 222, [r], [])          // 数字群号也按字符串记
    saveTeamStore(store)

    const loaded = loadTeamStore()
    const afterLoad = JSON.parse(JSON.stringify(loaded.sent))
    clearSent(loaded, '12:100', 'new')
    const afterNew = JSON.parse(JSON.stringify(loaded.sent))
    clearSent(loaded, '12:100', 'full')

    console.log(JSON.stringify({ afterLoad, afterNew, afterAll: loaded.sent }))
  `)

  assert.deepEqual(out.afterLoad, { '12:100': { new: ['111', '222'], full: ['111'] } })
  assert.deepEqual(out.afterNew, { '12:100': { full: ['111'] } }, '只清招人那条，满员的账还在')
  assert.deepEqual(out.afterAll, {}, '两条都清了就连房一起删')
})

test('哪些房算播完：没群要发的算、有群收到的算、要发却一个都没收到的不算', () => {
  const out = inSandbox(`
    ${PRELUDE}
    import { loadTeamStore, recordSent, planBroadcast, settledRooms } from './utils/teamStore.js'

    const a = room('12', 100)
    const b = room('13', 200)
    const c = room('14', 300)

    // 一个群都没开广播：没有群要发 → 全算播完（不然每 30 秒白拉一次全量）
    const none = settledRooms([a, b], 'new', new Map(), loadTeamStore()).map(r => r.code)

    // a、b 要发给 111/222；c 在两个群的账上都已经有了（重启前发过）→ 这轮不用发
    const store = loadTeamStore()
    recordSent(store, '111', [c], [])
    recordSent(store, '222', [c], [])
    const plan = planBroadcast(['111', '222'], [a, b, c], [], store)
    // 这轮：a 发成了一个群，b 一个都没发出去
    recordSent(store, '222', [a], [])
    const done = settledRooms([a, b, c], 'new', plan, store).map(r => r.code)

    console.log(JSON.stringify({ none, done }))
  `)

  assert.deepEqual(out.none, ['12', '13'])
  assert.deepEqual(out.done, ['12', '14'], 'b 要发却一个群都没收到：下轮重试，不能记成播过了')
})
