/**
 * 营地消息的本地状态（游标 + 引用映射 + 开关）。
 *
 * 落盘 `data/campIm.yaml`，结构：
 * ```yaml
 * cursor: 123                      # 已处理到的最大消息 id（全局单调，防重启丢/重）
 * refs:                            # 引用回复映射：私信消息 id -> 营地会话信息
 *   "123456": { selfUserId, toUserId, toRoleId, fromRoleId, at }
 * seen:                            # 已推消息的去重键 -> 记录时间（挡服务端重连补拉的重放）
 *   "409420549:757502449344": 1789909982477
 * accounts:                        # ⭐ **收消息名单**：只有列在这儿的号才挂 ws 收消息
 *   "1580886057": true
 * ```
 *
 * ⚠️⚠️ `accounts` 是一份**独立的白名单**，跟「轮询用的全局账号池」（`AuthPool.json`）
 *    是两回事 —— 全局账号扫进来是给查询/推送轮询用的，**不代表它要收消息**。
 *    所以这里**没记录的号 = 不收消息**（早先是「没记录 = 默认开」，那会把一堆只用来
 *    轮询的号也挂上 ws，账号一多就没法管，2026-09-20 主人指出）。
 *
 * ⚠️ 引用映射要带 TTL —— 不清理的话文件会无限涨。
 */
import path from 'node:path'
import { PluginData } from '#components'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'

const FILE = path.join(PluginData, 'campIm.yaml')

/** 引用映射的存活时间（超过就当没引用过） */
const REF_TTL_MS = 24 * 60 * 60 * 1000
/** 引用映射最多留多少条 */
const REF_MAX = 500

/**
 * 已推消息去重键的存活时间、最多留多少条。
 *
 * 服务端补拉重放的窗口就是「最近几条离线消息」，7 天远远够；
 * 上限是防文件无限涨，1000 条约几十 KB。
 */
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SEEN_MAX = 1000

let cache = null

function load () {
  if (cache) return cache
  let raw = {}
  try {
    raw = readYamlFile(FILE) || {}
  } catch {
    raw = {}
  }
  cache = {
    cursor: Number(raw.cursor) || 0,
    refs: (raw.refs && typeof raw.refs === 'object') ? { ...raw.refs } : {},
    seen: (raw.seen && typeof raw.seen === 'object') ? { ...raw.seen } : {},
    accounts: (raw.accounts && typeof raw.accounts === 'object') ? { ...raw.accounts } : {},
    friendLists: (raw.friendLists && typeof raw.friendLists === 'object') ? { ...raw.friendLists } : {}
  }
  return cache
}

function save () {
  if (!cache) return
  try {
    writeYamlFile(FILE, cache)
  } catch (e) {
    logger.error(`[营地消息] 写 ${FILE} 失败：${e.message}`)
  }
}

/** 已处理到的消息游标 */
export function getCursor () {
  return load().cursor
}

export function setCursor (id) {
  const n = Number(id) || 0
  const c = load()
  if (n <= c.cursor) return          // 只前进，不回退
  c.cursor = n
  save()
}

/**
 * 把游标退回去（**唯一允许回退的入口**）。
 *
 * 用途只有一个：服务端重启后消息 id 从 1 重新计数，而游标是「只前进」的，
 * 于是游标停在上次那个大值上、**一条新消息都拉不到**（实测 2026-09-20：
 * 游标 28、服务端 lastId 才 12，收发看着全断）。检测到「服务端 lastId 比游标小」
 * 时调它复位。
 *
 * @param {number} [id] 复位到哪，缺省 0（下次从头拉，队列里没推过的会补上）
 */
export function resetCursor (id = 0) {
  const c = load()
  c.cursor = Number(id) || 0
  save()
}

/**
 * 记一条引用映射（推私信时调）。
 * @param {string|number} msgId 发出去的私信消息 id
 * @param {{selfUserId:string,toUserId:string,toRoleId?:string,fromRoleId?:string}} info
 */
