/**
 * 营地ID 共享库的客户端。
 *
 * ## 它解决什么
 *
 * 用户在 A 群的机器人上绑过营地ID，被拉到 B 群（另一个 bot 主人搭的实例）时，
 * 发 `#查询战绩` 不用重新绑定——本地 `data/UserData.yaml` 里找不到时，去共享库问一句。
 *
 * ## 三条硬约束
 *
 * 1. **只在「用户当场发的查询指令」里生效**。推送、排行榜、`#谁在打游戏`、日报周报
 *    一律只认本地绑定：那些路径要么在同步的 read-modify-write 块里（插 `await` 会让它
 *    变成可交错、整表覆盖丢写），要么会把解析出的营地ID 固化进订阅文件。
 * 2. **绝不抛异常、绝不阻塞指令**。共享库是别人搭的、随时可能下线，它挂了只能是
 *    「这次查不到」，不能是「王者插件用不了」。所以全程 catch + 熔断 + 缓存兜底。
 * 3. **本地绑定永远优先**。本机绑过的人连一次网络请求都不会发。
 *
 * ## 缓存分层
 *
 *   本地 UserData.yaml（同步，命中即返回）
 *     → 内存 Map（5 秒，只做连发防抖，不是长期缓存）
 *       → in-flight 合并（冷启动时并发同 QQ 只发一次请求）
 *         → 落盘 data/share/idcache.yaml（重启后第一条指令也不慢）
 *           → 网络（1.5 秒超时，失败有熔断）
 */
import path from 'node:path'
import fetch from 'node-fetch'
import { PluginData, Config } from '#components'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'
import { quarantineCorrupt } from './safeStore.js'
import { getCurrentId, getBoundIds, readUserData } from './localBind.js'
import authStore from './authStore.js'

const CACHE_FILE = path.join(PluginData, 'share', 'idcache.yaml')
const CACHE_SCHEMA = 1

/**
 * 令牌在群里露个形就够，别整串贴出去。
 *
 * 放在这里而不是各自 app 里：`#营地共享`（用户侧）和 `#营地共享库`
 * （主人侧）都要显示令牌，两份实现早晚会分叉 —— 真踩过：shareDeploy 引用了
 * shareBind 里的私有函数，运行到那行才 `ReferenceError: maskToken is not defined`。
 */
export const maskToken = token => {
  const text = String(token || '')
  if (text.length <= 10) return text ? '已配置' : '未配置'
  return `${text.slice(0, 6)}…${text.slice(-4)}`
}

/**
 * 本地缓存的存活时间。
 *
 * 只有 5 秒 —— 它现在唯一的作用是「同一个用户连发几条指令时不重复问服务端」，
 * **不是**省请求。真正省请求的是服务端那边的 `since` 比对（没变更时只回 40 字节）。
 *
 * 原先设的是正值 2 小时、负值 30 分钟，那是按「省流量」想的。代价是用户在 A 机器人上
 * 刚开启共享，B 机器人最长要等 2 小时才看得到 —— 这个取舍不划算：共享的意义就是
 * 「换个机器人马上能用」，让它等两小时等于把功能的意义削掉一半。
 */
const CACHE_TTL_MS = 5000

/** 读请求超时。用户指令在等，宁可查不到也不能卡住 */
const READ_TIMEOUT_MS = 1500

/** 写请求（上传/撤销）是用户主动触发的，可以多等一会儿 */
const WRITE_TIMEOUT_MS = 5000

/** 连续失败几次开始熔断 */
const CIRCUIT_THRESHOLD = 3
const CIRCUIT_BASE_MS = 60 * 1000
const CIRCUIT_MAX_MS = 10 * 60 * 1000

/** 落盘缓存整份丢弃重建的时限，防止 qq 键无限增长 */
const DISK_MAX_AGE_MS = 24 * 3600 * 1000

/** 当轮已经合并过、不必重复请求的 QQ。查询合并用，见 inflight 的注释 */
const inflight = new Map()

/**
 * 「这个 QQ 在共享库里有记录」的本地标记 —— 也就是「他开过共享」。
 *
 * 为什么需要它：用户在 A 机器人上开了共享，跑到 B 机器人上又绑了个新号。
 * B 这边的本地开关是关的（他从没在 B 上开过），按本地开关判断就**不会把新号传上去**，
 * 于是 A 那边永远看不到 B 的这个号。可「我开了共享」是个**跨机器人的意愿**，
 * 不该因为在哪台机器上开的有区别。
 *
 * 判据换成「库里还有没有你的记录」就天然自洽了：你一旦关掉共享，服务端会删记录并立墓碑，
 * 别的机器人再查你就是 404，也就不会再替你上传了。
 */
