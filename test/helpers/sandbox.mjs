/**
 * 单测的脚手架：在临时目录里**沙箱化**跑插件代码。
 *
 * ## 为什么需要它
 *
 * `utils/service.js` 和 `utils/dist.js` 里 import 了 `#components`（`Config` /
 * `PluginPath` / `PluginData`），而真正的 `Config` 依赖云崽运行时（`Bot`、全局
 * `logger`、chokidar / lodash）——直接 import 会当场抛。
 *
 * 所以用 Node 的 `--import` 钩子把 `#components` 这一个说明符换成一个假模块，
 * 再把插件源码原样拷进临时目录跑。好处：
 *   · 测的是**真实源码**，不是复制出来的片段
 *   · 不碰插件目录里的 config/（真配置里有真令牌，测试绝不该读它）
 *   · 每个用例一个新进程，互不干扰
 *
 * 被拷进沙箱的文件刻意写死成一份清单：将来 `utils/service.js` 多 import 一个模块时，
 * 这里会**当场报 ERR_MODULE_NOT_FOUND**，比「忘了更新测试却还是绿的」好得多。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const NODE = process.execPath

export const PLUGIN_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
)

/** service.js / dist.js 的静态 import 闭包。少一个就 Module Not Found */
const COPY_FILES = [
  'package.json',
  // ⚠️ 这里原先还列着 utils/platform.js、utils/dist.js、utils/service.js、
  //    utils/migrateConfig.js —— 这四个文件**从来没有进过仓库**
  //    （`git ls-tree 993b991 utils/` 里就没有，当前的 apps/ 与 utils/ 也没有任何
  //    源码 import 它们），于是 makeSandbox() 在 copyFileSync 处 ENOENT，
  //    把所有用它做沙箱的测试（authPool / campImDedup）一起带崩。
  //    当前测试用不到它们，摘掉即可恢复。
  'utils/deploy.js',
  // shareStore 的执行期闭包（用它验「地址/令牌的读法，两个消费方一致」）
  'utils/shareStore.js',
  'utils/yamlUtils.js',
  'utils/safeStore.js',
  'utils/localBind.js',
  'utils/authStore.js',
  // 营地消息的本地状态（test/campImDedup.test.mjs 用）
  'utils/campImStore.js',
  // 出图格式（test/imageType.test.mjs 用）
  'utils/imageType.js'
]

/** 测试用的假配置。地址/令牌都是假的，绝不碰真凭证 */
export const FAKE_CONFIG = {
  shareApiUrl: 'https://dist.test.invalid:8787',
  shareToken: '',
  distUrl: '',
  distToken: 'gok_1_fake_token_for_tests_only_000000',
  watchApiUrl: 'http://127.0.0.1:18899',
  campImApiUrl: 'http://127.0.0.1:18900',
  watchPublicUrl: ''
}

