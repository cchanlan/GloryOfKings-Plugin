/**
 * 服务端代码分发的**客户端**：从主人的分发服务下载 tar.gz、解开、记台账。
 *
 * ## 为什么不用 git 了
 *
 * 服务端代码原来住在仓库的三个分支上（`server` / `watch-server` / `im-server`），
 * 靠 `git clone` 拉。现在改成从**主人自己的服务器**发（凭 token），好处：
 *   · 代码不再出现在任何公开仓库里
 *   · 主人能按人发 token、单独吊销
 *   · 群友不用装 git
 *
 * ## 解压为什么自己写
 *
 * 插件不能随便加依赖（别人装插件时不会 `npm install`）。好在 Node 内置的 `zlib`
 * 能解 gzip，而 tar 的格式简单到能手写：每个条目一个 512 字节头 + 数据（按 512 对齐）。
 *
 * ⚠️⚠️ **`git archive` 打出来的是 pax 格式，第一个条目是 `typeflag='g'` 的
 * `pax_global_header`**（实测：size=52）。不跳过它的话，那 52 字节会被当成下一个
 * 条目的头，整个包解出来全是垃圾。`typeflag='x'`（pax 扩展头，真实路径在数据段里）
 * 和 `'L'`（GNU 长文件名）同理 —— 现在三个分支的路径都没超 100 字节，暂时遇不到，
 * 但兜底必须写，不然将来加个深目录就静默解错。
 *
 * ## 数据文件为什么不会被冲掉
 *
 * 两层保险：
 *   1. `git archive` 只打**被跟踪**的文件，而服务端分支的 `.gitignore` 把 `data/*`
 *      和 `.env` 都挡住了 —— 它们根本不在包里。
 *   2. 解压时 `exclude` 再挡一道（首段命中就跳过）。
 * 而且观战的数据本来就在 `<插件>/data/watch/`、代码在 `<插件>/server/`，
 * 两者不重叠，怎么更新都碰不到。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** 默认排除的路径首段：数据、凭证、依赖、旧 git 目录，一律不写 */
export const DEFAULT_EXCLUDE = ['data', '.env', 'node_modules', '.git', 'config/config']

/** 安装台账文件名（记「上次装的是哪个 sha、解出哪些文件」） */
export const STATE_FILE = '.gok-pkg.json'

/* ------------------------------------------------------------ 小工具 */

/** 从 512 字节头里读一段字符串，`\0` 截断。⚠️ 按 utf8 读，分支里有中文文件名 */
function readStr (buf, start, len) {
  return buf.subarray(start, start + len).toString('utf8').replace(/\0.*$/, '')
}

/** 全是 0 的块 = tar 的结束标记 */
function isZeroBlock (block) {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false
  return true
}

/** 解析 pax 扩展头的数据段，抠出 `path=` 那一行（其余如 `mtime=` 不管） */
function parsePaxPath (data) {
  const text = data.toString('utf8')
  for (const line of text.split('\n')) {
    // 每行格式：`<长度> <key>=<value>`
    const m = line.match(/^\d+ path=(.*)$/)
    if (m) return m[1]
  }
  return null
}

/** 这个相对路径该不该跳过（首段命中 exclude，或含 `..` 想往上跑） */
function shouldSkip (rel, exclude) {
  if (!rel || rel === '.') return true
  const segs = rel.split('/')
  if (segs.some(s => s === '..')) return true
  return exclude.some(e => rel === e || rel.startsWith(e + '/'))
}

/* ------------------------------------------------------------ 解压 */

/**
 * 解一个 tar.gz 到 destDir。
 *
 * @param {Buffer} buffer  tar.gz 的完整字节
 * @param {string} destDir 目标目录（不存在会建）
 * @param {{exclude?: string[]}} [opts] 要跳过的路径首段，默认见 DEFAULT_EXCLUDE
 * @returns {{files: string[], bytes: number, skipped: string[]}}
 *   files   解出来的文件相对路径（目录不算）
 *   bytes   解出来的总字节
 *   skipped 被跳过的路径（排查「为什么这个文件没更新」用）
 */
