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

test('群开关写进锅巴配置 —— 面板勾选和 #关闭开黑广播 是同一份数据', () => {
  const out = inSandbox(`
    ${PRELUDE}
    import { setTeamSub, isTeamSub, mutedGroups } from './utils/teamStore.js'
    import { fakeConfig } from './fake-config.mjs'

    setTeamSub('111', false)   // 111 关掉播报
    setTeamSub('222', false)
    setTeamSub('111', true)    // 又开回来 —— 不该在名单里留空壳
    // 重复关同一个群：状态没变化，调用方靠 changed 判断要不要回复
    const again = setTeamSub('222', false)

    console.log(JSON.stringify({
      cfg: fakeConfig().teamMutedGroups,
      is111: isTeamSub('111'),
      is222: isTeamSub('222'),
      muted: [...mutedGroups()],
      changedAgain: again.changed
    }))
  `)

  assert.deepEqual(out.cfg, ['222'], '写进配置的是「关掉的群」名单')
  assert.equal(out.is111, true, '重新开启的群要能收播报')
  assert.equal(out.is222, false)
  assert.deepEqual(out.muted, ['222'])
  assert.equal(out.changedAgain, false, '状态没变时 changed 必须是 false')
})

test('老版本存在 yaml offList 里的群继续算数（两处取并集）', () => {
  const out = inSandbox(`
    ${PRELUDE}
    import { setTeamSub, mutedGroups } from './utils/teamStore.js'

    // 老数据：yaml 里关掉的 999
    fs.writeFileSync(FILE, YAML.stringify({ offList: { 999: { since: 1 } } }))
    // 新数据：配置里关掉的 888
    setTeamSub('888', false)

    console.log(JSON.stringify({ muted: [...mutedGroups()].sort() }))
  `)

  assert.deepEqual(out.muted, ['888', '999'], '换了存储位置，老记录不能失效')
})

test('老 yaml 里关着的群，重新开启要真的开得回来', () => {  const out = inSandbox(`
    ${PRELUDE}
    import { setTeamSub, isTeamSub, mutedGroups } from './utils/teamStore.js'

    // 老数据：yaml 里关掉的 999（只躺在老文件里，配置那份是空的）
    fs.writeFileSync(FILE, YAML.stringify({ offList: { 999: { since: 1 } } }))
    const before = isTeamSub('999')
    const opened = setTeamSub('999', true)
    const after = isTeamSub('999')

    console.log(JSON.stringify({
      before, changed: opened.changed, after, muted: [...mutedGroups()]
    }))
  `)

  assert.equal(out.before, false, '老记录要认（这个群关着）')
  assert.equal(out.changed, true, '开启是真变化 —— 不能回一句「本来就是开着的」却啥也没改')
  assert.equal(out.after, true, '开回来之后真的能收播报了')
  assert.deepEqual(out.muted, [], '老文件里那条也要清掉，否则并集里还关着')
})

test('写配置失败要能告诉用户，不能假装成功', () => {
  const out = inSandbox(`
    ${PRELUDE}
    import { setTeamSub, isTeamSub } from './utils/teamStore.js'
    import { failNextModify } from './fake-config.mjs'

    failNextModify(true)                 // 下一次 Config.modify 抛错
    const r = setTeamSub('111', false)
    console.log(JSON.stringify({ r, stillOn: isTeamSub('111') }))
  `)

  assert.equal(out.r.failed, true, '要如实告诉调用方「没写进去」')
  assert.equal(out.r.changed, false)
  assert.equal(out.stillOn, true, '没写进配置就别改状态（下一轮照样收播报，符合事实）')
})