const knownShared = new Map()

/** 同一个 QQ 多久对一次账。库里数据变得很慢，每小时一次足够 */
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000
const lastReconcileAt = new Map()

/** qq -> {campId, until, fetchedAt, updatedAt}。campId 为空串表示「确认没有」 */
const memoryCache = new Map()

/**
 * 每个 QQ 一个代号。任何「本地绑定被改动」都会把代号加一，
 * 用来丢弃那些「发出时还没撤销、回来时已经撤销」的在途响应。
 */
const generation = new Map()

const circuit = { failures: 0, openUntil: 0, backoffMs: CIRCUIT_BASE_MS }

/** 日志节流：一个挂掉的服务端不该把日志刷爆 */
const warnAt = new Map()

let diskLoaded = false
let flushTimer = null

/* --------------------------------------------------------------- 文案 */

/** 调用点拿到 source === 'none' 时用这句（和插件原有的未绑定提示保持一字不差） */
export const NOT_BOUND_HINT = '你还没有绑定营地ID，先发送 #绑定营地 [营地ID]'

/**
 * 调用点拿到 source === 'degraded' 时用这句。
 * 按「说人话、不给用户看实现细节、要用户动手的给出可直接照做的指令」来写。
 */
export const SHARE_DEGRADED_HINT =
  '共享库暂时用不了，稍后再试。也可以直接发 #绑定营地 [营地ID] 绑到本机'

/* --------------------------------------------------------------- 基础工具 */

function warnOnce (key, message) {
  const now = Date.now()
  if (now - (warnAt.get(key) || 0) < 300000) return

  warnAt.set(key, now)
  try { logger?.warn?.(message) } catch {}
}

/**
 * 读共享库相关的配置。每次现读，这样锅巴里改了立刻生效（Config 有文件监听会清缓存）。
 *
 * @returns {{enabled: boolean, apiUrl: string, token: string, adminSecret: string}}
 */
export function readShareConfig () {
  try {
    const cfg = Config.getDefOrConfig('config') || {}
    return {
      enabled: cfg.shareEnabled === true,
      apiUrl: String(cfg.shareApiUrl || '').trim().replace(/\/+$/, ''),
      // ⚠️ 令牌**和观战/消息共用同一个**（`distToken`）—— 主人签发时是「代共享库签」的，
      //    所以一个值两边都认。锅巴里也只填一处。
      //    回退读老的 `shareToken`：合并之前配过的机器不用重新填。
      token: String(cfg.distToken || cfg.shareToken || '').trim(),
      // 远程管理用的钥匙（服务端 GOK_ADMIN_SECRET）。只有运维指令用它，
      // 和接入用的 token 是两码事，缺了只影响发令牌那些，不影响接入
      adminSecret: String(cfg.shareAdminSecret || '').trim()
    }
  } catch {
    return { enabled: false, apiUrl: '', token: '', adminSecret: '' }
  }
}

/**
 * 三项都配齐了才算「接入」。缺任何一项都当没接入处理——
 * 那种情况下用户看到的是正常的「你还没有绑定营地ID」，而不是一个莫名其妙的报错。
 */
export function isShareReady () {
  const cfg = readShareConfig()
  return Boolean(cfg.enabled && cfg.apiUrl && cfg.token)
}

/**
 * 本机有没有可查别人号的公共登录态。没有的话，共享库给了营地ID 也查不动。
 *
 * 刻意不做 memo：它只在「网络往返成功之后」才会被调到，频率极低；
 * 而加了 memo 就会出现「主人刚扫完码全局登录，
 * 接下来半分钟共享还是判定成用不了」这种说不清的滞后。
 */
function hasUsableGlobalAccount () {
  try {
    return authStore.listAccounts().some(account => account.isGlobalDefault && !account.authInvalid)
  } catch {
    return false
  }
}

/* --------------------------------------------------------------- 落盘缓存 */

function loadDiskCache () {
  if (diskLoaded) return
  diskLoaded = true

  try {
    const raw = readYamlFile(CACHE_FILE)
    if (!raw || raw.schema !== CACHE_SCHEMA) return
    if (!raw.savedAt || Date.now() - Number(raw.savedAt) > DISK_MAX_AGE_MS) return

    const entries = raw.entries && typeof raw.entries === 'object' ? raw.entries : {}

    const now = Date.now()
    for (const [qq, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== 'object') continue
      if (Number(entry.until) <= now) continue
      memoryCache.set(qq, {
        campId: String(entry.campId || ''),
        until: Number(entry.until) || 0,
        fetchedAt: Number(entry.fetchedAt) || 0,
        updatedAt: Number(entry.updatedAt) || 0
      })
    }
  } catch (error) {
    // 缓存是可再生的，坏了直接丢弃重来，绝不因此阻塞任何指令
    if (error?.code !== 'ENOENT') {
      quarantineCorrupt(CACHE_FILE, error, '[营地共享]')
    }
  }
}

