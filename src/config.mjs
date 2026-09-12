/**
 * 启动配置：环境变量的读取与硬校验。
 *
 * 这里刻意不做任何「缺了就自动生成一个」的兜底。GOK_SALT 一旦由程序生成并写回磁盘，
 * 它就和数据库躺在同一个备份里，「加盐哈希」的全部意义当场归零——拿到备份的人
 * 顺手就把盐也拿到了。所以缺了就直接拒绝启动，让部署的人自己生成、自己分开保管。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** node:sqlite 在 24 之前要么不存在、要么要开实验开关、要么 API 还没定型，锁死 24 最省事 */
export const MIN_NODE_MAJOR = 24

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 部署脚本把生成的两把密钥写在这里 */
const ENV_FILE = path.join(SERVER_ROOT, '.env')

/** 密钥最短长度。32 个字符对应 openssl rand -hex 32 的输出长度 */
const MIN_SECRET_LENGTH = 32

function fail (message) {
  process.stderr.write(`[gok-share] 启动失败：${message}\n`)
  process.exit(1)
}

/**
 * 版本不对时给人话提示。
 * 不做这一步的话，用户拿到的是一句 `Cannot find module 'node:sqlite'`，
 * 他会去搜「node sqlite 装不上」，然后浪费一晚上。
 */
export function assertRuntime () {
  const major = Number(process.versions.node.split('.')[0])
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    fail(
      `需要 Node.js ${MIN_NODE_MAJOR} 或更高版本（当前 ${process.versions.node}）。\n` +
      `        共享库用到 Node 内置的 node:sqlite 模块，低版本里没有这个模块。\n` +
      '        用 nvm 的话：nvm install 24 && nvm use 24'
    )
  }
}

function readSecret (env, name) {
  const value = String(env[name] || '').trim()
  if (!value) {
    fail(
      `缺少环境变量 ${name}。\n` +
      `        生成一个：openssl rand -hex 32\n` +
      '        生成后放进 systemd 的 EnvironmentFile（权限设成 600），不要提交进 git、不要放进任何备份'
    )
  }
  if (value.length < MIN_SECRET_LENGTH) {
    fail(`${name} 太短（至少 ${MIN_SECRET_LENGTH} 个字符）。用 openssl rand -hex 32 生成一个。`)
  }
  return value
}

function readPort (env) {
  const raw = String(env.GOK_PORT || '').trim()
  if (!raw) return 8787

  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`GOK_PORT 不是合法端口号：${raw}`)
  }
  return port
}

function readInt (env, name, fallback, min, max) {
  const raw = String(env[name] ?? '').trim()
  if (!raw) return fallback

  const value = Number(raw)
  if (!Number.isFinite(value)) fail(`${name} 必须是数字：${raw}`)
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 解析 .env 文本。零依赖手写，只认 `KEY=VALUE` 和 `#` 注释。
 *
 * 换行按 /\r?\n/ 切而不是 '\n'：这个文件在 Windows 上打开过就会被写成 CRLF，
 * 那时候每一行的值尾部都会挂着一个 \r，密钥里多一个看不见的字符就怎么都对不上。
 */
function parseDotEnv (text) {
  const out = {}

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq <= 0) continue

    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()

    // 去掉一层引号，值里带空格时这么写很自然
    if (value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }

    if (key) out[key] = value
  }

  return out
}

/**
 * 读同目录的 .env。没有这个文件就返回空对象。
 *
 * 服务端自己认这个文件，而不是让 pm2 传 `--env-from-file`：
 * 那个参数是较新版本才有的，老 pm2 上会直接启动失败，而这个文件本来就在手边。
 */
function loadDotEnv () {
  try {
    return parseDotEnv(fs.readFileSync(ENV_FILE, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * @param {Record<string, string|undefined>|null} [env] 传 null 表示用真实环境变量（.env 作为兜底）
 * @returns {{host: string, port: number, dbPath: string, salt: string, adminSecret: string,
 *            trustProxy: boolean, readCooldownMs: number, publicUrl: string}}
 */
export function loadConfig (env = null) {
  // 先铺 .env 再让真实环境变量盖上去：命令行临时指定要能压过文件里的值
  const merged = { ...loadDotEnv(), ...(env || process.env) }

  const salt = readSecret(merged, 'GOK_SALT')
  const adminSecret = readSecret(merged, 'GOK_ADMIN_SECRET')

  // 两个密钥共用一个值，等于把「签发 token 的钥匙」和「还原 QQ 的钥匙」绑在一起，
  // 泄露一个就同时丢两样
  if (salt === adminSecret) {
    fail('GOK_SALT 和 GOK_ADMIN_SECRET 不能是同一个值，它们必须各自独立生成。')
  }

  const dbPath = String(merged.GOK_DB || '').trim() || path.join(SERVER_ROOT, 'data', 'share.db')

  // 默认**不指定**监听地址：交给 Node 自己挑 —— 系统有 IPv6 就绑 `::`，那是双栈地址，
  // v4 和 v6 都能连；没有 IPv6 才退回 `0.0.0.0`。
  //
  // 这里写死 `0.0.0.0` 是个坑：那**只开 IPv4**，纯 v6 的机器、或者从 v6 侧过来的请求
  // 一律连不上，而 `ss` 看起来「明明在监听」。（bindv6only=0 的 Linux 上绑 `::` 才双栈。）
  //
  // 想强制只给本机/只给 v4，就显式设 GOK_HOST。
  const host = String(merged.GOK_HOST || '').trim()

  // 信任 X-Forwarded-For 的条件：
  // - 监听回环 = 前面必然有反代（不然外面根本连不上），此时所有请求的 remoteAddress
  //   都是反代那一个 IP，不读这个头的话按 IP 的限流会退化成全局限流，一个桶卡死所有人。
  // - 绑在所有网卡（上面 host 为空的情形）= 直连公网，**默认不信**：任何人都能伪造这个头绕过限流。
  // GOK_TRUST_PROXY 显式设了就以它为准。
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  const trustProxyRaw = String(merged.GOK_TRUST_PROXY || '').trim()

  return {
    host,
    port: readPort(merged),
    dbPath,
    salt,
    adminSecret,
    trustProxy: trustProxyRaw === '' ? loopback : trustProxyRaw === '1',
    // (client, qq) 的响应冷却，只做防抖。见 ratelimit.mjs 的 Cooldown：
    // 客户端本地只缓存 5 秒，这里要是还设 60 秒，那个 5 秒就白设了 ——
    // 客户端来问，服务端却回 60 秒前的旧响应
    readCooldownMs: readInt(merged, 'GOK_READ_COOLDOWN_MS', 10000, 0, 3600000),
    // 按来源 IP 的令牌桶。挡扫描器用的，不参与授权。
    // 做成可配是因为量级跟机器无关、跟「有多少 bot 挂在这台后面」有关：
    // 多个 bot 挤在同一个 NAT 或反代后面时它们共用一个 IP，额度得跟着放大
    ipRatePerMinute: readInt(merged, 'GOK_IP_RATE_PER_MINUTE', 120, 0, 100000),
    ipBurst: readInt(merged, 'GOK_IP_BURST', 60, 0, 100000),
    // 仅供日志与文档展示，服务本身不依赖它
    publicUrl: String(merged.GOK_PUBLIC_URL || '').trim()
  }
}

export { SERVER_ROOT }
