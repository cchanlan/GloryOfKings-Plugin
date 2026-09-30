/**
 * 调 pm2 的统一入口（跨平台）。
 *
 * ## 为什么要包一层
 *
 * 直接 `execSync('pm2 restart x')` 在 Windows 上很容易失败，原因不是没装：
 * Yunzai 进程的 PATH 停在它启动那一刻，`npm i -g pm2` 之后写进注册表的新 PATH
 * 只对新进程生效，已经跑着的 Yunzai 和它 spawn 出来的子进程都看不见 ——
 * 表现就是「明明装了 pm2」却报 command not found，还容易被误判成进程名填错。
 * 所以先按 PATH 找，找不到就去 npm 全局目录按文件名捞。
 *
 * ## Windows 上为什么还要 lpm2（@lyln/lpm2）
 *
 * pm2 在 Windows 把 daemon 的传输管道**写死**成 `\\.\pipe\rpc.sock`：不分用户、
 * 不分 PM2_HOME、不分项目。同一台机器上只要有第二套 pm2（别人装的、或者另一个云崽），
 * 两边就抢同一个管道 —— 轻则 `connect EPERM` 把 CLI 带崩，重则**连上别人的 daemon**：
 * 本插件的 `restart` / `delete` 会落到别人的进程上。
 *
 * lpm2 把管道按 PM2_HOME 派生（`\\.\pipe\lpm2-<hash>-rpc.sock`），pm2 仍是引擎、
 * 参数原样转发。再给插件一个专属 PM2_HOME（`<插件>/data/pm2`，`.gitignore` 挡着），
 * 进程表、管道、dump、日志就都是本插件自己一套：既不去碰机器上原有的 pm2，
 * `pm2 save` 也不会把用户的 `~/.pm2/dump.pm2` 覆写掉（两套 daemon 共用一个 dump，
 * 会把用户原有的进程从 dump 里抹掉，开机会 resurrect 不出来）。
 *
 * **Linux / macOS 不走这条**：那边 pm2 的 socket 本来就放在 PM2_HOME 里，没有这个毛病，
 * 保持原样直连 pm2（install 也只装 pm2，不引入额外依赖）。
 *
 * lpm2 装不上（离线 / 没权限 / 没有 npm）时退回直连 pm2 —— 这时**绝不能**再设专属
 * PM2_HOME：Windows 的固定管道会变成「连上别人的 daemon、却按我们的 home 读写 dump」，
 * 两边全乱。所以退路下 PM2_HOME 一律不设，行为跟没接 lpm2 之前完全一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const IS_WIN = process.platform === 'win32'

/** 插件根目录（本文件在 utils/ 下），不跟 process.cwd() 走 */
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 专属 PM2_HOME：只在「Windows + lpm2」这条路上用，见文件头 */
const PM2_HOME_DIR = path.join(PLUGIN_DIR, 'data', 'pm2')

let cached
let cachedResolved = false
let cachedLpm2
let cachedLpm2Resolved = false
let cachedUsable
let cachedUsableResolved = false
let cachedLauncher
let cachedLauncherResolved = false

/**
 * Windows 上除了 .exe 一律得经 shell：
 * - `.cmd`/`.bat` 从 Node 18.20 起不能直接 spawn（会被拒）
 * - **裸名字 `pm2` 也不行** —— CreateProcess 只认 .exe，不查 PATHEXT，
 *   而 npm 全局包在 Windows 上是 `pm2.cmd`，于是 PATH 里明明有也报 ENOENT。
 *   交给 cmd.exe 它才会按 PATHEXT 补后缀找到 .cmd。
 *   顺带避开了 npm 那个 `pm2.ps1` 包装（.ps1 不在 PATHEXT 里，cmd 不会命中它，
 *   而它用 $args 转发会吃掉参数终止符 `--`）。
 */
function needsShell (bin) {
  return IS_WIN && !/\.exe$/i.test(bin)
}

function quote (s) {
  return /[\s&|()<>^"]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s)
}

/** 从某个 package.json 里读出 bin 指向的真实 JS 入口，不存在则空串 */
function readBin (pkgJsonPath, key) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
    const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[key]
    if (!rel) return ''
    const abs = path.resolve(path.dirname(pkgJsonPath), rel)
    return fs.existsSync(abs) ? abs : ''
  } catch {
    return ''
  }
}