/** 落盘走 30 秒 debounce：查询是高频路径，没必要每来一条就写一次盘 */
function scheduleFlush () {
  if (flushTimer) return

  flushTimer = setTimeout(() => {
    flushTimer = null
    flushDiskCache()
  }, 30000)
  flushTimer.unref?.()
}

function flushDiskCache () {
  try {
    const now = Date.now()
    const entries = {}

    for (const [qq, entry] of memoryCache) {
      if (entry.until <= now) continue
      entries[qq] = {
        campId: entry.campId,
        until: entry.until,
        fetchedAt: entry.fetchedAt,
        updatedAt: entry.updatedAt
      }
    }

    // 直接整份覆盖：缓存内容全在 memoryCache 里，不需要先读盘再合并
    writeYamlFile(CACHE_FILE, { schema: CACHE_SCHEMA, savedAt: now, entries })
  } catch (error) {
    warnOnce('flush', `[营地共享] 缓存落盘失败：${error.message}`)
  }
}

/** 进程退出前把脏数据刷下去。pm2 restart 时会走到这里 */
function flushNow () {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flushDiskCache()
}

/**
 * 进程退出前把脏数据刷下去（pm2 restart 会走到这里）。
 *
 * 用 'exit' 而不是 SIGINT/SIGTERM：宿主 Yunzai 自己也在监听这两个信号，
 * 多挂一个监听器会让「默认退出行为」失效——两边都不 exit 的话进程就停不下来了。
 * 'exit' 只是被通知，不改变退出流程，而且这里做的全是同步写盘，正好合规。
 */
process.once('exit', flushNow)

/* --------------------------------------------------------------- 缓存读写 */

function readMemory (qq) {
  loadDiskCache()
  return memoryCache.get(qq)
}

function writeMemory (qq, { campId, ttlMs, updatedAt }) {
  const now = Date.now()
  memoryCache.set(qq, {
    campId: String(campId || ''),
    until: now + ttlMs,
    fetchedAt: now,
    updatedAt: Number(updatedAt) || 0
  })
  scheduleFlush()
}

/**
 * 让某个 QQ 的缓存立刻失效。
 *
 * **任何对 UserData.yaml 中该 QQ 的写入之后都必须调它**：
 * 绑定时是为了让本地值干净地压住缓存值，删除/切换时是必须的——
 * 否则缓存里那份共享值会在用户已经删掉之后继续被解析出来。
 */
export function invalidateShareCache (userId) {
  const qq = String(userId || '').trim()
  if (!qq) return

  generation.set(qq, (generation.get(qq) || 0) + 1)
  memoryCache.delete(qq)
  // 盘上的那份不用单独删：flushDiskCache 是拿 memoryCache 整份重建的
  scheduleFlush()
}

/* --------------------------------------------------------------- 网络 */

function shareHeaders (token) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  }
}

/** 熔断期间直接跳过网络，别让每条指令都干等 1.5 秒 */
function circuitOpen () {
  return Date.now() < circuit.openUntil
}

function recordFailure (reason) {
  circuit.failures += 1
  if (circuit.failures >= CIRCUIT_THRESHOLD) {
    circuit.openUntil = Date.now() + circuit.backoffMs
    // 指数退避到 10 分钟封顶：服务端长时间不可用时，别每 60 秒就再去试一次
    circuit.backoffMs = Math.min(circuit.backoffMs * 2, CIRCUIT_MAX_MS)
    warnOnce(`circuit:${reason}`, `[营地共享] 连续失败 ${circuit.failures} 次，暂停 ${Math.round(circuit.backoffMs / 1000)} 秒后再试`)
  }
}

function recordSuccess () {
  circuit.failures = 0
  circuit.backoffMs = CIRCUIT_BASE_MS
  circuit.openUntil = 0
}

/**
 * 手动复位熔断。
 * 服务端已经恢复了、但指数退避的时间还没走到时会用得上；
 * 脱机测试跑完「服务端不可达」那组用例后也要靠它接着测正常路径。
 */
export function resetCircuitBreaker () {
  recordSuccess()
}

/**
 * 查询一次共享库。
 *
 * @returns {Promise<{campId: string, updatedAt: number}|{unchanged: true}|null>}
 *   返回 null 表示服务端明确说「这个 QQ 没共享过」
 */