export function extractTarGz (buffer, destDir, { exclude = DEFAULT_EXCLUDE } = {}) {
  const tar = zlib.gunzipSync(buffer)
  const root = path.resolve(destDir)
  const out = { files: [], bytes: 0, skipped: [] }

  let off = 0
  let pendingName = null // 来自 `x` / `L` 头的覆盖路径

  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512)
    if (isZeroBlock(header)) break

    let name = readStr(header, 0, 100)
    const size = parseInt(readStr(header, 124, 12).trim(), 8) || 0
    const typeflag = String.fromCharCode(header[156])
    const dataStart = off + 512
    const dataEnd = dataStart + size
    // 下一个头的位置：数据段按 512 对齐
    off = dataStart + Math.ceil(size / 512) * 512

    // ① pax 全局头（git archive 每条都会带）—— 直接跳过，**不能少这一条**
    if (typeflag === 'g') continue

    // ② pax 扩展头 / GNU 长文件名 —— 真实路径在数据段里，存起来给下一个条目用
    if (typeflag === 'x') {
      pendingName = parsePaxPath(tar.subarray(dataStart, dataEnd))
      continue
    }
    if (typeflag === 'L') {
      pendingName = tar.subarray(dataStart, dataEnd).toString('utf8').replace(/\0.*$/, '')
      continue
    }

    if (pendingName) {
      name = pendingName
      pendingName = null
    }

    const rel = name.replace(/^\.\//, '')
    if (shouldSkip(rel, exclude)) {
      if (rel && rel !== '.') out.skipped.push(rel)
      continue
    }

    const dest = path.resolve(root, rel)
    // 双保险：解析完必须还在 destDir 里（防 `..` 和绝对路径）
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      out.skipped.push(rel)
      continue
    }

    if (typeflag === '5') {
      // 目录
      fs.mkdirSync(dest, { recursive: true })
      continue
    }

    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      // 普通文件（`\0` 是老 tar 的写法，两个都认）
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, tar.subarray(dataStart, dataEnd))
      out.files.push(rel)
      out.bytes += size
      continue
    }

    // 符号链接（'2'）/ 硬链接（'1'）一律不解 —— 防止包被塞了指向外面的链接
    out.skipped.push(rel)
  }

  return out
}

/* ------------------------------------------------------------ 台账 */

/** 读安装台账。没有 / 读坏了都返回 null（当第一次装） */
export function readInstallState (destDir) {
  try {
    const raw = fs.readFileSync(path.join(destDir, STATE_FILE), 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data?.files) ? data : null
  } catch {
    return null
  }
}

/** 写安装台账。失败只记日志不抛 —— 装都装完了，台账丢了最多下次多解一遍 */
export function writeInstallState (destDir, state, logger) {
  try {
    fs.mkdirSync(destDir, { recursive: true })
    fs.writeFileSync(
      path.join(destDir, STATE_FILE),
      JSON.stringify(state, null, 2),
      'utf8'
    )
    return true
  } catch (error) {
    logger?.warn?.(`[deploy] 写安装台账失败（不影响使用）：${error?.message || error}`)
    return false
  }
}

/**
 * 清理「上次有、这次没有」的文件。
 *
 * tar 解压天然做不到 `git reset --hard` 那种「删掉上游已删除的文件」，
 * 所以靠台账补上。**只删台账里记过的路径** —— 数据文件、`.git`、`node_modules`
 * 永远不会在台账里，所以永远碰不到。
 *
 * @returns {string[]} 实际删掉的文件
 */
export function pruneRemoved (destDir, oldFiles, newFiles, logger) {
  const keep = new Set(newFiles)
  const removed = []
  for (const rel of oldFiles || []) {
    if (keep.has(rel)) continue
    if (shouldSkip(rel, DEFAULT_EXCLUDE)) continue
    const target = path.resolve(destDir, rel)
    const root = path.resolve(destDir)
    if (target !== root && !target.startsWith(root + path.sep)) continue
    try {
      fs.rmSync(target, { force: true })
      removed.push(rel)
    } catch (error) {
      logger?.warn?.(`[deploy] 清理旧文件 ${rel} 失败：${error?.message || error}`)
    }
  }
  return removed
}

/* ------------------------------------------------------------ 网络 */

