/**
 * `components/Config.js` 加载配置时**不能整份覆盖用户配置**。
 *
 * 这个文件钉两条曾经会「静默毁配置」的路径：
 *   ① `differences` 为真时原本先 `copyFileSync(模板 → 用户)` —— 值能靠写回救回来，
 *      **用户手写的注释全没了**
 *   ② `validateConfig` 抛错时原本只 `copyFileSync`、**没有写回** —— 用户所有设置
 *      （包括接入令牌）被模板整份盖掉，而且只在日志里留一行
 *
 * ⚠️ 测试用的临时目录**放在云崽根、不能放在插件目录内**：
 *    `Config.js` 要 import `chokidar`/`lodash`（pnpm 布局下挂在云崽根），
 *    临时目录放在云崽根下，往上找 node_modules 正好解析得到。
 *
 * ⚠️⚠️ **千万别改回插件目录内**（原先是 `<插件>/tmp-config-test/`）：
 *    JiuLi 的 file_watch 监听 `plugins/` 下的增删改，临时目录「建了又删」会被
 *    当成**插件被删除**，直接把整个 GloryOfKings-Plugin 卸载掉 ——
 *    实测 2026-09-27：跑完一轮测试后插件下线、规则从 1024 条掉到 1022 条，
 *    群里的 `#观战大神` 完全没反应，查了半天才发现是测试自己把插件踢了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 云崽根（`<云崽>/plugins/<插件>` 的上两级）—— 见文件头，临时目录绝不能落在插件里 */
const TMP = path.join(path.resolve(PLUGIN, '..', '..'), 'tmp-config-test')

/** 搭一个临时「插件」，把真 Config.js / YamlReader.js 和模板拷进去 */
function setup (userYaml) {
  // 防回归：临时目录一旦落回插件目录内，跑完这一轮就会把插件从 file_watch 眼里「删掉」
  // （见文件头那段实测）。这条断言比注释管用 —— 改回去会直接红。
  assert.ok(
    !TMP.startsWith(PLUGIN + path.sep),
    `临时目录不能放在插件目录内（会被热重载当成插件删除）：${TMP}`
  )
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(path.join(TMP, 'components'), { recursive: true })
  fs.mkdirSync(path.join(TMP, 'config', 'config'), { recursive: true })
  fs.mkdirSync(path.join(TMP, 'config', 'default_config'), { recursive: true })
  for (const f of ['Config.js', 'YamlReader.js', 'Path.js']) {
    fs.copyFileSync(path.join(PLUGIN, 'components', f), path.join(TMP, 'components', f))
  }
  for (const f of ['config.yaml', 'auth.yaml']) {
    fs.copyFileSync(path.join(PLUGIN, 'config', 'default_config', f), path.join(TMP, 'config', 'default_config', f))
  }
  const file = path.join(TMP, 'config', 'config', 'config.yaml')
  fs.writeFileSync(file, userYaml, 'utf8')
  return file
}

/** 在临时目录里 new 一个真实 Config（云崽的 logger/Bot 用桩顶上） */
function runConfig () {
  const script = path.join(TMP, 'run.mjs')
  fs.writeFileSync(script, [
    'globalThis.logger = { info(){}, warn(){}, error(){}, debug(){}, mark(){} }',
    'globalThis.Bot = { config: {} }',
    "const { default: Config } = await import('./components/Config.js')",
    'const cfg = Config.getDefOrConfig(\'config\')',
    'console.log(JSON.stringify({ onlineReminder: cfg.onlineReminder, token: cfg.distToken, cron: cfg.battleResultCron }))',
    // ⚠️ Config 读配置时会起 chokidar 文件监听，不显式退出进程会一直挂着
    'process.exit(0)',
    ''
  ].join('\n'), 'utf8')

  // ⚠️ 必须显式收 stderr：坏 YAML 用例里子进程会往 stderr 打一行，
  //    若让它继承就漏进测试输出、被 node:test 当成测试失败（实测踩过）
  const r = spawnSync(process.execPath, [script], {
    cwd: TMP, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  if (r.error) throw r.error
  return { ok: r.status === 0, stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim() }
}

test.afterEach = undefined
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }) })

test('Config：用户值与手写注释都要保住，缺失的新键要补默认值', () => {
  const file = setup([
    '# 用户自己写的备注：这行不能被吃掉',
    'onlineReminder: false',
    "battleResultCron: '0 */9 * * * *'",
    "distToken: 'gok_user_token_must_survive'",
    "shareApiUrl: 'https://user.example.com:442'"
  ].join('\n') + '\n')

  const out = runConfig()
  assert.ok(out.ok, out.stderr)

  const text = fs.readFileSync(file, 'utf8')
  const after = YAML.parse(text)
  assert.equal(after.distToken, 'gok_user_token_must_survive', '令牌被清空')
  assert.equal(after.onlineReminder, false, '用户值被模板盖掉')
  assert.equal(after.battleResultCron, '0 */9 * * * *')
  assert.equal(after.shareApiUrl, 'https://user.example.com:442')
  assert.ok(text.includes('用户自己写的备注'), '用户手写的注释被覆盖掉了')
  assert.ok('campImPollMs' in after, '缺失的新键没有补上默认值')
})