async function requestShare (cfg, qq, since) {
  const response = await fetch(`${cfg.apiUrl}/api/v1/bind/query`, {
    method: 'POST',
    headers: shareHeaders(cfg.token),
    body: JSON.stringify({ qq, since: Number(since) || 0 }),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS)
  })

  // 404 = 确认没共享过，是正常结果不是错误
  if (response.status === 404) return null

  if (response.status === 401 || response.status === 403) {
    // 配置问题，重试多少次都一样，用单独的 key 免得和网络故障的日志混在一起
    const error = new Error(`共享库拒绝了这次请求（${response.status}），检查令牌是否有效`)
    error.shareAuthFailed = true
    throw error
  }

  if (!response.ok) {
    throw new Error(`共享库返回 ${response.status}`)
  }

  const data = await response.json()
  if (data?.unchanged) return { unchanged: true, updatedAt: Number(data.updatedAt) || 0 }

  const ids = Array.isArray(data?.campIds) ? data.campIds.map(String) : []
  const picked = String(data?.current || '')
  const campId = ids.includes(picked) ? picked : (ids[0] || '')

  return { campId, campIds: ids, updatedAt: Number(data?.updatedAt) || Date.now() }
}

const USER_DATA_FILE = path.join(PluginData, 'UserData.yaml')

/**
 * 把共享库拿到的绑定**落到本机** `UserData.yaml`，并打上 `fromShare` 标记。
 *
 * 这就是「上传到库里、库里再下发到同步端」里**下发**的那一步，也是唯一治本的做法：
 * 插件里有二十多处**直接读 `UserData.yaml`** 的地方（`#查询战绩`、`#皮肤墙`、
 * `#我的英雄`、排行榜、`#谁在打游戏`…），它们不走 `getCurrentId`，所以共享怎么改
 * 它们都认不到。逐个去改那些读取点永远会漏 —— 真踩过：当初只改了调 `getCurrentId`
 * 的 12 处，结果最常用的 `#查询战绩` 恰好是直接读文件的那个。
 *
 * 落地之后就一劳永逸：全插件所有读绑定的地方自动都认。
 *
 * 本机**已经有绑定**的不动（本地优先，用户在哪儿绑的以哪儿为准）。
 */
function adoptSharedBind (qq, campIds, currentCampId) {
  try {
    const data = readUserData()
    const existing = data[qq]
    if (existing && Array.isArray(existing.ids) && existing.ids.length) return

    data[qq] = {
      ids: [...campIds],
      current: Math.max(0, campIds.indexOf(currentCampId)),
      // 标记来源：好让「关闭共享」时能把这份清掉，也不跟用户自己绑的混为一谈
      fromShare: true,
      sharedAt: Date.now()
    }
    writeYamlFile(USER_DATA_FILE, data)

    logger?.debug?.(`[营地共享] ${qq} 的绑定已从共享库落到本机（${campIds.length} 个）`)
  } catch (error) {
    warnOnce('adopt', `[营地共享] 落地到本机失败：${error?.message || error}`)
  }
}

/** 把「从共享库落下来的」那份清掉。用户关共享、或者库里没他时调 */
export function dropAdoptedBind (qq) {
  try {
    const data = readUserData()
    if (!data[qq]?.fromShare) return

    delete data[qq]
    writeYamlFile(USER_DATA_FILE, data)
    logger?.debug?.(`[营地共享] ${qq} 从共享库落到本机的那份已清除`)
  } catch (error) {
    warnOnce('adopt-drop', `[营地共享] 清理落地数据失败：${error?.message || error}`)
  }
}

/* --------------------------------------------------------------- 对账 */

/**
 * 本地**有绑定**的用户，后台和共享库对一次账。
 *
 * 解决这个场景：用户在 A 机器人上开了共享，又跑到 B 机器人上绑了个新号。
 * B 这边的本地开关是关的（他从没在 B 上开过），按本地开关判断就不会上传 ——
 * 于是 A 那边永远看不到 B 这个号。可「我开了共享」是个**跨机器人的意愿**。
 *
 * 对账的判据是「库里还有没有你的记录」：有，说明你开着共享，B 这边的绑定也跟着上去。
 * 你一旦关掉共享，服务端会删记录并立墓碑，别的机器人再查你就是 404，
 * 自然也就不会再替你上传了 —— 不需要额外的同步协议。
 *
 * 三条自我约束：
 *  - **绝不阻塞、绝不抛**：它挂在 resolveCurrentId 的本地命中分支上，用户那条指令
 *    该多快还多快，对账成不成功都不影响他
 *  - 每个 QQ 每小时最多一次
 *  - 本机没有绑定就什么都不做（没东西可传）
 */
/** 从共享库落下来的那份，多久回去跟库对一次 */
const ADOPTED_RECONCILE_MS = 5 * 60 * 1000

