/**
 * 2026-10-06 审计修复的回归测试。
 *
 * 每条都带「修复前会怎样」的反证，防止以后改回去。
 * 手法：读源码抽函数 + `new Function` 跑 —— 入口模块 import 了框架的
 * `lib/puppeteer`、`#utils`，直接 import 会抛。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const P = path.resolve(HERE, '..')

const read = f => fs.readFileSync(path.join(P, f), 'utf8')

/** 抽出一个 `const NAME = ...` 到匹配的结尾（支持箭头函数/对象字面量） */
function extractConst (source, name) {
  const start = source.indexOf(`const ${name} = `)
  if (start < 0) return null
  const i = source.indexOf('=', start) + 1
  let depth = 0
  let started = false
  for (let j = i; j < source.length; j++) {
    const c = source[j]
    if (c === '{' || c === '(' || c === '[') { depth++; started = true } else if (c === '}' || c === ')' || c === ']') {
      depth--
      if (started && depth === 0) {
        // 吃掉可能的分号
        let end = j + 1
        while (source[end] === ';') end++
        return source.slice(start, end)
      }
    }
  }
  return null
}

/** 抽出一个 function 声明 */
function extractFunction (source, name) {
  const start = source.indexOf(`function ${name} (`)
  if (start < 0) return null
  const i = source.indexOf('{', start)
  let depth = 0
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}') { depth--; if (!depth) return source.slice(start, j + 1) }
  }
  return null
}