export function addRef (msgId, info) {
  const key = String(msgId || '')
  if (!key) return
  const c = load()
  c.refs[key] = { ...info, at: Date.now() }
  // 清理：先删过期的，再按数量截断
  const now = Date.now()
  const entries = Object.entries(c.refs).filter(([, v]) => now - (v?.at || 0) < REF_TTL_MS)
  entries.sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
  c.refs = Object.fromEntries(entries.slice(0, REF_MAX))
  save()
}

/** 查一条引用映射；过期/不存在返回 null */
export function getRef (msgId) {
  const key = String(msgId || '')
  if (!key) return null
  const v = load().refs[key]
  if (!v) return null
  if (Date.now() - (v.at || 0) > REF_TTL_MS) return null
  return v
}

/**
 * 一条营地消息的去重键（**可能两个**，命中任意一个都算推过）。
 *
 * ⚠️ 为什么用**游戏消息 id**（`messageId`）而不是服务端队列序号 `id`：
 *    服务端 ws 每次重连都会把离线消息重新补拉进队列、重新分配 `id`，但 `messageId` 不变。
 *    游标只按 `id` 前进，挡不住这种重放。
 *
 * ⚠️ 为什么还带一个**内容指纹**：万一补拉重放时 `messageId` 也变了（不同版本的服务端
 *    行为没保证），单靠它就会漏；内容指纹用「发信人 + 游戏时间戳 + 正文」，同一条消息重放
 *    时这三个都不变。两条键同时查，命中哪条都算重复。
 *
 * @param {object} msg 服务端返回的消息对象
 * @returns {string[]}
 */
export function messageKeys (msg) {
  const self = String(msg?.selfUserId ?? '')
  const mid = msg?.messageId || msg?.raw?.messageID || ''
  const keys = []
  if (mid) keys.push(`${self}:${mid}`)
  keys.push(`${self}:${msg?.fromUserId ?? ''}:${msg?.time ?? ''}:${msg?.text ?? ''}`)
  return [...new Set(keys)]
}

/**
 * 这条消息之前推过没有。
 *
 * ⚠️⚠️ 去重键用的是**游戏消息 id**（服务端返回的 `messageId`），不是服务端队列序号 `id`——
 *    服务端每次 ws 重连都会把离线消息**重新补拉进队列**，同一条消息会拿到一个**新的**
 *    `id`，但 `messageId` 不变。游标只按 `id` 前进，挡不住这种重放
 *    （2026-09-20 实测：一次补拉 4 条，3 秒内把同一个号收到的「dsh测试1155」推了两遍；
 *    之后每隔十来秒重连一次，同样的几条又整批再推一轮）。
 *
 * 键由 `messageKeys` 拼，这里只负责查。
 */
export function hasSeenMessage (key) {
  const k = String(key || '')
  if (!k) return false
  return Object.prototype.hasOwnProperty.call(load().seen, k)
}

/** 记下这条消息推过了（落盘，扛重启）；顺带清理过期 + 限量 */
export function markSeenMessage (key) {
  const k = String(key || '')
  if (!k) return
  const c = load()
  if (!c.seen || typeof c.seen !== 'object') c.seen = {}
  c.seen[k] = Date.now()

  const now = Date.now()
  const entries = Object.entries(c.seen).filter(([, v]) => now - (Number(v) || 0) < SEEN_TTL_MS)
  entries.sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
  c.seen = Object.fromEntries(entries.slice(0, SEEN_MAX))
  save()
}

/**
 * 这个号收不收消息。
 *
 * ⚠️ **只有明确加进名单的才算收**（`accounts[userId] === true`）——
 *    全局账号池里的号默认**不**收消息，它们多半只是拿来轮询查询的。
 */
export function isAccountEnabled (userId) {
  return load().accounts[String(userId)] === true
}

/**
 * 加入 / 移出收消息名单。
 *
 * ⚠️ 关掉 = **直接把 key 删掉**（没记录就是不在名单），不留 `false` 残渣 ——
 *    不然名单里会堆一堆「曾经关过的号」，正是这次要治的「账号多了没法管」。
 */
export function setAccountEnabled (userId, enabled) {
  const c = load()
  const k = String(userId || '')
  if (!k) return
  if (enabled) c.accounts[k] = true
  else delete c.accounts[k]
  save()
}

/** 收消息名单的原始快照（`{userId: true}`） */
export function getAccountSwitches () {
  return { ...load().accounts }
}