/** 本机这份绑定是不是「从共享库落下来的」 */
function isAdoptedBind (qq) {
  try {
    return readUserData()[qq]?.fromShare === true
  } catch {
    return false
  }
}

async function reconcileSharedUser (qq, { force = false } = {}) {
  try {
    const now = Date.now()

    // 落下来的那份要跟紧一点：本地优先会让它一直生效，而用户随时可能在
    // 别的机器人上撤销共享。自己绑的不用管，一小时后对一次就够
    const interval = isAdoptedBind(qq) ? ADOPTED_RECONCILE_MS : RECONCILE_INTERVAL_MS
    if (!force && now - (lastReconcileAt.get(qq) || 0) < interval) return
    lastReconcileAt.set(qq, now)

    const cfg = readShareConfig()
    if (!cfg.enabled || !cfg.apiUrl || !cfg.token) return
    if (circuitOpen()) return

    const ids = getBoundIds(qq)
    if (!ids.length) return

    // 本机这份要是**从共享库落下来的**，就只确认库里还有他、别把它传回去 ——
    // 那不是他在这台机器上绑的号，传上去等于把自己刚拿到的东西又还回去，来回覆盖
    if (isAdoptedBind(qq)) {
      const current = await requestShare(cfg, qq, 0)
      if (!current?.campId) {
        knownShared.delete(qq)
        dropAdoptedBind(qq)
      }
      return
    }

    const result = await requestShare(cfg, qq, 0)
    if (!result?.campId) {
      // 库里没有他了 —— 说明他撤销了共享（服务端会留墓碑，这里也是 404）。
      // 标记要摘、本机那份落下来的也要清，否则本机新绑的号会被一直传上去
      knownShared.delete(qq)
      dropAdoptedBind(qq)
      return
    }

    knownShared.set(qq, true)

    // 传一次就行：PUT 是「本实例的全量替换」，天然的幂等
    const pushed = await pushBind(qq, ids, getCurrentId(qq) || '')
    if (pushed.ok) {
      logger?.debug?.(`[营地共享] ${qq} 在别的机器人上开过共享，本机这 ${ids.length} 个绑定已同步过去`)
    }
  } catch (error) {
    warnOnce('reconcile', `[营地共享] 对账失败：${error?.message || error}`)
  }
}

/**
 * 手动对一次账（跳过每小时一次的节流）。给「手动同步」那两条指令用 ——
 * 自动对账是后台跑的、又有一小时的节流，用户觉得「我明明开了共享对方却查不到」时
 * 需要一个立刻能试的按钮。
 *
 * @returns {Promise<'shared'|'not-shared'|'failed'>}
 *   shared    = 库里有他，本机绑定已经传上去了
 *   not-shared= 库里没有他（没开共享，或者已经撤销了）
 *   failed    = 连不上或配置不全
 */
export async function reconcileNow (userId) {
  const qq = String(userId ?? '').trim()
  if (!qq) return 'failed'

  const cfg = readShareConfig()
  if (!cfg.enabled || !cfg.apiUrl || !cfg.token) return 'failed'
  if (circuitOpen()) return 'failed'

  const ids = getBoundIds(qq)
  if (!ids.length) return 'not-shared'

  // 同上：本机这份是从库里落下来的，就别往库里传了
  if (isAdoptedBind(qq)) {
    try {
      const current = await requestShare(cfg, qq, 0)
      if (!current?.campId) {
        knownShared.delete(qq)
        dropAdoptedBind(qq)
        return 'not-shared'
      }
      return 'shared'
    } catch (error) {
      warnOnce('reconcile-now', `[营地共享] 手动对账失败：${error?.message || error}`)
      return 'failed'
    }
  }

  try {
    const result = await requestShare(cfg, qq, 0)
    if (!result?.campId) {
      knownShared.delete(qq)
      dropAdoptedBind(qq)
      return 'not-shared'
    }

    knownShared.set(qq, true)
    const pushed = await pushBind(qq, ids, getCurrentId(qq) || '')
    return pushed.ok ? 'shared' : 'failed'
  } catch (error) {
    warnOnce('reconcile-now', `[营地共享] 手动对账失败：${error?.message || error}`)
    return 'failed'
  }
}

/**
 * 这个 QQ 是不是「开过共享的人」。
 * 供 utils/shareUsers.js 判断「本机绑定变了要不要往上传」。
 */
export function isKnownShared (userId) {
  return knownShared.get(String(userId ?? '').trim()) === true
}

/* --------------------------------------------------------------- 对外主函数 */