/** 生成一个沙箱目录 */
export function makeSandbox () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gok-test-'))

  for (const rel of COPY_FILES) {
    const dest = path.join(root, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(PLUGIN_DIR, rel), dest)
  }

  fs.mkdirSync(path.join(root, 'data', 'gok'), { recursive: true })
  fs.mkdirSync(path.join(root, 'config', 'config'), { recursive: true })
  fs.mkdirSync(path.join(root, 'config', 'default_config'), { recursive: true })

  // yaml 这种真依赖让它照常解析（链接到插件自己的 node_modules），
  // 而 #components / node-fetch 仍然由 loader 换成假模块。
  // 不这么做的话，凡是 import 了 yamlUtils 的模块（shareStore / authStore）在
  // 临时目录里都会 ERR_MODULE_NOT_FOUND。
  try {
    fs.symlinkSync(path.join(PLUGIN_DIR, 'node_modules'), path.join(root, 'node_modules'), 'dir')
  } catch {
    // 链接失败就算了：不碰 yaml 的测试照常能跑
  }

  // 但 chokidar / lodash 这类在 pnpm 布局下挂在**云崽根**，不在插件目录里。
  // 造一条父级链（plugins/ → 真插件目录），Node 就能按常规的「逐级向上找 node_modules」
  // 命中云崽根的那一份。少数需要真跑 components/Config.js 的测试靠它。
  try {
    const pluginsDir = path.join(root, 'plugins')
    fs.mkdirSync(pluginsDir, { recursive: true })
    fs.symlinkSync(PLUGIN_DIR, path.join(pluginsDir, 'GloryOfKings-Plugin'), 'dir')
    const rootDir = path.join(root, '..')
    fs.symlinkSync(path.resolve(PLUGIN_DIR, '..', '..'), path.join(pluginsDir, 'yunzai-root'), 'dir')
  } catch {
    // 建不出来也不影响其它测试
  }

  fs.writeFileSync(
    path.join(root, 'config', 'config', 'config.yaml'),
    'quoteReply: false\n',
    'utf8'
  )

  // 假的 #components：只提供被 import 到的那几个名字
  fs.writeFileSync(path.join(root, 'test-components.mjs'), [
    `import { fakeConfig } from './fake-config.mjs'`,
    `export const PluginPath = ${JSON.stringify(path.join(root, 'PluginRoot'))}`,
    `export const PluginData = ${JSON.stringify(path.join(root, 'PluginRoot', 'data'))}`,
    `export const PluginName = 'GloryOfKings-Plugin-Test'`,
    `export const Config = { getDefOrConfig: () => fakeConfig() }`,
    ''
  ].join('\n'), 'utf8')

  // ⚠️ 用「可改的内部状态 + setter」而不是直接导出变量：ESM 的命名空间对象是只读的，
  //    测试脚本里 `fake.fakeConfig = ...` 会直接抛 TypeError
  fs.writeFileSync(path.join(root, 'fake-config.mjs'), [
    `let cfg = ${JSON.stringify(FAKE_CONFIG)}`,
    'export function fakeConfig () { return { ...cfg } }',
    'export function setFakeConfig (next) { cfg = { ...cfg, ...next } }',
    ''
  ].join('\n'), 'utf8')

  // 假的 #utils（unit 测试目前用不到，留着防未来 import）
  fs.writeFileSync(path.join(root, 'test-utils.mjs'), 'export function shouldQuote () { return false }\n', 'utf8')

  // 假的 node-fetch：只保证 import 成功，被调用就抛（测试不该发真请求）
  fs.writeFileSync(path.join(root, 'test-node-fetch.mjs'), [
    'export default function fetch () { throw new Error("测试里不该发真请求") }',
    ''
  ].join('\n'), 'utf8')

  // 加载器钩子。两件事：
  //   ① `#components` / `#utils` 是 package.json 的 imports 别名，换成假模块
  //   ② test/ 底下没有 package.json（插件根那个带 "type":"module"），所以从
  //      test/xxx.test.mjs 相对 import 出来的 `../utils/foo.js` 会被当成 CommonJS、
  //      在 `export` 那里直接抛。这里的 `parentURL` 是 `import.meta.url`，
  //      过滤器统一映射到插件根，走 CJS 用的那个 .js 分支就正常了。
  //
  // ⚠️ node: 前缀的 specifier 的 parentURL 是 node:internal/…，用 URL 解析会抛，
  //    所以只处理我们关心的那几个字面前缀。
  fs.writeFileSync(path.join(root, 'test-loader.mjs'), `import { pathToFileURL } from 'node:url'

const MAP = {
  '#components': ${JSON.stringify(pathToFileURL(path.join(root, 'test-components.mjs')).href)},
  '#utils': ${JSON.stringify(pathToFileURL(path.join(root, 'test-utils.mjs')).href)},
  // shareStore 顶层 import 了 node-fetch；沙箱里没有 node_modules，给个假的
  // （这条测试只读配置，不会真的发请求）
  'node-fetch': ${JSON.stringify(pathToFileURL(path.join(root, 'test-node-fetch.mjs')).href)}
}

export async function resolve (specifier, context, nextResolve) {
  const hit = MAP[specifier]
  if (hit) return { url: hit, shortCircuit: true }
  return nextResolve(specifier, context)
}
`, 'utf8')

  // ⚠️ 钩子必须用 module.register 注册。`node --import <loader>` 是**不会**生效的
  //    （实测：钩子一次都不被调用，specifier 直接掉回默认解析），而 `--loader` 又已经
  //    废弃。所以拿 --import 跑这个小文件，由它去 register。
  fs.writeFileSync(path.join(root, 'test-register.mjs'), `import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./test-loader.mjs', pathToFileURL('./'))
`, 'utf8')

  return root
}


/** 把沙箱里 PluginRoot 的 data 目录建出来（service.js 会往里写 pid/日志） */
export function ensurePluginRoot (root) {
  fs.mkdirSync(path.join(root, 'PluginRoot', 'data', 'gok'), { recursive: true })
}

/**
 * 在沙箱里跑一段脚本。
 * @param {string} root 沙箱目录
 * @param {string} source 脚本内容（ESM）。可以是 async，可以用 test/*.mjs 里的 import
 * @returns {{ok: boolean, stdout: string, stderr: string, status: number|null}}
 */
export function run (root, source, { timeoutMs = 60_000 } = {}) {
  const script = path.join(root, 'case.mjs')
  fs.writeFileSync(script, source, 'utf8')
  // 脚本里要知道沙箱根（拼 PluginRoot 下的路径）。写文件比传 env 干净：
  // JS 字符串里引路径的转义太容易出错（Windows 的 \\ 尤其）
  fs.writeFileSync(path.join(root, 'case-root.txt'), root, 'utf8')

  const r = spawnSync(NODE, ['--import', pathToFileURL(path.join(root, 'test-register.mjs')).href, script], {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true
  })

  if (r.error) throw r.error

  const ok = r.status === 0
  // 沙箱脚本失败时把 stderr 也带出来 —— 否则 assert 失败只看到「'test failed'」，
  // 还得手动去复现
  if (!ok) {
    console.error(`--- 沙箱用例失败（${script}）---`)
    console.error(String(r.stderr || '').trim())
    if (r.stdout) console.error(String(r.stdout).trim())
    console.error('--- end ---')
  }

  return {
    ok,
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim(),
    status: r.status
  }
}

export function cleanup (root) {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {}
}