/** 全局安装的常见落点（Node 的模块解析不会去全局目录找，只能自己列） */
function globalRoots () {
  const nodeDir = path.dirname(process.execPath)
  if (IS_WIN) {
    return [
      // npm i -g 的默认落点，也是 Windows 上最常见的一个
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
      nodeDir,
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs'),
      process.env.ALLUSERSPROFILE && path.join(process.env.ALLUSERSPROFILE, 'npm')
    ].filter(Boolean).map(dir => path.join(dir, 'node_modules'))
  }
  return [
    // nvm 装的 node，全局包和 node 同一个目录
    path.join(nodeDir, '..', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    process.env.HOME && path.join(process.env.HOME, '.local', 'lib', 'node_modules')
  ].filter(Boolean)
}

/** 拿 `-v` 试一下这个名字/路径能不能直接跑起来 */
function probe (bin) {
  try {
    const r = needsShell(bin)
      ? spawnSync(`${quote(bin)} -v`, { shell: true, stdio: 'ignore', timeout: 20000, windowsHide: true })
      : spawnSync(bin, ['-v'], { stdio: 'ignore', timeout: 20000, windowsHide: true })
    return !r.error && r.status === 0
  } catch {
    return false
  }
}

/** pm2 可能装在哪 —— 按 PATH 之外的常见位置排 */
function candidates () {
  const nodeDir = path.dirname(process.execPath)
  if (IS_WIN) {
    return [
      // npm i -g 的默认落点，也是 Windows 上最常见的一个
      path.join(process.env.APPDATA || '', 'npm', 'pm2.cmd'),
      path.join(nodeDir, 'pm2.cmd'),
      path.join(process.env.ProgramFiles || '', 'nodejs', 'pm2.cmd'),
      path.join(process.env.ALLUSERSPROFILE || '', 'npm', 'pm2.cmd')
    ]
  }
  return [
    // nvm 装的 node，全局包和 node 同一个 bin 目录，而这个目录常常不在 PATH 上
    path.join(nodeDir, 'pm2'),
    '/usr/local/bin/pm2',
    '/usr/bin/pm2',
    path.join(process.env.HOME || '', '.local/bin/pm2')
  ]
}

/**
 * 找到能用的 pm2，找不到返回 null。
 * @returns {string|null}
 */
export function pm2Bin () {
  if (cachedResolved) return cached
  cachedResolved = true
  cached = null

  if (probe('pm2')) {
    cached = 'pm2'
    return cached
  }
  for (const p of candidates()) {
    if (p && fs.existsSync(p) && probe(p)) {
      cached = p
      return cached
    }
  }
  return cached
}

/**
 * lpm2 的真实 JS 入口，没有则空串。
 * 只解析路径（不跑进程）：能不能真跑由部署时的 `lpm2Usable()` 判定。
 * @returns {string}
 */
export function lpm2Bin () {
  if (!IS_WIN) return ''
  if (cachedLpm2Resolved) return cachedLpm2
  cachedLpm2Resolved = true
  cachedLpm2 = ''

  // ① 走模块解析：本地安装 / NODE_PATH / pnpm 软链都能命中
  for (const base of [path.join(PLUGIN_DIR, '__resolve__.js'), import.meta.url]) {
    try {
      const req = createRequire(base)
      const abs = readBin(req.resolve('@lyln/lpm2/package.json'), 'lpm2')
      if (abs) {
        cachedLpm2 = abs
        return cachedLpm2
      }
    } catch {}
  }
  // ② 全局安装的固定落点（包名是 @lyln/lpm2，多一层作用域目录）
  for (const root of globalRoots()) {
    const abs = readBin(path.join(root, '@lyln', 'lpm2', 'package.json'), 'lpm2')
    if (abs) {
      cachedLpm2 = abs
      return cachedLpm2
    }
  }
  return cachedLpm2
}

/**
 * lpm2 是否真能用：跑一次 `lpm2 --version`。
 * 光看文件在不在不够 —— lpm2 是壳子，它自己解析不到 pm2 时会直接退出 1
 * （典型：`--legacy-peer-deps` 装出来的 lpm2 没带 pm2）。
 */
export function lpm2Usable () {
  if (cachedUsableResolved) return cachedUsable
  cachedUsableResolved = true
  cachedUsable = false

  const js = lpm2Bin()
  if (!js) return cachedUsable
  try {
    const r = spawnSync(process.execPath, [js, '--version'], {
      encoding: 'utf-8', timeout: 30000, windowsHide: true, env: process.env
    })
    cachedUsable = !r.error && r.status === 0
  } catch {
    cachedUsable = false
  }
  return cachedUsable
}

/** 专属 PM2_HOME 建出来（建不出来就不能用它，否则 pm2 起不来） */
function ensureHomeDir () {
  try {
    fs.mkdirSync(PM2_HOME_DIR, { recursive: true })
    return true
  } catch {
    return false
  }
}

/**
 * 决定怎么调 pm2，返回 `{ kind, cmd, pre, bin, shell, env }`：
 *   kind='lpm2' —— Windows 且 lpm2 可用：隔离管道 + 专属 PM2_HOME
 *   kind='pm2'  —— 机器上原本的 pm2（Linux / macOS，或 Windows 上的退路）
 * 都不可用返回 null。
 */
function launcher () {
  if (cachedLauncherResolved) return cachedLauncher
  cachedLauncherResolved = true
  cachedLauncher = null

  // Windows 优先 lpm2；POSIX 永远直连（见文件头）
  const js = lpm2Bin()
  if (js && lpm2Usable() && ensureHomeDir()) {
    cachedLauncher = {
      kind: 'lpm2',
      cmd: process.execPath,
      pre: [js],
      bin: '',
      shell: false,
      env: { PM2_HOME: PM2_HOME_DIR }
    }
    return cachedLauncher
  }

  const bin = pm2Bin()
  if (!bin) return null
  cachedLauncher = {
    kind: 'pm2',
    cmd: bin,
    pre: [],
    bin,
    shell: needsShell(bin),
    // ⚠️ 退路（以及 POSIX）一律不设 PM2_HOME：Windows 的固定管道会让专属 home
    //    变成「连上别人的 daemon、却按我们的 home 读写 dump」
    env: null
  }
  return cachedLauncher
}

/** 用机器上原本的 pm2 跑一条命令（绕开 lpm2），只给诊断/迁移检测用 */
function runPm2Direct (args, { timeout = 30000 } = {}) {
  const bin = pm2Bin()
  if (!bin) return { ok: false, out: '', err: '找不到 pm2', missing: true }
  const r = needsShell(bin)
    ? spawnSync([bin, ...args].map(quote).join(' '), {
      shell: true, encoding: 'utf-8', timeout, windowsHide: true, env: process.env
    })
    : spawnSync(bin, args, { encoding: 'utf-8', timeout, windowsHide: true, env: process.env })
  return {
    ok: !r.error && r.status === 0,
    out: String(r.stdout || '').trim(),
    err: String(r.stderr || '').trim() || (r.error ? r.error.message : ''),
    missing: false
  }
}

/** 下次调用重新探测（装完 pm2 / lpm2 不用重启 Yunzai 就能被认到） */
export function resetPm2Cache () {
  cachedResolved = false
  cached = null
  cachedLpm2Resolved = false
  cachedLpm2 = ''
  cachedUsableResolved = false
  cachedUsable = false
  cachedLauncherResolved = false
  cachedLauncher = null
}

/**
 * 跑一条 pm2 命令。
 * @param {string[]} args 参数数组，如 ['restart', 'gok-watch']
 * @param {{timeout?: number, env?: object}} opts
 * @returns {{ok: boolean, out: string, err: string, missing: boolean}}
 */
export function pm2 (args = [], { timeout = 120000, env } = {}) {
  const l = launcher()
  if (!l) {
    return {
      ok: false,
      out: '',
      missing: true,
      err: IS_WIN
        ? '找不到可用的进程管理器。装过的话多半是 Yunzai 还拿着旧的 PATH，重启 Yunzai 即可；没装就先 npm i -g @lyln/lpm2 pm2'
        : '找不到 pm2，先装一个：npm i -g pm2'
    }
  }

  const childEnv = { ...process.env, ...(l.env || {}), ...(env || {}) }
  const common = { encoding: 'utf-8', timeout, windowsHide: true, env: childEnv }

  let r
  if (l.shell) {
    const line = [l.cmd, ...args].map(quote).join(' ')
    // shell 拼接模式下这些字符会让命令跑歪，宁可失败也别乱跑
    if (/[%!"\r\n]/.test(line)) return { ok: false, out: '', err: '命令参数包含不支持的字符', missing: false }
    r = spawnSync(line, { ...common, shell: true })
  } else {
    r = spawnSync(l.cmd, [...l.pre, ...args], common)
  }

  return {
    ok: !r.error && r.status === 0,
    out: String(r.stdout || '').trim(),
    err: String(r.stderr || '').trim() || (r.error ? r.error.message : ''),
    missing: false
  }
}

/**
 * 从 pm2 输出里抠出 JSON 数组。
 *
 * ⚠️ 不能只做「从第一个 `[` 截到末尾」：pm2 首次拉起 daemon 时会先打一行
 * `[PM2] Spawning PM2 daemon with pm2_home=...`，从第一个 `[` 截就会切在那行提示上，
 * parse 必炸 —— 表现为「进程明明在跑，状态却显示没在跑」。所以按括号配对扫一遍，
 * 取第一个**真能 parse 成数组**的片段。
 */
function parseJsonArray (text) {
  const s = String(text || '')
  for (let start = s.indexOf('['); start >= 0; start = s.indexOf('[', start + 1)) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < s.length; i++) {
      const c = s[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '[' || c === '{') depth++
      else if (c === ']' || c === '}') {
        depth--
        if (depth === 0) {
          if (c === ']') {
            try {
              const v = JSON.parse(s.slice(start, i + 1))
              if (Array.isArray(v)) return v
            } catch {}
          }
          break
        }
      }
    }
  }
  return []
}

/** 在一份 pm2 输出里找指定名字的进程 */
function pickProc (result, name) {
  if (!result?.ok || !result.out) return null
  return parseJsonArray(result.out).find(p => p.name === name) || null
}

/**
 * `pm2 jlist` 里指定名字的进程，没有则 null。
 * Windows 上查的是**插件自己的 daemon**（隔离那个）。
 */
export function pm2Proc (name) {
  return pickProc(pm2(['jlist'], { timeout: 30000 }), name)
}

/**
 * 查**机器原本的 pm2**（不是插件自己的 daemon）里有没有同名进程。
 *
 * 只给 Windows 隔离模式下的迁移检测用：老版本部署的进程还留在外面的 pm2 里，
 * 端口被它占着，新进程根本起不来 —— 得先认出它、告诉主人怎么切过来。
 * 非隔离时（POSIX / 退路）两者本来就是同一个 daemon，直接返回 null 省一次调用。
 */
export function pm2ForeignProc (name) {
  if (launcher()?.kind !== 'lpm2') return null
  return pickProc(runPm2Direct(['jlist']), name)
}

/** 当前用的哪种进程管理方式（给状态指令显示用，只读不启进程） */
export function launcherInfo () {
  const l = launcher()
  return {
    kind: l?.kind || 'none',
    isolated: Boolean(l?.env?.PM2_HOME),
    pm2Home: l?.env?.PM2_HOME || process.env.PM2_HOME || '(默认 ~/.pm2)'
  }
}

/**
 * 判断某个 pm2 进程是不是**我们自己起的那个**。
 *
 * 光比名字不够：别人完全可能也有个叫同名进程的东西，而卸载动作会把它停掉、删掉。
 * 所以要看它跑的是不是我们 server 目录下的入口，cwd 和脚本路径任一命中才算。
 * （这个教训是从 meme 插件的卸载逻辑里带过来的。）
 *
 * @param {object|null} proc pm2Proc 的返回值
 * @param {string} serverDir 服务端目录绝对路径
 */
export function isOurProcess (proc, serverDir) {
  if (!proc) return false

  const norm = p => String(p || '').replace(/\\/g, '/').toLowerCase()
  const want = norm(serverDir)

  const cwd = norm(proc.pm2_env?.pm_cwd || proc.pm2_env?.cwd)
  const script = norm(proc.pm2_env?.pm_exec_path)

  return cwd.startsWith(want) || script.startsWith(want)
}