/** 分发服务地址规范化：去尾部斜杠，没写协议就补 http:// */
export function normalizeBase (url) {
  let s = String(url || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  return s
}

/**
 * 问服务器「这个包现在是什么版本」，不下载。
 * 任何失败都翻译成 `{ok:false, message}`，不抛。
 *
 * ⚠️ 别把所有网络错误都说成「超时」。原来只有两档：
 * `TimeoutError` → 超时，其余一律「连不上（检查地址和网络）」——
 * 结果 DNS 解析不出、TLS 握手失败、连接被防火墙丢弃（对端不回 RST 只会一直等，
 * 最后也是超时）三种完全不同的病因，用户看到的提示几乎一样，没法自查。
 * 现在按 `error.cause.code` 分档给具体线索。
 *
 * @param {object} [opts.logger] 传了就顺手记一条原始错误（排查用）
 * @returns {Promise<{ok: boolean, sha?: string, size?: number, sha256?: string, message?: string}>}
 */
export async function fetchPackageMeta ({ name, url, token, timeout = 10000, logger } = {}) {
  const base = normalizeBase(url)
  if (!base) return { ok: false, message: '还没配分发服务地址' }
  if (!token) return { ok: false, message: '还没配分发令牌' }

  try {
    const res = await fetch(`${base}/api/v1/packages/${encodeURIComponent(name)}/latest`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeout)
    })

    if (res.status === 401) return { ok: false, message: '令牌无效，找主人要一个新的' }
    if (res.status === 403) return { ok: false, message: '令牌已被吊销，找主人要一个新的' }
    if (res.status === 404) return { ok: false, message: `服务器上没有「${name}」这个包` }
    if (res.status === 429) return { ok: false, message: '请求太频繁，过一会儿再试' }
    if (!res.ok) return { ok: false, message: `服务器返回 ${res.status}` }

    const data = await res.json().catch(() => null)
    if (!data?.sha) return { ok: false, message: '服务器返回的内容看不懂' }
    return { ok: true, sha: data.sha, size: data.size, sha256: data.sha256 }
  } catch (error) {
    // 原始错误进日志，别丢 —— 用户看到的是一句人话，排查靠的是这行
    logger?.warn?.(`[deploy] 请求 ${base} 失败：${error?.name} ${error?.message} code=${error?.cause?.code || '-'}`)
    return { ok: false, message: describeNetError(error, base) }
  }
}

/**
 * 把 fetch 抛的错翻成「用户能照着做」的一句话。
 *
 * 分档依据（实测）：
 *   · `TimeoutError` + 地址对 → 多半是被防火墙丢了（不回 RST，只能干等超时）
 *   · `ENOTFOUND` / `EAI_AGAIN` → 域名解析不出来（IPv4 客户端解析只有 AAAA 的域名就是这个）
 *   · `ECONNREFUSED` → 地址通了但端口没服务
 *   · 证书类 → HTTPS 但证书不对
 */
function describeNetError (error, base) {
  const code = error?.cause?.code || ''
  // ⚠️ 有些失败没有 code，只有 message（实测：端口非法时 cause.message = 'bad port'）。
  //    兜底把 cause.message 也拿来匹配，别让这类错误掉进最后的泛泛文案。
  const causeMsg = String(error?.cause?.message || '')
  const host = base.replace(/^https?:\/\//i, '').split('/')[0]

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `解析不出地址「${host}」—— 检查地址拼写，或这台机器连不上那个域名`
  }
  if (code === 'ECONNREFUSED') {
    return `连不上 ${host}：对方拒绝了连接（服务没跑或端口不对）`
  }
  if (code === 'ECONNRESET') {
    return `连接被 ${host} 掐断 —— 中途断的，可能是网络不稳，重试一次`
  }
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return `连不上 ${host}（网络不通）—— 地址或端口可能不对`
  }
  if (/bad port|invalid port/i.test(causeMsg)) {
    return `地址里的端口不对（${host}）—— 端口要写 1~65535，或者干脆不写`
  }
  if (/CERT|SSL|TLS|UNABLE_TO_VERIFY/i.test(code) || /certificate|self.signed/i.test(causeMsg)) {
    return `HTTPS 证书校验没过（${host}）—— 地址换成 http:// 试试`
  }
  if (error?.name === 'TimeoutError') {
    // 超时是**最没有信息量**的一种：请求发出去了，但一直没人回。
    // 把「大概率是什么」直接写出来，省得用户只看到「检查地址和网络」干瞪眼。
    return `连服务器超时（${host}）—— 对方端口可能没对外放行`
  }
  return `连不上分发服务（${error?.message || '未知错误'}）`
}

/**
 * 下载代码包到内存。观战包 ~100KB、消息包瘦身后几十 KB，进内存完全没问题。
 *
 * @param {object} [opts.logger] 传了就顺手记一条原始错误（排查用）
 * @returns {Promise<{ok: boolean, buffer?: Buffer, sha?: string, message?: string}>}
 */