test('Config：注释没了**不会自动回来**（所以「别把注释弄丢」必须挡在写入侧）', () => {
  // 模拟「迁移用 stringify 把注释全干掉」之后的文件：有键值、零注释
  const file = setup([
    'onlineReminder: true',
    "battleResultCron: '0 */9 * * * *'",
    "distToken: 'gok_user_token_must_survive'",
    "shareApiUrl: 'https://user.example.com:442'",
    'quoteReply: false'
  ].join('\n') + '\n')
  const before = fs.readFileSync(file, 'utf8')
  assert.equal(before.split('\n').filter(l => l.startsWith('#')).length, 0, '前置条件：起始应无注释')

  // 启动一次
  const first = runConfig()
  assert.ok(first.ok, first.stderr)
  const after1 = fs.readFileSync(file, 'utf8')
  const comments1 = after1.split('\n').filter(l => l.startsWith('#')).length

  // 再启动一次：注释不该重复堆积
  const second = runConfig()
  assert.ok(second.ok, second.stderr)
  const after2 = fs.readFileSync(file, 'utf8')
  const comments2 = after2.split('\n').filter(l => l.startsWith('#')).length

  // 值一直不能被弄坏
  const parsed = YAML.parse(after2)
  assert.equal(parsed.distToken, 'gok_user_token_must_survive', '恢复过程中令牌丢了')
  assert.equal(parsed.battleResultCron, '0 */9 * * * *')
  assert.equal(parsed.quoteReply, false)

  // ⚠️ 钉住真实行为：Config 只会保证「值」正确，**不会把注释写回用户文件**。
  //    用户文件里的注释只来自两处：首次安装时从模板复制、以及它自己一直没被抹掉。
  //    （2026-09-20 实测：迁移用 YAML.stringify 抹掉 92 行注释之后，重启并不会补回来，
  //     只能靠「用模板文档套值」手动恢复一次。）
  //    所以「别丢注释」这件事必须挡在**写入侧**（迁移 / 任何写配置的代码都得用
  //    YAML.parseDocument 那套，别用 YAML.stringify）。这条断言就是那个结论的证据。
  assert.equal(comments1, 0, `注释竟然被自动补回了（${comments1} 行）——那这条断言的前提变了，回来更新`)
  assert.equal(comments2, 0, '第二次启动依然不该冒出注释')

  // 值在两次启动后必须完全一致
  const after2nd = YAML.parse(after2)
  assert.equal(after2nd.distToken, 'gok_user_token_must_survive')
})

test('Config：用户把 YAML 写坏了也不能让插件挂掉，值尽量保住', () => {
  // 故意写坏：缩进错乱的映射（YAML.parse 会抛）
  const file = setup([
    'onlineReminder: true',
    'blackList: [',
    '  - 123',
    "distToken: 'gok_user_token_must_survive'"
  ].join('\n') + '\n')

  const out = runConfig()
  // 关键：进程不能崩（一份坏配置不该拦住整个插件启动）
  assert.ok(out.ok, '配置写坏时插件启动崩了：' + out.stderr)

  // 坏 YAML 里在出错位置**之前**的键仍然能读到，要保住
  assert.match(out.stdout, /"onlineReminder":true/, '坏配置里能读到的值丢了：' + out.stdout)

  // 文件仍然是那份坏的（插件不会把它清空）；能解析到的键还在
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.includes('onlineReminder'), '配置文件被清空了')
})

test('Config：校验不通过时（缺必填项）用户的值也不能丢', () => {
  const file = setup([
    '# 用户自己写的备注',
    "distToken: 'gok_user_token_must_survive'",
    "shareApiUrl: 'https://user.example.com:442'"
  ].join('\n') + '\n')   // 故意不带 onlineReminder → validateConfig 会抛

  const out = runConfig()
  assert.ok(out.ok, out.stderr)

  const text = fs.readFileSync(file, 'utf8')
  const after = YAML.parse(text)
  assert.equal(after.distToken, 'gok_user_token_must_survive', '校验失败把令牌清掉了')
  assert.equal(after.shareApiUrl, 'https://user.example.com:442')
  assert.ok(text.includes('用户自己写的备注'), '校验失败把注释也盖了')
  // 必填项被补上（模板兜底）
  assert.equal(after.onlineReminder, true)
})