/**
 * 解析某个 QQ 当前该用的营地ID。
 *
 * @param {string|number} userId
 * @param {{share?: boolean}} [options] share=false 时只认本地（cron、遍历成员的场景用）
 * @returns {Promise<{campId: string|null, source: 'local'|'cache'|'shared'|'none'|'degraded',
 *                    reason?: string}>}
 *   source='none'     确认没有（本机没绑、共享库也明确说没有）
 *   source='degraded' 本机没有、且共享库不可用 / 本机缺公共登录态 —— 提示语必须不一样，
 *                     否则用户会被引导去重新绑定，而绑定之后本机值会盖住共享值，共享就永远失效了
 */
export async function resolveCurrentId (userId, options = {}) {
  const result = await resolveCurrentIdInner(userId, options)
  // 把「该说哪句话」一并带出去，省得十几个调用点各自写一遍 source 判断
  return { ...result, hint: result.source === 'degraded' ? SHARE_DEGRADED_HINT : NOT_BOUND_HINT }
}

/**
 * 读绑定表；**本机没有这个人的绑定时**先去共享库问一次、落下来，再读。
 *
 * 给「直接读 `UserData.yaml`」的那批指令用（`#查询战绩`、`#王者主页`、各种表现…）。
 * 它们在本地找不到人就回一张「怎么获取营地ID」的教程图 —— 可用户明明在别的机器人上
 * 绑过，只是本机没这份记录。
 *
 * 为什么单开一个函数：下发（`adoptSharedBind`）原本只挂在 `resolveCurrentId` 里，
 * 而这批指令**压根不调它**，所以永远等不到下发 —— 落地等于白做了。把它们逐个改成
 * 调 `resolveCurrentId` 也行，但每处都要重写一遍「重新读文件、重新取当前号」，
 * 十几处一定会有漏。这里一次读全表，调用方拿到的就是落地之后的表，写法跟原来一样。
 *
 * 「本机已有绑定」的零网络开销：`getBoundIds` 命中就直接返回，连内存缓存都不查。
 */
export async function resolveUserData (userId) {
  const qq = String(userId ?? '').trim()

  if (qq && !getBoundIds(qq).length) {
    try {
      const { campId } = await resolveCurrentId(qq)
      // 拿到就说明 adoptSharedBind 已经写进文件了，重读一次即可
      if (campId) return readUserData()
    } catch {
      // 共享库是别人搭的、随时可能下线：它出任何事都只能是「这次查不到」，
      // 不能让用户的指令跟着失败。读不到就按本机没有处理
    }
  }

  return readUserData()
}

async function resolveCurrentIdInner (userId, { share = true } = {}) {
  const qq = String(userId ?? '').trim()
  if (!qq) return { campId: null, source: 'none' }

  // 本地永远优先。本机绑过的人连缓存都不用查
  const local = getCurrentId(qq)
  if (local) {
    // 顺手后台对一次账：他在别的机器人上开过共享的话，本机这组绑定也该传上去。
    // 不 await —— 用户这条指令该多快还多快，对账是它自己的事
    reconcileSharedUser(qq).catch(() => {})
    return { campId: local, source: 'local' }
  }

  if (!share) return { campId: null, source: 'none' }

  const cfg = readShareConfig()
  if (!cfg.enabled || !cfg.apiUrl || !cfg.token) {
    // 没接入就当没这回事，用户看到的是正常的「你还没有绑定营地ID」
    return { campId: null, source: 'none' }
  }

  const now = Date.now()
  const cached = readMemory(qq)

  if (cached && cached.until > now) {
    return cached.campId
      ? { campId: cached.campId, source: 'cache' }
      : { campId: null, source: 'none' }
  }

  if (circuitOpen()) {
    return fallback(cached, 'circuit')
  }

  // 并发同 QQ 合并成一次请求（冷启动时同一批指令会撞在这里）
  const pending = inflight.get(qq)
  if (pending) return pending

  const startedAtGeneration = generation.get(qq) || 0
  const task = (async () => {
    try {
      const result = await requestShare(cfg, qq, cached?.updatedAt || 0)

      // 期间用户改过本地绑定或撤销了共享，这次响应已经过期，丢掉不写缓存
      if ((generation.get(qq) || 0) !== startedAtGeneration) {
        return { campId: null, source: 'none' }
      }

      recordSuccess()

      if (result?.unchanged) {
        // 服务端说没变，把缓存里的值续命
        if (cached) {
          writeMemory(qq, { campId: cached.campId, ttlMs: CACHE_TTL_MS, updatedAt: cached.updatedAt })
          return cached.campId ? { campId: cached.campId, source: 'cache' } : { campId: null, source: 'none' }
        }
        return { campId: null, source: 'none' }
      }

      if (!result) {
        // 库里没有他（或者他已经撤销了）—— 把「开过共享」的标记摘掉，
        // 否则本机新绑的号还会被一直传上去；顺带清掉之前落下来的那份
        knownShared.delete(qq)
        dropAdoptedBind(qq)
        writeMemory(qq, { campId: '', ttlMs: CACHE_TTL_MS })
        return { campId: null, source: 'none' }
      }

      knownShared.set(qq, true)

      // 拿到了营地ID，但本机没有能查别人号的公共登录态 —— 给了也用不了，
      // 这时候必须说成 degraded，否则用户会照着「未绑定」的提示去重新绑一遍
      if (result.campId && !hasUsableGlobalAccount()) {
        writeMemory(qq, { campId: result.campId, ttlMs: CACHE_TTL_MS, updatedAt: result.updatedAt })
        return { campId: null, source: 'degraded', reason: 'no_global_account' }
      }

      writeMemory(qq, {
        campId: result.campId,
        ttlMs: CACHE_TTL_MS,
        updatedAt: result.updatedAt
      })

      // 「库里下发到同步端」那一步。落到本机之后，所有直接读 UserData.yaml 的指令
      // （#查询战绩、#皮肤墙、排行榜…）也自动认了 —— 详见 adoptSharedBind 的说明
      if (result.campIds?.length) adoptSharedBind(qq, result.campIds, result.campId)

      return result.campId
        ? { campId: result.campId, source: 'shared' }
        : { campId: null, source: 'none' }
    } catch (error) {
      recordFailure(error?.shareAuthFailed ? 'auth' : 'network')
      warnOnce(
        `read:${error?.shareAuthFailed ? 'auth' : 'net'}`,
        `[营地共享] 查询失败：${error?.message || error}`
      )
      return fallback(cached, error?.shareAuthFailed ? 'auth' : 'network')
    } finally {
      inflight.delete(qq)
    }
  })()

  inflight.set(qq, task)
  return task
}

