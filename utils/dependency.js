/**
 * 服务端部署依赖安装器：pm2 + ffmpeg。
 *
 * 这里只安装缺失的依赖，不升级已经可用的版本。命令用参数数组执行，避免路径和
 * Windows .cmd 包装器被 shell 误解析；安装失败只返回人话和可复制命令，不阻断日志。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { pm2Bin, resetPm2Cache, lpm2Ready } from './pm2.js'

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
let installing = null

// Windows .cmd 不能直接 spawn；npm 优先经 node 执行真实 CLI。
function command (bin, args) {
  if (!IS_WIN || /\.exe$/i.test(bin)) return { bin, args, shell: false }
  if (/(?:^|[\\/])npm(?:\.cmd)?$/i.test(bin)) {
    const dirs = [path.dirname(process.execPath), ...(process.env.PATH || process.env.Path || '').split(path.delimiter)]
    if (path.isAbsolute(bin)) dirs.unshift(path.dirname(bin))
    for (const dir of dirs.filter(Boolean)) {
      const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (fs.existsSync(cli)) return { bin: process.execPath, args: [cli, ...args], shell: false }
    }
  }
  if (/[%!"\r\n]/.test([bin, ...args].join(''))) throw new Error('命令参数包含不支持的字符')
  return { bin: [bin, ...args].map(v => `"${v}"`).join(' '), args: [], shell: true }
}

function commandExists (name) {
  try {
    const c = command(name, ['--version'])
    const r = spawnSync(c.bin, c.args, {
      shell: c.shell, stdio: 'ignore', timeout: 8000, windowsHide: true
    })
    return !r.error && r.status === 0
  } catch { return false }
}

async function run (bin, args, { env, timeout = 10 * 60 * 1000 } = {}) {
  return new Promise(resolve => {
    let out = '', err = '', timer
    try {
      const c = command(bin, args)
      const child = spawn(c.bin, c.args, {
        shell: c.shell, windowsHide: true,
        // POSIX 下建独立进程组，超时才能用 kill(-pid) 把整棵进程树带走（见下面的 timer）
        detached: !IS_WIN,
        env: { ...process.env, ...(env || {}) }, stdio: ['ignore', 'pipe', 'pipe']
      })
      let done = false
      const finish = (ok, error = '') => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ ok, out: out.trim(), err: (err || error).trim() })
      }
      child.stdout.on('data', data => { out = (out + data).slice(-65536) })
      child.stderr.on('data', data => { err = (err + data).slice(-65536) })
      child.on('error', error => finish(false, error.message))
      child.on('close', code => finish(code === 0))
      // ⚠️⚠️ 超时必须**连子进程一起杀**（2026-10-06 修）。走 shell 那条路（见上面的 command()）
      //    时 `child` 是 cmd.exe 而不是安装器本身，Windows 的 TerminateProcess 不级联子进程、
      //    POSIX 侧这里也没建进程组，所以 winget / choco 会变成孤儿继续跑：用户看到
      //    「安装失败，请手动执行 …」并照做，于是两个安装器并发改同一份包状态。
      timer = setTimeout(() => {
        try {
          if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          else process.kill(-child.pid, 'SIGKILL')
        } catch {}
        child.kill()
        finish(false, '安装命令超时')
      }, timeout)
    } catch (error) { resolve({ ok: false, out, err: error.message }) }
  })
}

function redact (text) {
  return String(text || '').replace(/(https?:\/\/)([^/@\s]+):([^/@\s]+)@/gi, '$1***:***@')
}

function cfgValue (cfg, name) {
  return String(cfg?.[name] || process.env[`GOK_${name.replace(/[A-Z]/g, m => '_' + m).toUpperCase()}`] || '').trim()
}

function npmBin () {
  if (commandExists('npm')) return 'npm'
  const dir = path.dirname(process.execPath)
  const candidate = IS_WIN ? path.join(dir, 'npm.cmd') : path.join(dir, 'npm')
  return fs.existsSync(candidate) ? candidate : ''
}

function npmEnv (cfg) {
  const registry = cfgValue(cfg, 'dependencyRegistry') || 'https://registry.npmmirror.com'
  const proxy = cfgValue(cfg, 'dependencyProxy')
  return {
    ...(proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, npm_config_proxy: proxy, npm_config_https_proxy: proxy } : {}),
    npm_config_registry: registry
  }
}

function ffmpegCandidates () {
  const exe = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'
  const out = [process.env.GOK_FFMPEG, exe]
  if (IS_WIN) {
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const la = process.env.LOCALAPPDATA || ''
    out.push(path.join(pf, 'ffmpeg', 'bin', exe), la && path.join(la, 'Microsoft', 'WinGet', 'Links', exe), 'C:\\ffmpeg\\bin\\ffmpeg.exe')
  } else {
    out.push('/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/snap/bin/ffmpeg', '/opt/local/bin/ffmpeg')
    if (process.env.HOME) out.push(path.join(process.env.HOME, '.local', 'bin', exe))
  }
  return [...new Set(out.filter(Boolean))]
}

async function findFfmpeg () {
  for (const bin of ffmpegCandidates()) {
    if ((bin.includes('/') || bin.includes('\\')) && !fs.existsSync(bin)) continue
    if ((await run(bin, ['-version'], { timeout: 8000 })).ok) return bin
  }
  return ''
}

async function privilege () {
  if (IS_WIN || typeof process.getuid !== 'function' || process.getuid() === 0) return { bin: '', args: [] }
  if (commandExists('sudo') && (await run('sudo', ['-n', 'true'], { timeout: 5000 })).ok) return { bin: 'sudo', args: ['-n'] }
  return null
}

function ffmpegInstallCommand () {
  if (IS_WIN) {
    if (commandExists('winget')) return { bin: 'winget', args: ['install', '--id', 'Gyan.FFmpeg.Shared', '--exact', '--accept-source-agreements', '--accept-package-agreements'], text: 'winget install --id Gyan.FFmpeg.Shared --exact' }
    if (commandExists('choco')) return { bin: 'choco', args: ['install', 'ffmpeg', '-y'], text: 'choco install ffmpeg -y' }
    if (commandExists('scoop')) return { bin: 'scoop', args: ['install', 'ffmpeg'], text: 'scoop install ffmpeg' }
    return null
  }
  if (IS_MAC && commandExists('brew')) return { bin: 'brew', args: ['install', 'ffmpeg'], text: 'brew install ffmpeg' }
  if (commandExists('apt-get')) return { bin: 'apt-get', args: ['update'], second: ['apt-get', 'install', '-y', 'ffmpeg'], text: 'sudo apt-get update && sudo apt-get install -y ffmpeg' }
  if (commandExists('dnf')) return { bin: 'dnf', args: ['install', '-y', 'ffmpeg'], text: 'sudo dnf install -y ffmpeg' }
  if (commandExists('yum')) return { bin: 'yum', args: ['install', '-y', 'ffmpeg'], text: 'sudo yum install -y ffmpeg' }
  if (commandExists('apk')) return { bin: 'apk', args: ['add', '--no-cache', 'ffmpeg'], text: 'sudo apk add --no-cache ffmpeg' }
  if (commandExists('pacman')) return { bin: 'pacman', args: ['-Sy', '--noconfirm', 'ffmpeg'], text: 'sudo pacman -Sy --noconfirm ffmpeg' }
  return null
}

export async function ensureNodePackage (name, { dir, cfg = {}, logger = console } = {}) {
  const target = path.resolve(String(dir || process.cwd()))
  try {
    const resolved = createRequire(path.join(target, 'package.json')).resolve(name)
    if (resolved) return { ok: true, changed: false }
  } catch {}

  const npm = npmBin()
  if (!npm) return { ok: false, changed: false, message: `找不到 npm，无法安装 Node 依赖 ${name}` }
  const r = await run(npm, ['install', '--no-save', '--no-package-lock', '--prefix', target, name], { env: npmEnv(cfg) })
  if (!r.ok) {
    logger.warn?.(`[依赖] ${name} 安装失败：${redact(r.err).slice(-500)}`)
    return { ok: false, changed: false, message: `Node 依赖 ${name} 安装失败，请检查网络或代理` }
  }
  try {
    createRequire(path.join(target, 'package.json')).resolve(name)
  } catch (error) {
    logger.warn?.(`[依赖] ${name} 安装后验证失败：${redact(error.message)}`)
    return { ok: false, changed: true, message: `请在 ${target} 执行 npm install --no-save ${name}` }
  }
  return { ok: true, changed: true }
}

export async function ensureDependencies ({ needFfmpeg = false, needWs = false, nodeDir = '', cfg = {}, logger = console } = {}) {
  // 串行排队，但每次仍按本次需求检查，不能复用另一类部署的结果。
  const previous = installing
  let release
  installing = new Promise(resolve => { release = resolve })
  if (previous) await previous
  try {
    const result = { ok: true, changed: false, pm2: false, ffmpeg: needFfmpeg ? await findFfmpeg() : '', messages: [], commands: [] }

      // Windows 上服务跑在插件自己的 pm2 里（lpm2 提供隔离管道 + 专属 PM2_HOME），
      // 所以先要 lpm2；它的 pm2 是 peer 依赖，自动安装不可靠（npm 6 没有这机制、
      // pnpm 关掉 auto-install-peers、--legacy-peer-deps 都会跳过），装不上它会直接
      // 以「could not resolve pm2」退出 —— 所以两个都显式装。
      // Linux / macOS 那边 pm2 的 socket 本来就按 PM2_HOME 分，不需要 lpm2，只装 pm2。
      // ⚠️ 只做**纯文件**判断，不跑探测命令 —— 跑 pm2 / lpm2 会顺手把 daemon 拉起来
      const pm2Ready = () => (IS_WIN ? lpm2Ready() : Boolean(pm2Bin()))
      const pm2Pkgs = IS_WIN ? ['@lyln/lpm2', 'pm2'] : ['pm2']

      if (!pm2Ready()) {
        const npm = npmBin()
        if (!npm) return { ...result, ok: false, messages: ['没找到 npm，无法自动安装 pm2。'] }
        const r = await run(npm, ['install', '-g', ...pm2Pkgs], { env: npmEnv(cfg) })
        result.commands.push(`${npm} install -g ${pm2Pkgs.join(' ')}`)
        if (!r.ok) {
          logger.warn?.(`[依赖] pm2 安装失败：${redact(r.err).slice(-500)}`)
          return { ...result, ok: false, messages: [`pm2 自动安装失败，请手动安装：npm install -g ${pm2Pkgs.join(' ')}`] }
        }
        resetPm2Cache()
        result.changed = true
      }
      result.pm2 = pm2Ready()
      if (!result.pm2) return { ...result, ok: false, messages: ['pm2 安装后仍不可用，请重启云崽后再部署。'] }

      if (needWs) {
        const ws = await ensureNodePackage('ws', { dir: nodeDir, cfg, logger })
        if (!ws.ok) return { ...result, ok: false, messages: [ws.message || 'ws 依赖安装失败，请检查网络或代理。'] }
        result.changed ||= ws.changed
      }

      if (needFfmpeg && !result.ffmpeg) {
        const spec = ffmpegInstallCommand()
        if (!spec) return { ...result, ok: false, messages: ['找不到可用的 ffmpeg 安装器，请先安装 ffmpeg。'] }
        // Homebrew 必须由当前用户运行，不能套 sudo。
        const p = spec.bin === 'brew' ? { bin: '', args: [] } : await privilege()
        if (p === null) return { ...result, ok: false, messages: [`请手动执行：${spec.text}`] }
        const proxy = cfgValue(cfg, 'dependencyProxy')
        const env = proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy } : {}
        const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']
          .filter(key => env[key] || process.env[key])
        // sudo 默认清理代理变量；只保留代理，不使用 -E 放开全部环境。
        const prefix = [...(p?.args || []), ...(p?.bin && proxyKeys.length ? [`--preserve-env=${proxyKeys.join(',')}`] : [])]
        const options = { timeout: 15 * 60 * 1000, env }
        const r1 = await run(p?.bin || spec.bin, [...prefix, ...(p?.bin ? [spec.bin] : []), ...spec.args], options)
        let r = r1
        if (r1.ok && spec.second) r = await run(p?.bin || spec.second[0], [...prefix, ...(p?.bin ? [spec.second[0]] : []), ...spec.second.slice(1)], options)
        result.commands.push(spec.text)
        if (!r.ok) {
          logger.warn?.(`[依赖] ffmpeg 安装失败：${redact(r.err).slice(-500)}`)
          return { ...result, ok: false, messages: [`ffmpeg 自动安装失败，请手动执行：${spec.text}`] }
        }
        result.changed = true
        result.ffmpeg = await findFfmpeg()
      }
      if (needFfmpeg && !result.ffmpeg) {
        return { ...result, ok: false, messages: ['ffmpeg 已执行安装，但当前进程还找不到它；重启云崽后再发一次部署。'] }
      }
      return result
  } finally { release() }
}

export function dependencySummary (result) {
  return (result?.messages || []).join('\n')
}