export async function downloadPackage ({ name, sha, url, token, timeout = 180000, logger } = {}) {
  const base = normalizeBase(url)
  if (!base) return { ok: false, message: '还没配分发服务地址' }

  const query = sha ? `?sha=${encodeURIComponent(sha)}` : ''
  try {
    const res = await fetch(`${base}/api/v1/packages/${encodeURIComponent(name)}/download${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeout)
    })

    if (res.status === 401) return { ok: false, message: '令牌无效，找主人要一个新的' }
    if (res.status === 403) return { ok: false, message: '令牌已被吊销，找主人要一个新的' }
    if (res.status === 404) return { ok: false, message: `服务器上没有「${name}」这个包` }
    if (res.status === 429) return { ok: false, message: '请求太频繁，过一会儿再试' }
    if (!res.ok) return { ok: false, message: `下载失败（HTTP ${res.status}）` }

    const buffer = Buffer.from(await res.arrayBuffer())
    return { ok: true, buffer, sha: res.headers.get('x-gok-sha') || sha }
  } catch (error) {
    // 下载阶段超时通常是网络慢或包太大，和「连不上」是两回事，文案分开
    logger?.warn?.(`[deploy] 下载 ${name} 失败：${error?.name} ${error?.message} code=${error?.cause?.code || '-'}`)
    const msg = error?.name === 'TimeoutError'
      ? '下载超时（网络慢或包太大，重试一次）'
      : describeNetError(error, base).replace(/^连不上分发服务/, '下载中断')
    return { ok: false, message: msg }
  }
}

/* ------------------------------------------------------------ 一站式安装 */

/**
 * 按台账核对「装上去的那份文件现在还对不对」。
 *
 * ⚠️⚠️ 为什么需要它（2026-10-05 修）：`installPackage` 原来只比 `state.sha === meta.sha`
 *    就认为「已是最新」，**完全不看盘上的文件**。只要台账被人为或异常情况写歪一次
 *    （实测主人这台机器上：台账记 `6ba6262`，而 `server/watch-server.js` 的内容
 *    逐字节等于 `767090e` —— 有人手工替换过文件），此后每次 `#营地观战部署`
 *    都会：先判「版本没变、不用更新」→ 只重启进程 → **台账永远停在旧 sha**。
 *    于是台账再也回答不了「线上跑的是哪个版本」。
 *
 *    改成同时核对文件大小：任何一个记录在案的文件丢了、或者大小对不上，
 *    就当「装的那份不对」→ 走完整下载+解压流程，顺手把台账写正。
 *    用大小而不是哈希：服务端包 ~160KB、十几个文件，`statSync` 是微秒级，
 *    而算哈希要把每个文件都读一遍 —— 这个函数每次部署/查状态都会调到，不值得。
 *    （大小对不上一定有问题；大小凑巧相同的改动，靠上游 sha 变化兜住。）
 *
 * @returns {{ok: boolean, bad?: string}} ok=false 时 `bad` 是第一个对不上的文件
 */
function verifyInstalled (destDir, state) {
  if (!state || !Array.isArray(state.files) || !state.files.length) return { ok: false, bad: '(台账没有文件清单)' }
  const sizes = state.sizes && typeof state.sizes === 'object' ? state.sizes : null
  // 老台账没记 sizes（升级前装的）→ 没法核对，只能认它是最新的（下次部署会补上 sizes）
  if (!sizes) return { ok: true }
  for (const rel of state.files) {
    const abs = path.join(destDir, rel)
    try {
      const st = fs.statSync(abs)
      if (!st.isFile()) return { ok: false, bad: rel }
      const want = sizes[rel]
      if (typeof want === 'number' && st.size !== want) return { ok: false, bad: rel }
    } catch {
      return { ok: false, bad: rel }
    }
  }
  return { ok: true }
}

/**
 * 查版本 → 比对本地 → 按需下载 → 解压 → 清旧文件 → 写台账。
 *
 * @param {object} opts
 * @param {string} opts.name      包名（`watch` / `im`）
 * @param {string} opts.url       分发服务地址
 * @param {string} opts.token     令牌
 * @param {string} opts.destDir   解到哪
 * @param {string} [opts.entry]   入口文件的相对路径，用来判断「装没装过」
 * @param {string[]} [opts.exclude]
 * @param {object} [opts.logger]
 * @returns {Promise<{ok: boolean, sha?: string, updated?: boolean, files?: string[], bytes?: number, message?: string}>}
 */
export async function installPackage ({
  name, url, token, destDir, entry, exclude = DEFAULT_EXCLUDE, logger
} = {}) {
  const meta = await fetchPackageMeta({ name, url, token, logger })
  if (!meta.ok) return { ok: false, message: meta.message }

  const state = readInstallState(destDir)
  const entryOk = entry ? fs.existsSync(path.join(destDir, entry)) : true

  // 版本没变、文件也齐**而且内容对得上** → 什么都不做，让调用方直接去重启进程
  // ⚠️ 那个 verifyInstalled 不能省：只看 sha 的话，文件被手工换过也照样判「已是最新」，
  //    台账就永远停在旧 sha（见 verifyInstalled 的注释）
  const intact = verifyInstalled(destDir, state)
  if (state?.sha === meta.sha && entryOk && intact.ok) {
    return { ok: true, sha: meta.sha, updated: false, files: state.files || [] }
  }
  if (state?.sha === meta.sha && !intact.ok) {
    logger?.mark?.(`[deploy] ${name} 台账记的是最新版，但 ${intact.bad} 与记录不符，重新装一遍`)
  }

  const down = await downloadPackage({ name, sha: meta.sha, url, token, logger })
  if (!down.ok) return { ok: false, message: down.message }

  let result
  try {
    result = extractTarGz(down.buffer, destDir, { exclude })
  } catch (error) {
    return { ok: false, message: `解压失败（包可能损坏）：${error?.message || error}` }
  }

  // ⚠️ 一个文件都没解出来 = 包不对（空包、被截断、格式变了）。
  //    这时候**绝对不能往下走清理** —— 台账里记的旧文件会被当成「上游删掉的」
  //    全部删光，等于把已装的服务端毁掉。
  if (!result.files.length) {
    return { ok: false, message: '包解开是空的，没敢动已装的文件' }
  }

  // 上游删掉的文件，靠台账补删
  const removed = pruneRemoved(destDir, state?.files, result.files, logger)

  // ⭐ 顺手记下每个文件的大小 —— 下次判断「要不要重装」时拿它核对实际内容
  //    （见 verifyInstalled；没有它，文件被换掉也发现不了）
  const sizes = {}
  for (const rel of result.files) {
    try { sizes[rel] = fs.statSync(path.join(destDir, rel)).size } catch {}
  }

  writeInstallState(destDir, {
    name,
    sha: meta.sha,
    files: result.files,
    sizes,
    installedAt: new Date().toISOString()
  }, logger)

  logger?.mark?.(
    `[deploy] ${name} 已更新到 ${String(meta.sha).slice(0, 8)}：` +
    `${result.files.length} 个文件${removed.length ? `，清掉 ${removed.length} 个旧文件` : ''}`
  )

  return {
    ok: true,
    sha: meta.sha,
    updated: true,
    files: result.files,
    bytes: result.bytes,
    removed
  }
}

/* ------------------------------------------------------------ 状态探测 */

/** 探一次服务端状态接口。连不上返回 null（不抛） */
export async function probeStatus (port, statusPath = '/api/status', timeout = 2500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${statusPath}`, {
      signal: AbortSignal.timeout(timeout)
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/**
 * 探「这个端口上是不是**控制面**」。
 *
 * ⚠️⚠️ 为什么不能用 `probeStatus`（2026-10-05 修）：那个探的是 `/api/status`，
 *    而控制面（8898）和播放面（8899）**都有**这个接口 —— 拿它当健康检查，
 *    用户在配置里填了播放面端口时照样一路绿灯，可 `/api/friends` `/api/start`
 *    全是 404：「#营地观战服务」显示运行中、发指令却说拿不到好友列表，无从下手。
 *    这里改探**控制面独有**的 `/api/rooms`（只读、零营地请求），它通才叫「指挥得动」。
 */
export async function probeControlPort (port, timeout = 2500) {
  return probeStatus(port, '/api/rooms', timeout)
}

/** 等控制面起来（pm2 拉起到真正监听之间有几百毫秒的空窗） */
export async function waitControlPort (port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await probeControlPort(port)
    if (s?.ok) return s
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return null
}

/** 等它起来（pm2 拉起到真正监听之间有几百毫秒的空窗） */
export async function waitStatus (port, statusPath = '/api/status', timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await probeStatus(port, statusPath)
    if (s) return s
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return null
}

/** 毫秒 → 「N 小时 M 分」 */
export function fmtUptime (ms) {
  if (!ms || ms < 0) return '—'
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`
}