/**
 * 网络不可用时的兜底。
 * 缓存里有过期的正值也照用（stale-while-error）——旧数据总比让用户白跑一趟强，
 * 而且这个值本来就是「别人上次共享的地址」，不会因为服务端挂了就变得有害。
 */
function fallback (cached, reason) {
  if (cached?.campId) return { campId: cached.campId, source: 'cache' }
  return { campId: null, source: 'degraded', reason }
}

/* --------------------------------------------------------------- 上传与撤销 */

/**
 * 把某个 QQ 在本机的全部绑定传到共享库。
 *
 * 空数组直接返回成功不请求：`campIds: []` 在服务端是 422（撤销有专门的 DELETE），
 * 而「本实例一个号都没有」这件事本来就不该去动别的实例贡献的记录。
 *
 * @returns {Promise<{ok: boolean, message?: string, count?: number}>}
 */
export async function pushBind (userId, campIds, currentCampId = '') {
  const qq = String(userId ?? '').trim()
  const ids = Array.isArray(campIds) ? campIds.map(String).filter(Boolean) : []

  if (!qq) return { ok: false, message: '缺少 QQ 号' }
  if (!ids.length) return { ok: true, count: 0 }

  const cfg = readShareConfig()
  if (!cfg.enabled || !cfg.apiUrl || !cfg.token) {
    return { ok: false, message: '还没接入共享库' }
  }

  // 上传失败了缓存里那份旧的共享值就不该再留着
  invalidateShareCache(qq)

  try {
    const response = await fetch(`${cfg.apiUrl}/api/v1/bind`, {
      method: 'PUT',
      headers: shareHeaders(cfg.token),
      body: JSON.stringify({
        qq,
        campIds: ids,
        current: ids.includes(String(currentCampId)) ? String(currentCampId) : ids[0]
      }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS)
    })

    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: '共享库拒绝了这次请求，检查一下令牌' }
    }
    if (!response.ok) {
      return { ok: false, message: `共享库返回 ${response.status}` }
    }

    return { ok: true, count: ids.length }
  } catch (error) {
    warnOnce('push', `[营地共享] 上传失败：${error?.message || error}`)
    return { ok: false, message: '连不上共享库' }
  }
}

/**
 * 撤销共享。**必须真的调服务端删掉**，不能只是「以后不再上传」——
 * 不然别的实例还会一直查到这份数据，用户以为自己已经取消了。
 *
 * @returns {Promise<{ok: boolean, message?: string}>}
 */