/** 在不在收消息名单里 */
export function isInImList (userId) {
  return Object.prototype.hasOwnProperty.call(load().accounts, String(userId || ''))
}

/**
 * 记「某归属人最近收到的那条营地推送」。
 *
 * ⚠️ 为什么要落盘：`sendPrivate` 拿不到发出去那条私信的 id，没法按 reply_id 精确映射，
 *    只能退化成「该归属人最近一条推送」。这个信息必须扛得住重启 ——
 *    不然主人引用一条重启前收到的推送回复，就会认不出来。
 *
 * key 用 `__last__:<归属人QQ>`，按人分开存（多个归属人不能互相覆盖）。
 */
export function setLastPush (owner, info) {
  const o = String(owner || '')
  if (!o) return
  addRef(`__last__:${o}`, info)
}

/** 查「某归属人最近收到的那条推送」；没有/过期返回 null */
export function getLastPush (owner) {
  return getRef(`__last__:${String(owner || '')}`)
}

// ────────────────────────── 好友列表的编号映射 ──────────────────────────

/**
 * 「#营地好友」出的那张列表 → 编号到人的映射。
 *
 * ⚠️ 为什么要落盘：主人看完列表，可能过几分钟才发 `#营地私聊 3 你好` ——
 *    中间插件重启过（或者主人在别的群发的）就找不到了。TTL 见 FRIEND_LIST_TTL_MS。
 *
 * ⚠️ 按**发起人 + 用哪个营地号**分开存：同一个 QQ 换 `#切换营地` 之后，
 *    编号指向的人完全不一样，混在一起会发错人。
 */
const FRIEND_LIST_TTL_MS = 10 * 60 * 1000

/** 存一份「某人某号最近一次的好友列表」 */
export function setFriendList (owner, selfUserId, list) {
  const key = `__friends__:${String(owner || '')}:${String(selfUserId || '')}`
  if (!owner || !selfUserId) return
  const c = load()
  if (!c.friendLists) c.friendLists = {}
  c.friendLists[key] = { at: Date.now(), selfUserId: String(selfUserId), list }
  // 顺手清理过期的（别让文件无限涨）
  const now = Date.now()
  for (const [k, v] of Object.entries(c.friendLists)) {
    if (now - (v?.at || 0) > FRIEND_LIST_TTL_MS) delete c.friendLists[k]
  }
  save()
}

/**
 * 按编号取人。
 * @returns {{userId:string, roleId:string, nick:string, selfUserId:string}|null}
 */
export function getFriendByIndex (owner, selfUserId, idx) {
  const key = `__friends__:${String(owner || '')}:${String(selfUserId || '')}`
  const v = load().friendLists?.[key]
  if (!v) return null
  if (Date.now() - (v.at || 0) > FRIEND_LIST_TTL_MS) return null
  const i = Number(idx) - 1
  if (!Number.isInteger(i) || i < 0 || i >= v.list.length) return null
  const f = v.list[i]
  return f ? { ...f, selfUserId: v.selfUserId } : null
}

/** 丢弃缓存（锅巴页面改完文件后，让插件重读） */
export function invalidate () {
  cache = null
}

/**
 * 同一份函数再挂一份 default。
 *
 * ⚠️ 为什么要有：锅巴加载 `guoba.support.js` 时会报
 * `The requested module './utils/campImStore.js' does not provide an export named 'default'`
 * （2026-09-20 实测，只在云崽进程里复现，脱机 `import()` 同一文件却正常）——
 * 也就是**那个上下文里它是按「默认导入」取的**。本文件本来只有命名导出，
 * 于是整个 `guoba.support.js` 载入失败，锅巴「插件配置」页里那一堆营地开关全没了。
 * 挂个 default 两种写法都能用，代价是这里多一个聚合对象。
 */
export default {
  getCursor,
  setCursor,
  resetCursor,
  addRef,
  getRef,
  messageKeys,
  hasSeenMessage,
  markSeenMessage,
  isAccountEnabled,
  setAccountEnabled,
  getAccountSwitches,
  isInImList,
  setLastPush,
  getLastPush,
  setFriendList,
  getFriendByIndex,
  invalidate
}