/** 去掉行注释与块注释，避免「注释里提到了旧写法」被误判成还在用 */
function stripComments (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/* ══════════════════════════════════════════════════════════════
 * 修复 1：campImDeploy 的待处理条数必须用 queue.length，不是 queue.lastId
 * ══════════════════════════════════════════════════════════════ */
describe('营地消息面板：待处理条数', () => {
  it('源码里不再把 lastId 当条数（campImDeploy）', () => {
    const src = stripComments(read('apps/campImDeploy.js'))
    assert.ok(!/queue\.lastId/.test(src), 'campImDeploy.js 又在用 queue.lastId 当条数了')
    assert.ok(/queue\?\.length/.test(src), 'campImDeploy.js 应该用 queue.length')
  })

  it('campIm.js 与 campImDeploy.js 两处保持一致（都用 length）', () => {
    const a = stripComments(read('apps/campIm.js'))
    const b = stripComments(read('apps/campImDeploy.js'))
    assert.ok(/queue\?\.length/.test(a), 'campIm.js 应该用 queue.length')
    assert.ok(/queue\?\.length/.test(b), 'campImDeploy.js 应该用 queue.length')
    assert.ok(!/queue\.lastId/.test(a), 'campIm.js 不该用 lastId 当条数')
  })

  it('反证：真实服务端返回里 lastId 是个天文数字，绝不能当条数显示', () => {
    // 实测 curl http://127.0.0.1:8900/api/status 的形状
    const queue = { length: 0, lastId: 1791220064781 }
    const correct = Number(queue.length || 0)
    const wrong = Number(queue.lastId || 0)
    assert.equal(correct, 0)
    assert.ok(wrong > 1e12, 'lastId 是消息序号（毫秒时间戳起步），跟条数不是一个量纲')
  })
})

/* ══════════════════════════════════════════════════════════════
 * 修复 2：isOurProcess 必须按路径段比，server-im 不能被当成 server
 * ══════════════════════════════════════════════════════════════ */
describe('isOurProcess 路径段匹配', () => {
  const src = read('utils/pm2.js')
  const fnSrc = extractFunction(src, 'isOurProcess')
  const isOurProcess = new Function(`${fnSrc}; return isOurProcess`)()

  const mk = (cwd, script) => ({ pm2_env: { pm_cwd: cwd, pm_exec_path: script } })

  it('自己的目录 → true', () => {
    assert.equal(isOurProcess(mk('/root/JiuLi/plugins/GloryOfKings-Plugin/server'), '/root/JiuLi/plugins/GloryOfKings-Plugin/server'), true)
  })

  it('目录内的文件 → true', () => {
    assert.equal(isOurProcess(mk('/root/JiuLi/plugins/GloryOfKings-Plugin/server/lib'), '/root/JiuLi/plugins/GloryOfKings-Plugin/server'), true)
  })

  it('反证：server-im 不能被当成 server（前缀匹配的老 bug）', () => {
    assert.equal(
      isOurProcess(mk('/root/JiuLi/plugins/GloryOfKings-Plugin/server-im'), '/root/JiuLi/plugins/GloryOfKings-Plugin/server'),
      false,
      'server-im 的 cwd 以 server 开头，但它们是并排的两个目录，不能算同一个'
    )
  })

  it('反证：server-v2 / serverX 同样不能被当成 server', () => {
    for (const dir of ['server-v2', 'serverX', 'server.bak']) {
      assert.equal(
        isOurProcess(mk(`/root/JiuLi/plugins/GloryOfKings-Plugin/${dir}`), '/root/JiuLi/plugins/GloryOfKings-Plugin/server'),
        false,
        `${dir} 不该算 server`
      )
    }
  })

  it('反向也成立：server 不能被当成 server-im', () => {
    assert.equal(
      isOurProcess(mk('/root/JiuLi/plugins/GloryOfKings-Plugin/server'), '/root/JiuLi/plugins/GloryOfKings-Plugin/server-im'),
      false
    )
  })

  it('Windows 反斜杠也要认', () => {
    assert.equal(
      isOurProcess(mk('C:\\Yunzai\\plugins\\GloryOfKings-Plugin\\server'), 'C:/Yunzai/plugins/GloryOfKings-Plugin/server'),
      true
    )
  })

  it('脚本路径命中也算（cwd 为空时）', () => {
    assert.equal(
      isOurProcess(mk('', '/root/JiuLi/plugins/GloryOfKings-Plugin/server/watch-server.js'), '/root/JiuLi/plugins/GloryOfKings-Plugin/server'),
      true
    )
  })

  it('空进程 / 空目录 → false', () => {
    assert.equal(isOurProcess(null, '/x/server'), false)
    assert.equal(isOurProcess(mk('/x/server'), ''), false)
  })
})

/* ══════════════════════════════════════════════════════════════
 * 修复 3：watchEnv 必须注入控制面端口，但排除播放面端口
 * ══════════════════════════════════════════════════════════════ */
describe('watchEnv 注入控制面端口', () => {
  const src = read('apps/watchDeploy.js')

  it('源码里确实注入了 GOK_WATCH_CTRL_PORT', () => {
    assert.ok(/GOK_WATCH_CTRL_PORT/.test(src), 'watchEnv 应该注入 GOK_WATCH_CTRL_PORT')
  })

  it('排除了播放面端口（否则控制面会撞端口起不来）', () => {
    assert.ok(/port !== PLAYBACK_PORT/.test(src), '应排除 PLAYBACK_PORT')
  })

  it('PLAYBACK_PORT 只声明一次（避免 TDZ / 重复声明）', () => {
    const decls = src.match(/const PLAYBACK_PORT = \d+/g) || []
    assert.equal(decls.length, 1, `PLAYBACK_PORT 应只声明一次，实际 ${decls.length} 次`)
  })

  it('PLAYBACK_PORT 声明在 watchEnv 之前（TDZ 检查）', () => {
    const declAt = src.indexOf('const PLAYBACK_PORT')
    const useAt = src.indexOf('port !== PLAYBACK_PORT')
    assert.ok(declAt > 0 && useAt > 0)
    assert.ok(declAt < useAt, 'PLAYBACK_PORT 必须先声明再使用')
  })

  it('服务端确实读这个变量名（对齐 server/watch-server.js）', () => {
    const server = fs.readFileSync(path.join(P, 'server/watch-server.js'), 'utf8')
    assert.ok(/process\.env\.GOK_WATCH_CTRL_PORT/.test(server), '服务端读的变量名要对得上')
  })
})

/* ══════════════════════════════════════════════════════════════
 * 修复 4：whoIsPlaying 收尾只给「真刷到的人」续期
 * ══════════════════════════════════════════════════════════════ */
describe('whoIsPlaying 现刷门限', () => {
  const src = read('apps/whoIsPlaying.js')

  it('引入了 refreshed 集合，收尾不再遍历 out', () => {
    assert.ok(/const refreshed = new Set\(\)/.test(src), '应有 refreshed 集合')
    assert.ok(/for \(const qq of refreshed\)/.test(src), '收尾应遍历 refreshed')
    assert.ok(!/for \(const \[qq, patch\] of out\)/.test(src), '不能再用 out 收尾（那会把复用者也续期）')
  })

  it('只有真写进 out 的才加入 refreshed', () => {
    // out.set 与 refreshed.add 必须挨在一起
    const block = src.match(/if \(Object\.keys\(patch\)\.length\) \{[\s\S]{0,120}?\}/)
    assert.ok(block, '应有一段「有内容才写入」的判断')
    assert.ok(/out\.set\(qq, patch\)/.test(block[0]), '要写进 out')
    assert.ok(/refreshed\.add\(qq\)/.test(block[0]), '同时要记进 refreshed')
  })
})

/* ══════════════════════════════════════════════════════════════
 * 修复 5：campImStore 状态锚 globalThis（根除多实例，同时保住裁剪）
 * ══════════════════════════════════════════════════════════════ */
describe('campImStore 单例与裁剪', () => {
  const src = read('utils/campImStore.js')

  it('cache 锚在 globalThis，不再是模块级 let', () => {
    assert.ok(/globalThis\[CACHE_KEY\]/.test(src), 'cache 要锚在 globalThis')
    assert.ok(!/^let cache = null$/m.test(src), '不能再有模块级 cache')
  })

  it('save 整份覆盖 state.cache，且不再读盘合并', () => {
    const saveFn = extractFunction(src, 'save')
    assert.ok(saveFn, '应能抽到 save')
    assert.ok(/writeYamlFile\(FILE, state\.cache\)/.test(saveFn), 'save 应整份写 state.cache')
    // 这条是关键：一旦 save 里「与盘上合并」，被裁掉的过期键会被捞回来，文件无限涨
    assert.ok(!/readYamlFile/.test(saveFn), 'save 不该读盘（合并会破坏 TTL/上限裁剪）')
  })

  it('TTL/上限裁剪逻辑仍在', () => {
    assert.ok(/REF_MAX/.test(src) && /SEEN_MAX/.test(src), '裁剪常量应保留')
    assert.ok(/c\.refs = Object\.fromEntries/.test(src), 'refs 应仍有裁剪')
    assert.ok(/c\.seen = Object\.fromEntries/.test(src), 'seen 应仍有裁剪')
  })

  it('invalidate 清的是 state.cache', () => {
    const st = src.indexOf('export function invalidate')
    const fn = src.slice(st, st + 200)
    assert.ok(/state\.cache = null/.test(fn), 'invalidate 应清 state.cache')
  })

  it('反证：单例之后两代共享同一份内存（不再互相抹）', () => {
    // 复刻锚定语义：同一个 holder，两次「加载」拿到同一个对象
    const holder = {}
    const load = () => (holder.cache ||= { cursor: 0, seen: {}, refs: {} })
    const A = load()
    const B = load()
    assert.equal(A, B, '两代应拿到同一份内存')

    A.seen['1111'] = 1
    B.seen['2222'] = 2
    A.seen['3333'] = 3
    assert.deepEqual(Object.keys(load().seen).sort(), ['1111', '2222', '3333'],
      '共享内存后三条键都在（旧的多实例会互相抹掉）')
  })

  it('反证：游标不会被旧链推回去（共享同一份）', () => {
    const holder = {}
    const load = () => (holder.cache ||= { cursor: 1000 })
    const setCursor = n => { const c = load(); if (n <= c.cursor) return; c.cursor = n }
    const D = load(); setCursor(5000)
    const C = load(); setCursor(4000)
    assert.equal(load().cursor, 5000, '游标应保持 5000（旧的多实例会退回 4000）')
    assert.equal(C, D)
  })
})

/* ══════════════════════════════════════════════════════════════
 * 修复 6：轮询状态锚在 globalThis + 有 onUnload
 * ══════════════════════════════════════════════════════════════ */
describe('热重载定时器泄漏', () => {
  it('campIm 的轮询状态锚在 globalThis', () => {
    const src = read('apps/campIm.js')
    assert.ok(/globalThis\[POLL_STATE_KEY\]/.test(src), 'pollState 要锚在 globalThis')
    assert.ok(!/^let pollTimer = null$/m.test(src), '不能再有模块级 pollTimer')
    assert.ok(!/^let polling = false$/m.test(src), '不能再有模块级 polling')
  })

  it('campIm 的幂等锁看的是 globalThis 上的 timer', () => {
    const src = read('apps/campIm.js')
    const startFn = extractFunction(src, 'startPolling')
    assert.ok(/if \(pollState\.timer\) return/.test(startFn), '幂等锁要看 pollState.timer')
  })

  it('campIm 与 cacheManager 都实现了 onUnload', () => {
    for (const f of ['apps/campIm.js', 'apps/cacheManager.js']) {
      const src = read(f)
      assert.ok(/async onUnload \(\)/.test(src), `${f} 应有 onUnload`)
    }
  })

  it('每个文件仍只有一个导出类（index.js 只取第一个导出）', () => {
    for (const f of ['apps/campIm.js', 'apps/cacheManager.js']) {
      const src = read(f)
      const classes = src.match(/^export class /gm) || []
      assert.equal(classes.length, 1, `${f} 应只有 1 个导出类，实际 ${classes.length} 个`)
    }
  })

  it('onUnload 里确实调了清理', () => {
    const campIm = read('apps/campIm.js')
    const unload = campIm.slice(campIm.indexOf('async onUnload ()'))
    assert.ok(/stopPolling\(\)/.test(unload.slice(0, 300)), 'campIm.onUnload 应调 stopPolling')

    const cm = read('apps/cacheManager.js')
    const unloadCm = cm.slice(cm.indexOf('async onUnload ()'))
    assert.ok(/clearTimeout\(cleanState\.bootTimer\)/.test(unloadCm.slice(0, 300)), 'cacheManager.onUnload 应清定时器')
  })
})

/* ══════════════════════════════════════════════════════════════
 * 修复 8：flattenMsg 的 text 段取第一个非空值（不再被空串截断）
 * ══════════════════════════════════════════════════════════════ */
describe('引用消息拍平', () => {
  const src = read('utils/quoted.js')
  const flattenMsg = new Function(`${extractFunction(src, 'flattenMsg')}; return flattenMsg`)()

  it('标准 OneBot 形状（data.text）能取到', () => {
    assert.equal(flattenMsg({ message: [{ type: 'text', data: { text: '你好' } }] }), '你好')
  })

  it('顶层 text 形状能取到', () => {
    assert.equal(flattenMsg({ message: [{ type: 'text', text: '你好' }] }), '你好')
  })

  it('反证：text 为空串时不能丢掉 data.text', () => {
    assert.equal(
      flattenMsg({ message: [{ type: 'text', text: '', data: { text: '实际内容' } }] }),
      '实际内容',
      '`??` 会停在空串上，必须用 `||`'
    )
  })

  it('反证：text 为 null 时同样要落到 data.text', () => {
    assert.equal(flattenMsg({ message: [{ type: 'text', text: null, data: { text: '有值' } }] }), '有值')
  })

  it('各种垃圾输入不抛', () => {
    for (const bad of [null, undefined, {}, { message: {} }, { message: [] }, [], 0, '']) {
      assert.doesNotThrow(() => flattenMsg(bad), `flattenMsg(${JSON.stringify(bad)}) 不该抛`)
    }
  })

  it('混合多段与非文本段', () => {
    assert.equal(
      flattenMsg({ message: [{ type: 'text', text: 'A' }, { type: 'image', file: 'x' }, { type: 'text', text: 'B' }] }),
      'AB'
    )
    assert.equal(flattenMsg({ message: [{ type: 'image' }] }), '')
  })

  it('raw_message 与字符串 message 优先', () => {
    assert.equal(flattenMsg({ raw_message: '原文', message: [{ type: 'text', text: 'x' }] }), '原文')
    assert.equal(flattenMsg({ message: '整段字符串' }), '整段字符串')
  })
})

describe('战绩详情图：缺字段不再整图崩', () => {
  const src = read('utils/battleDetailImage.js')

  it('renderBattleDetail 里有 normalizeRole', () => {
    const fn = src.slice(src.indexOf('export async function renderBattleDetail'))
    assert.ok(/const normalizeRole = role =>/.test(fn.slice(0, 2500)), '应有 normalizeRole')
  })

  it('传给模板的是补过骨架的那两份', () => {
    assert.ok(/getTeamData\(myTeam, enemyTeam, myRolesSafe, enemyRolesSafe/.test(src), 'getTeamData 要传 Safe 版')
    assert.ok(/getMeData\(myRolesSafe, head\)/.test(src), 'getMeData 要传 Safe 版')
  })

  it('骨架补齐了模板裸访问的全部中间层', () => {
    const m = src.match(/const normalizeRole = role => \{[\s\S]*?\n  \}/)
    assert.ok(m, '应能抽到 normalizeRole')
    const body = m[0]
    for (const field of ['basicInfo', 'battleStats', 'battleRecords', 'usedHero', 'skill', 'finalEquips']) {
      assert.ok(new RegExp(field).test(body), `normalizeRole 应处理 ${field}`)
    }
    assert.ok(/Array\.isArray\(br\.finalEquips\)/.test(body), 'finalEquips 要给数组')
  })

  it('normalizeRole 不炸在 null / 非对象上', () => {
    const m = src.match(/const normalizeRole = role => \{[\s\S]*?\n  \}/)
    const normalizeRole = new Function(`${m[0]}; return normalizeRole`)()
    for (const bad of [null, undefined, 0, '', 'str', []]) {
      assert.doesNotThrow(() => normalizeRole(bad), `normalizeRole(${JSON.stringify(bad)}) 不该抛`)
    }
    const r = normalizeRole({})
    assert.deepEqual(r.basicInfo, {})
    assert.deepEqual(r.battleStats, {})
    // battleRecords 会被补成含三个子字段的对象（不是空对象）
    assert.deepEqual(r.battleRecords.usedHero, {})
    assert.deepEqual(r.battleRecords.skill, {})
    assert.deepEqual(r.battleRecords.finalEquips, [])
  })

  it('normalizeRole 保留已有数据，不覆盖成空', () => {
    const m = src.match(/const normalizeRole = role => \{[\s\S]*?\n  \}/)
    const normalizeRole = new Function(`${m[0]}; return normalizeRole`)()
    const input = {
      basicInfo: { roleName: '张三', isMe: true },
      battleStats: { gradeGame: 11.1, killCnt: 9 },
      battleRecords: { usedHero: { heroName: '孙尚香' }, finalEquips: [{ equipId: 1 }], skill: { skillIcon: 'x.png' } }
    }
    const out = normalizeRole(input)
    assert.equal(out.basicInfo.roleName, '张三')
    assert.equal(out.battleStats.gradeGame, 11.1)
    assert.equal(out.battleRecords.usedHero.heroName, '孙尚香')
    assert.equal(out.battleRecords.finalEquips.length, 1)
    assert.equal(out.battleRecords.skill.skillIcon, 'x.png')
  })

  it('反证：真实模板 + 缺 battleStats 的数据，补骨架前后行为不同', () => {
    // 只验证「模板确实会崩」这个前提（用最小片段，不依赖 puppeteer）
    // 完整模板渲染在 test/homepageData.test.mjs 之外的实验里做过
    const tplSrc = read('resources/html/QueryGameRecordDetails.html')
    assert.ok(/\{\{item\.battleStats\.gradeGame\}\}/.test(tplSrc), '模板确实裸访问 battleStats.gradeGame')
    assert.ok(/\{\{item\.battleRecords\.skill\.skillIcon\}\}/.test(tplSrc), '模板确实裸访问 skill.skillIcon')
  })
})

/* ══════════════════════════════════════════════════════════════
 * 修复 8：shareStore 状态锚 globalThis（跨代次不再互相抹缓存）
 * ══════════════════════════════════════════════════════════════ */
describe('shareStore 跨代次状态', () => {
  const src = read('utils/shareStore.js')

  it('Map 类状态全部锚在 globalThis', () => {
    for (const name of ['inflight', 'knownShared', 'lastReconcileAt', 'memoryCache', 'generation', 'warnAt']) {
      assert.ok(new RegExp(`const ${name} = \\(holder\\.${name} \\|\\|= new Map\\(\\)\\)`).test(src),
        `${name} 应锚在 holder 上`)
    }
  })

  it('diskLoaded / flushTimer 走 holder', () => {
    assert.ok(/holder\.diskLoaded/.test(src), 'diskLoaded 应走 holder')
    assert.ok(/holder\.flushTimer/.test(src), 'flushTimer 应走 holder')
    assert.ok(!/^let diskLoaded/m.test(src) && !/^let flushTimer/m.test(src), '不该再有模块级 let')
  })

  it('circuit 也锚定（熔断状态不该每代次重置）', () => {
    assert.ok(/const circuit = \(holder\.circuit \|\|=/.test(src))
  })

  it('反证：单例后两代共享同一份 memoryCache', () => {
    const holder = {}
    const load = () => (holder.memoryCache ||= new Map())
    const A = load()
    const B = load()
    assert.equal(A, B, '两代应共享同一份 Map')
    A.set('111111', { campId: 'x' })
    assert.ok(B.has('111111'), 'A 写的 B 应该看得到')
    // 旧的「A 拿自己那份整份覆盖写盘」会抹掉 B 独有的条目（实测抹掉了 444444）
    B.set('444444', { campId: 'y' })
    const written = [...load().entries()].map(([k]) => k).sort()
    assert.deepEqual(written, ['111111', '444444'], '两边写的都要在')
  })

  it('flushDiskCache 仍是整份覆盖（锚定后才正确）', () => {
    const st = src.indexOf('function flushDiskCache')
    const fn = src.slice(st, st + 1200)
    assert.ok(/writeYamlFile\(CACHE_FILE, \{ schema: CACHE_SCHEMA, savedAt: now, entries \}\)/.test(fn),
      '应整份覆盖写')
    assert.ok(!/readYamlFile/.test(fn), '不该读盘合并')
  })
})

/* ══════════════════════════════════════════════════════════════
 * 修复 9：formatStarChange 段位方向（掉段不再报升段）
 * ══════════════════════════════════════════════════════════════ */
describe('段位变化方向', () => {
  const src = read('utils/pushStore.js')
  const st = src.indexOf('export function formatStarChange')
  const body = src.slice(st, st + 3000)
  const fnText = body.slice(0, body.indexOf('\n}\n') + 3).replace(/^export /, '')

  const toInt = v => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0 }
  const rankBand = name => {
    const n = String(name || '').trim()
    const B = [[/青铜/, 1], [/白银/, 2], [/黄金/, 3], [/铂金|白金/, 4], [/钻石/, 5], [/星耀/, 6], [/王者/, 7]]
    return B.find(([re]) => re.test(n))?.[1] || 0
  }
  const formatStarChange = new Function('toInt', 'rankBand', `${fnText}; return formatStarChange`)(toInt, rankBand)

  it('掉大段判 down', () => {
    const r = formatStarChange({ jobFrom: '绝世王者', jobTo: '永恒钻石II', starFrom: 12, starTo: 3 })
    assert.equal(r.tone, 'down')
    assert.equal(r.icon, '📉')
  })

  it('真实群报案例：荣耀王者 → 至尊星耀III 是掉段', () => {
    assert.equal(formatStarChange({ jobFrom: '荣耀王者', jobTo: '至尊星耀III', starFrom: 30, starTo: 1 }).tone, 'down')
  })

  it('真实群报案例：至尊星耀II → 最强王者 是升段', () => {
    assert.equal(formatStarChange({ jobFrom: '至尊星耀II', jobTo: '最强王者', starFrom: 4, starTo: 0 }).tone, 'up')
  })

  it('掉两级 / 掉一级都是 down', () => {
    assert.equal(formatStarChange({ jobFrom: '星耀III', jobTo: '荣耀黄金II', starFrom: 2, starTo: 1 }).tone, 'down')
    assert.equal(formatStarChange({ jobFrom: '非凡王者', jobTo: '至尊星耀I', starFrom: 5, starTo: 2 }).tone, 'down')
  })

  it('同大段不同写法标 flat（判不出方向就不冒充升段）', () => {
    assert.equal(formatStarChange({ jobFrom: '最强王者', jobTo: '荣耀王者', starFrom: 10, starTo: 12 }).tone, 'flat')
  })

  it('源码里那段写死的 tone:up 已改掉', () => {
    const seg = src.slice(st, st + 1200)
    assert.ok(!/if \(jobFrom !== jobTo\) \{\s*\n\s*return \{ text: `段位/.test(seg), '不能无条件返回 up')
    assert.ok(/rankBand\(jobFrom\)/.test(seg) && /rankBand\(jobTo\)/.test(seg), '要用 rankBand 比层级')
  })

  it('同小段升降不受影响', () => {
    assert.equal(formatStarChange({ jobFrom: '永恒钻石II', jobTo: '永恒钻石II', starFrom: 2, starTo: 4 }).tone, 'up')
    assert.equal(formatStarChange({ jobFrom: '永恒钻石II', jobTo: '永恒钻石II', starFrom: 4, starTo: 1 }).tone, 'down')
  })
})

/* ══════════════════════════════════════════════════════════════
 * 修复 10：whoIsPlaying 时长量纲（秒 vs 毫秒）
 * ══════════════════════════════════════════════════════════════ */
describe('「谁在打游戏」时长', () => {
  const src = read('apps/whoIsPlaying.js')
  const durationText = new Function(`${extractFunction(src, 'durationText')}; return durationText`)()

  it('12 分钟前开局 → 12 分钟', () => {
    const now = Math.floor(Date.now() / 1000)
    assert.equal(durationText(now - 12 * 60, now), '12 分钟')
  })

  it('3 小时前开局 → 3 小时', () => {
    const now = Math.floor(Date.now() / 1000)
    assert.equal(durationText(now - 3 * 3600, now), '3 小时')
  })

  it('30 秒前 → 刚开始', () => {
    const now = Math.floor(Date.now() / 1000)
    assert.equal(durationText(now - 30, now), '刚开始')
  })

  it('30 小时前（脏数据）→ 空串', () => {
    const now = Math.floor(Date.now() / 1000)
    assert.equal(durationText(now - 30 * 3600, now), '')
  })

  it('反证：秒的 since 配毫秒的 now 必然返回空串（修复前的行为）', () => {
    const nowMs = Date.now()
    const sinceSec = Math.floor(nowMs / 1000) - 12 * 60
    assert.equal(durationText(sinceSec, nowMs), '', '跨量纲相减会撞「>1天」守卫')
  })

  it('调用方把 now 折成秒再传', () => {
    assert.ok(/const nowSec = Math\.floor\(now \/ 1000\)/.test(src), '应有 nowSec')
    assert.ok(/durationText\(Number\(sub\?\.lastGamingStartSnap\) \|\| 0, nowSec\)/.test(src), 'gamingFor 用 nowSec')
    assert.ok(/durationText\(Number\(sub\?\.onlineSince\) \|\| 0, nowSec\)/.test(src), 'onlineFor 用 nowSec')
  })
})

/* ══════════════════════════════════════════════════════════════
 * 修复 11：快照不抢写推送游标（发送失败的那局不能丢）
 * ══════════════════════════════════════════════════════════════ */
describe('快照与推送游标分家', () => {
  const src = read('utils/pushStore.js')

  it('observeSnapshot 不再写 lastGamingStart / lastGameSeq', () => {
    const st = src.indexOf('function observeSnapshot')
    const fn = src.slice(st, st + 5000)
    assert.ok(!/patch\.lastGamingStart =/.test(fn), '不该再写推送游标 lastGamingStart')
    assert.ok(!/patch\.lastGameSeq =/.test(fn), '不该再写推送游标 lastGameSeq')
    assert.ok(/patch\.lastGamingStartSnap =/.test(fn), '应改写快照专用字段')
  })

  it('startingNewGame 比的是快照字段', () => {
    assert.ok(/lastGamingStartSnap/.test(extractFunction(src, 'startingNewGame')))
  })

  it('whoIsPlaying 出图读快照字段', () => {
    assert.ok(/lastGamingStartSnap/.test(read('apps/whoIsPlaying.js')))
  })

  it('盯梢去重优先快照字段（带旧字段兜底）', () => {
    assert.ok(/sub\.lastGamingStartSnap \|\| sub\.lastGamingStart/.test(read('apps/gameRecordPush.js')))
  })

  it('订阅 / 换号重置时两个字段一起种', () => {
    const g = read('apps/gameRecordPush.js')
    const hits = g.match(/lastGamingStartSnap: String\(data\.gaming\?\.dtEventTime \|\| ''\)/g) || []
    assert.ok(hits.length >= 2, `订阅与换号都要种快照字段，实际 ${hits.length} 处`)
  })

  it('反证：发送失败后那局仍在待推列表（修复前第 N+1 轮会变空）', () => {
    const toInt = v => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0 }
    const st = src.indexOf('export function pickNewBattles')
    const body = src.slice(st, st + 2500)
    const pick = new Function('toInt', `${body.slice(0, body.indexOf('\n}\n') + 3).replace(/^export /, '')}; return pickNewBattles`)(toInt)

    const list = [{ gameSeq: '1001', dtEventTime: 1791200000 }]
    const sub = { lastGameSeq: '1000', lastGameTime: '1791199400', lastGamingStartSnap: '1791199000' }
    // 修复后的快照 patch 只有快照字段；checkBattle 因 send 失败不写游标
    const after = { ...sub, lastGamingStartSnap: '1791200600' }
    assert.equal(after.lastGameSeq, '1000', '游标不该被快照推进')
    assert.equal(pick(list, after).length, 1, '发送失败的那局必须还在待推列表里')
  })
})

/* ══════════════════════════════════════════════════════════════
 * 修复 12：群报成员范围不跨群
 * ══════════════════════════════════════════════════════════════ */
describe('群报成员范围', () => {
  const store = read('utils/groupReportStore.js')
  const app = read('apps/groupReport.js')

  it('空名单不再等于「不过滤」', () => {
    const st = store.indexOf('export function resolveGroupTargets')
    const fn = store.slice(st, st + 1600)
    assert.ok(/if \(!noFilter && !memberSet\.has\(item\.botUserId\)\) continue/.test(fn), '空集合必须谁都不匹配')
    assert.ok(!/memberSet\.size &&/.test(fn), '旧的 memberSet.size 判据必须删掉')
  })

  it('保留了显式「不过滤」入口', () => {
    assert.ok(/noFilter = false/.test(store), '应有 noFilter 参数')
  })

  it('降级名单认全 subGroups（含 groups[]）', () => {
    assert.ok(/subGroups\(sub\)\.includes\(String\(groupId\)\)/.test(app), '降级名单要用 subGroups')
    assert.ok(!/String\(sub\?\.group \|\| ''\) === String\(groupId\)/.test(app), '旧的只看单值 group 的写法必须删掉')
  })

  it('subGroups 已 import', () => {
    assert.ok(/import \{[^}]*subGroups[^}]*\} from '\.\.\/utils\/pushStore\.js'/.test(app), '要 import subGroups')
  })

  it('反证：空名单 → 0 个目标（旧写法会返回全服）', () => {
    const oldResolve = (memberIds = []) => {
      const s = new Set(memberIds.map(String))
      return [{ botUserId: '1' }, { botUserId: '2' }, { botUserId: '3' }].filter(i => !(s.size && !s.has(i.botUserId)))
    }
    const newResolve = (memberIds = [], noFilter = false) => {
      const s = new Set(memberIds.map(String))
      return [{ botUserId: '1' }, { botUserId: '2' }, { botUserId: '3' }].filter(i => noFilter || s.has(i.botUserId))
    }
    assert.equal(oldResolve([]).length, 3, '旧写法确实放行全部')
    assert.equal(newResolve([]).length, 0, '新写法谁都不匹配')
    assert.equal(newResolve(['2']).length, 1, '正常过滤仍工作')
    assert.equal(newResolve([], true).length, 3, '显式 noFilter 才不过滤')
  })
})

/* ══════════════════════════════════════════════════════════════
 * 修复 13：subGroups 排除 0 / 负数
 * ══════════════════════════════════════════════════════════════ */
describe('subGroups 假群号', () => {
  const src = read('utils/pushStore.js')
  const st = src.indexOf('export function subGroups')
  const body = src.slice(st, st + 900)
  const subGroups = new Function(`${body.slice(0, body.indexOf('\n}\n') + 3).replace(/^export /, '')}; return subGroups`)()

  it('反证：group:0 不再变成 "0"', () => {
    assert.deepEqual(subGroups({ group: 0, groups: [1, 2] }), ['1', '2'])
    assert.deepEqual(subGroups({ group: 0 }), [])
    assert.deepEqual(subGroups({ group: '0' }), [])
  })

  it('负数也排除', () => {
    assert.deepEqual(subGroups({ group: -5, groups: [7] }), ['7'])
  })

  it('正常群号不受影响，且去重', () => {
    assert.deepEqual(subGroups({ group: 575663150, groups: [972915804, 575663150] }), ['575663150', '972915804'])
  })

  it('空 / null 照旧返回空数组', () => {
    assert.deepEqual(subGroups({}), [])
    assert.deepEqual(subGroups({ group: null }), [])
    assert.deepEqual(subGroups(null), [])
  })
})

/* ══════════════════════════════════════════════════════════════
 * 修复 14：皮肤预告不吞上线当天
 * ══════════════════════════════════════════════════════════════ */
describe('皮肤推送去重键', () => {
  const src = read('utils/skinNews.js')
  const st = src.indexOf('export function markSkinNewsPushed')
  const body = src.slice(st, st + 700)
  const mark = new Function(`${body.slice(0, body.indexOf('\n}\n') + 3).replace(/^export /, '').replace(/saveSkinNewsStore\(store\)/, '')}; return markSkinNewsPushed`)()

  const today = '20261006'
  const collect = (store, todayList, upcoming) => {
    const pushed = new Set(store.pushed)
    const pushedOnline = id => pushed.has(`${id}@online`) || pushed.has(String(id))
    const pushedUpcoming = id => pushed.has(`${id}@upcoming`)
    return [...todayList, ...upcoming]
      .filter(skin => (skin.online === today ? !pushedOnline(skin.id) : !pushedUpcoming(skin.id)))
      .map(skin => ({ ...skin, isToday: skin.online === today }))
  }

  it('反证：预告过的皮肤上线当天要推出来', () => {
    const store = { pushed: [] }
    const r1 = collect(store, [{ id: 'TODAY1', online: today }], [{ id: 'FUTURE1', online: '20261010' }])
    mark(store, r1)
    assert.deepEqual(r1.map(s => s.id), ['TODAY1', 'FUTURE1'])
    assert.ok(store.pushed.includes('FUTURE1@upcoming'), '预告应记 @upcoming 键')

    const r2 = collect(store, [{ id: 'FUTURE1', online: today }, { id: 'TODAY2', online: today }], [])
    assert.deepEqual(r2.map(s => s.id).sort(), ['FUTURE1', 'TODAY2'], '上线当天必须推 FUTURE1')
  })

  it('上线推过之后不再重复推', () => {
    const store = { pushed: [] }
    mark(store, collect(store, [{ id: 'A', online: today }], []))
    assert.equal(collect(store, [{ id: 'A', online: today }], []).length, 0)
  })

  it('旧存档的裸 id 当成「上线推过」，不重复推', () => {
    const store = { pushed: ['OLD1'] }
    const items = collect(store, [{ id: 'OLD1', online: today }], [{ id: 'OLD2', online: '20261010' }])
    assert.deepEqual(items.map(s => s.id), ['OLD2'])
  })

  it('源码里键确实带了 @online / @upcoming', () => {
    assert.ok(/@online/.test(src) && /@upcoming/.test(src), '键要分两种')
  })
})

/* ══════════════════════════════════════════════════════════════
 * 修复 15：collectBattles 能分辨「拉取失败」与「确实翻完了」
 * ══════════════════════════════════════════════════════════════ */
describe('战绩归档失败可分辨', () => {
  const src = read('utils/battleArchive.js')

  it('有 failed 标记，抛错与非 0 码都置位', () => {
    assert.ok(/let failed = false/.test(src))
    const marks = src.match(/failed = true\s*\n\s*break/g) || []
    assert.ok(marks.length >= 2, `抛错和非 0 码都要置位，实际 ${marks.length} 处`)
  })

  it('返回值带上 incomplete 与 failed', () => {
    assert.ok(/incomplete,/.test(src), '应返回 incomplete')
    assert.ok(/failed\s*\n\s*\}/.test(src), '应返回 failed')
  })

  it('incomplete 判据是「请求了 from 却一页没拉到」', () => {
    assert.ok(/const incomplete = from > 0 && fetched === 0/.test(src))
  })

  it('反证：三种失败在修复前返回值无法分辨，修复后 failed 能区分', () => {
    const sim = (failed) => {
      const from = 1790623953
      const fetched = 0
      const finalMark = 0
      return {
        coveredFrom: finalMark > 0 ? Math.max(finalMark, from) : from,
        truncated: false,
        fetched,
        incomplete: from > 0 && fetched === 0,
        failed
      }
    }
    // 修复前：三者都是 {coveredFrom:from, truncated:false, fetched:0}，一模一样
    const throwCase = sim(true)
    const codeCase = sim(true)
    const emptyCase = sim(false)
    assert.equal(throwCase.failed, true)
    assert.equal(codeCase.failed, true)
    assert.equal(emptyCase.failed, false, '空列表是「确实翻完了」，不是失败')
    assert.equal(throwCase.incomplete, true, '一页没拉到 → 覆盖不足')
  })
})

/* ══════════════════════════════════════════════════════════════
 * 修复 16：pickNewBattles 缺 lastGameTime 不重推整页
 * ══════════════════════════════════════════════════════════════ */
describe('推送游标缺时间戳', () => {
  const src = read('utils/pushStore.js')
  const toInt = v => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0 }
  const st = src.indexOf('export function pickNewBattles')
  const body = src.slice(st, st + 2500)
  const pick = new Function('toInt', `${body.slice(0, body.indexOf('\n}\n') + 3).replace(/^export /, '')}; return pickNewBattles`)(toInt)

  const list = []
  for (let i = 0; i < 30; i++) list.push({ gameSeq: String(2000 - i), dtEventTime: 1791300000 - i * 900 })
  const cursorSeq = list[19].gameSeq

  it('反证：缺 lastGameTime 时按 seq 定位，不重推整页', () => {
    for (const bad of ['', 0, null, undefined]) {
      const n = pick(list, { lastGameSeq: cursorSeq, lastGameTime: bad }).length
      assert.equal(n, 19, `lastGameTime=${JSON.stringify(bad)} 应得 19 场，实际 ${n}`)
    }
  })

  it('游标已是最新 → 空', () => {
    assert.equal(pick(list, { lastGameSeq: list[0].gameSeq, lastGameTime: '' }).length, 0)
  })

  it('有正确时间戳时行为不变', () => {
    assert.equal(pick(list, { lastGameSeq: cursorSeq, lastGameTime: String(list[19].dtEventTime) }).length, 19)
  })

  it('游标翻出列表时保守返回全部（宁可多推不丢数据）', () => {
    assert.equal(pick(list, { lastGameSeq: '9999', lastGameTime: '' }).length, 30)
  })

  it('两个游标都空 → 空（刚订阅不推历史）', () => {
    assert.equal(pick(list, { lastGameSeq: '', lastGameTime: '' }).length, 0)
  })
})