export async function revokeBind (userId) {
  const qq = String(userId ?? '').trim()
  if (!qq) return { ok: false, message: '缺少 QQ 号' }

  const cfg = readShareConfig()
  if (!cfg.enabled || !cfg.apiUrl || !cfg.token) {
    return { ok: false, message: '还没接入共享库' }
  }

  invalidateShareCache(qq)

  try {
    const response = await fetch(`${cfg.apiUrl}/api/v1/bind`, {
      method: 'DELETE',
      headers: shareHeaders(cfg.token),
      body: JSON.stringify({ qq }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS)
    })

    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: '共享库拒绝了这次请求，检查一下令牌' }
    }
    if (!response.ok) {
      return { ok: false, message: `共享库返回 ${response.status}` }
    }

    return { ok: true }
  } catch (error) {
    warnOnce('revoke', `[营地共享] 撤销失败：${error?.message || error}`)
    return { ok: false, message: '连不上共享库' }
  }
}

/**
 * 试连一次共享库，用来在主人填完地址/令牌时给出即时反馈。
 *
 * 查一个肯定不会有人绑的 QQ：返回 404 说明「连得上且令牌有效」，
 * 比专门加一个 ping 接口更省事，也不用为此在服务端开一个鉴权豁免的口子。
 *
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function probeShare (cfg = readShareConfig()) {
  if (!cfg.apiUrl) return { ok: false, message: '还没填共享库地址' }
  if (!cfg.token) return { ok: false, message: '还没填共享库令牌' }

  try {
    const response = await fetch(`${cfg.apiUrl}/api/v1/bind/query`, {
      method: 'POST',
      headers: shareHeaders(cfg.token),
      body: JSON.stringify({ qq: '10000000000' }),
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS)
    })

    if (response.status === 404) return { ok: true, message: '连接正常，令牌有效' }
    if (response.status === 401) return { ok: false, message: '令牌无效，找共享库主人要一个新的' }
    if (response.status === 403) return { ok: false, message: '令牌已被吊销' }
    if (response.status === 429) return { ok: true, message: '连接正常（当前被限流，稍后会自动恢复）' }

    return { ok: false, message: `共享库返回了 ${response.status}` }
  } catch (error) {
    warnOnce('probe', `[营地共享] 试连失败：${error?.message || error}`)
    return { ok: false, message: '连不上，检查地址和网络' }
  }
}

/**
 * 直接问库：这个 QQ 在库里有哪些共享记录。
 *
 * 给 `#营地共享库查` 用 —— 排查「对方说查不到我」时，先确认库里到底有没有、
 * 有的话是哪些营地ID。比来回猜「是不是缓存」「是不是要多等一会」快得多。
 *
 * @returns {Promise<{found: boolean, campIds?: string[], current?: string, updatedAt?: number, error?: string}>}
 */
export async function querySharedBind (userId) {
  const qq = String(userId ?? '').trim()
  if (!qq) return { found: false, error: '缺少 QQ 号' }

  const cfg = readShareConfig()
  if (!cfg.enabled || !cfg.apiUrl || !cfg.token) {
    return { found: false, error: '这台还没接入共享库' }
  }

  try {
    const response = await fetch(`${cfg.apiUrl}/api/v1/bind/query`, {
      method: 'POST',
      headers: shareHeaders(cfg.token),
      body: JSON.stringify({ qq }),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS)
    })

    if (response.status === 404) return { found: false }
    if (response.status === 401) return { found: false, error: '令牌无效' }
    if (response.status === 403) return { found: false, error: '令牌已被吊销' }
    if (!response.ok) return { found: false, error: `共享库返回 ${response.status}` }

    const data = await response.json()
    return {
      found: true,
      campIds: Array.isArray(data?.campIds) ? data.campIds.map(String) : [],
      current: String(data?.current || ''),
      updatedAt: Number(data?.updatedAt) || 0
    }
  } catch (error) {
    warnOnce('lookup', `[营地共享] 查询失败：${error?.message || error}`)
    return { found: false, error: '连不上共享库' }
  }
}

/* --------------------------------------------------------------- 状态 */

/** 给 `#营地ID共享状态` 和 `#营地共享库` 用的运行时状态 */
export function getShareStatus () {
  loadDiskCache()

  const now = Date.now()
  let cached = 0
  for (const entry of memoryCache.values()) {
    if (entry.until > now) cached += 1
  }

  return {
    cachedCount: cached,
    circuitOpen: circuitOpen(),
    circuitUntil: circuit.openUntil,
    consecutiveFailures: circuit.failures,
    inflight: inflight.size
  }
}

/** 某个 QQ 的缓存元信息，用来解释「撤销为什么在别的机器人上还没生效」 */
export function getCacheInfo (userId) {
  const qq = String(userId ?? '').trim()
  if (!qq) return null

  const entry = readMemory(qq)
  if (!entry) return null

  return {
    campId: entry.campId,
    fetchedAt: entry.fetchedAt,
    expireAt: entry.until,
    expired: entry.until <= Date.now()
  }
}
