/**
 * 开黑的本地状态：群级开关、轮询水位、已播报的里程碑、播报发送账、已通知过的成员。
 *
 * ## 为什么要「里程碑」而不是「有变化就播」
 *
 * 房间池是所有接入方共享的，轮询拿到的是**全量列表**。要是一有变化就往群里播，
 * 一个 5 排房从建到满会播 5 条（发起 + 4 次加入），十几台机器人的群全都刷一遍 ——
 * 这功能会先把群刷炸，然后被所有人关掉。
 *
 * 所以只播**两个里程碑**：
 *   · `new`  有人发起了（功能的核心价值）
 *   · `full` 满员了（告诉大家别再加了）
 *
 * 中间的「谁加入了」不进群，只走私聊给当事双方（发起人 + 加入者）——
 * 那两个人是真需要知道的，其他几十个群友不需要。
 * 想看全局就发 `#开黑列表`，那是**拉**不是**推**。
 *
 * 取消和过期也不播：群里那条旧播报自带约定时间，过点了大家自然知道作废，
 * 为此再刷一条纯属噪音。
 *
 * ## 满员那条只发参与过的群
 *
 * `new` 发给所有开着广播的群（那是招人）；`full` 只发**本机参与过、且开着广播的群**，
 * 并 @ 参与的人（主人 2026-10-16 定）。收件人名单就是下面两张表：
 *   · `origins` 本机在哪个群发起的（连同发起人 QQ，用来 @）
 *   · `joins`   本机哪个群里的谁加入了（用来挑群 + @ 人）
 * 本机没发起、也没人加入过的房，一条满员播报都不会发出去。
 *
 * ## 群级开关默认关（白名单，名单在锅巴配置里）
 *
 * 播报**默认不发到任何群**，只发白名单里的群（主人 2026-10-16 定，推翻了 10-15 的
 * 「默认每个群都收、不想收的群自己关」）。名单存在**锅巴配置** `config.teamBroadcastGroups`
 * （面板上是群多选，见 `broadcastList`），群管理发 `#开启开黑广播` 改的是同一份。
 *
 * 老版本的「关闭名单」（配置里的 `teamMutedGroups`、本文件里的 `offList`）**不再读**：
 * 默认关之后它们没有意义 —— 没开的群本来就收不到。
 *
 * ## 发送账：重启不重播
 *
 * 里程碑要**整轮播完才记**（一个群都没发出去就记的话，那些房永远补不上）。
 * 但群多的机器人一轮要播好几分钟（1.5 秒一个群，几百个群就是近十分钟），
 * 这期间一重启，里程碑没落盘 —— 重启后整轮从头再播，前面收过的群再收一遍。
 * 所以**每发成一个群就记一笔** `sent`（`recordSent`），`planBroadcast` 跳过记过的群：
 * 重启后只补没收到的那些。整轮播完记里程碑时这笔账随之清掉（`clearSent`）。
 *
 * ## 房号会复用，所以指纹必须带建房时间
 *
 * 编号只有 10~99 这 90 个，每天零点还会从 10 重新排。只按 `code` 记「播过了」的话，
 * 下一个拿到同一个号的房会被当成「播过的那个」直接跳过 —— 新房永远播不出去。
 * 所以 key 是 `${code}:${createdAt}`（见 `roomKey`）。
 */
import path from 'path'
import { readYamlFile, writeYamlFile } from '#utils'
import { quarantineCorrupt } from './safeStore.js'
import { PluginData, Config } from '#components'

const TEAM_FILE = path.join(PluginData, 'TeamUpPush.yaml')

/**
 * 指纹最多留多少条。
 *
 * 90 个房号轮一圈就是 90 条，留 300 条足够覆盖好几轮；
 * 不设上限的话这张表会随运行时间单调增长（同 gameNews 的 `PUSHED_KEEP` 那条教训）。
 */
const KEEP = 300

/** 一个房间的唯一标识。**必须带 createdAt** —— 房号会循环复用，见文件头 */
export function roomKey (room) {
  return `${room?.code || '?'}:${Number(room?.createdAt) || 0}`
}

/**
 * 发起记录的老格式兼容。
 *
 * `origins` 原来是 `roomKey -> 群号`（一个字符串），现在要连发起人的 QQ 一起记
 * （满员播报要 @ 他），值变成了 `{groupId, qq}`。**旧文件里躺着的是老格式**，
 * 不认得就会在 `.groupId` 上取到 undefined，发起群被判成「没参与」而漏播。
 */
function normalizeOrigins (raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      if (value) out[key] = { groupId: value, qq: '' }
    } else if (value && typeof value === 'object') {
      const groupId = String(value.groupId || '')
      if (groupId) out[key] = { groupId, qq: String(value.qq || '') }
    }
  }
  return out
}

/**
 * 读状态表。坏了先隔离再返回空表 —— 绝不让轮询因为这个文件挂掉，
 * 也不能让空表被下一次保存固化（同 gameNews / skinNews）。
 */
export function loadTeamStore () {
  try {
    const data = readYamlFile(TEAM_FILE)
    return {
      // 服务端的变更号。相等就只回几十字节，所以它值得落盘（重启后不用全量拉一遍）
      rev: Number(data?.rev) || 0,
      // roomKey -> 'new' | 'full'（full 蕴含 new）
      milestones: data?.milestones && typeof data.milestones === 'object' ? data.milestones : {},
      // roomKey -> {groupId, qq}：本机在哪个群发起的、发起人是谁。满员播报 @ 他
      origins: normalizeOrigins(data?.origins),
      // roomKey -> {群号: [QQ]}：本机哪些群里的谁加入了。见 markJoin
      joins: data?.joins && typeof data.joins === 'object' ? data.joins : {},
      // roomKey -> {new?: [群号], full?: [群号]}：没播完的那轮已经发到了哪些群。见文件头「发送账」
      sent: data?.sent && typeof data.sent === 'object' ? data.sent : {},
      // roomKey -> 已经替发起人通知过的成员 QQ。防止每轮都私聊同一条
      notified: data?.notified && typeof data.notified === 'object' ? data.notified : {}
    }
  } catch (error) {
    quarantineCorrupt(TEAM_FILE, error, '[开黑]')
    return { rev: 0, milestones: {}, origins: {}, joins: {}, sent: {}, notified: {} }
  }
}

/** 把超量的旧条目裁掉。对象的插入序就是时间序，留最后 KEEP 条 */
function trim (table) {
  const keys = Object.keys(table || {})
  if (keys.length <= KEEP) return table || {}

  const out = {}
  for (const key of keys.slice(-KEEP)) out[key] = table[key]
  return out
}

export function saveTeamStore (store) {
  writeYamlFile(TEAM_FILE, {
    rev: Number(store?.rev) || 0,
    milestones: trim(store?.milestones),
    origins: trim(store?.origins),
    joins: trim(store?.joins),
    sent: trim(store?.sent),
    notified: trim(store?.notified)
  })
}

/**
 * 开着开黑广播的群（白名单）。
 *
 * 存在**锅巴配置** `config.teamBroadcastGroups` —— 面板上是个群多选（`GSelectGroup`），
 * 存进去的可能是数字也可能是手输的字符串，一律转成字符串再比。
 */
function broadcastList () {
  try {
    const list = Config.getDefOrConfig('config')?.teamBroadcastGroups
    if (Array.isArray(list)) return list.map(id => String(id ?? '').trim()).filter(Boolean)
  } catch {
    // 配置读不出来（文件坏了 / 宿主没就绪）就当一个群都没开 —— 少播一条好过整个轮询挂掉
  }
  return []
}

/**
 * 开 / 关一个群的开黑广播。
 *
 * 两处入口写的是**同一份数据**：群管理发 `#开启开黑广播`、主人在锅巴面板勾选，
 * 谁后改谁生效 —— 所以锅巴里取消勾选就等于关闭 ✔
 *
 * @returns {{changed: boolean, failed?: boolean}}
 *   changed 为假表示状态本来就是这样；failed 为真表示**写盘失败**（要跟用户说一声）
 */
export function setTeamSub (groupId, enable) {
  const key = String(groupId || '')
  if (!key) return { changed: false }

  const list = broadcastList()
  if (list.includes(key) === enable) return { changed: false }

  /**
   * 写配置。`Config.modify` 底下是裸的 `fs.writeFileSync`，磁盘满 / 文件只读 /
   * yaml 坏了都会抛 —— **不能让它装作成功**，那样用户以为开了，实际一条播报都收不到。
   */
  try {
    Config.modify('config', 'teamBroadcastGroups', enable ? [...list, key] : list.filter(id => id !== key))
  } catch (error) {
    globalThis.logger?.error?.(`[开黑] 写群广播开关失败：${error?.message || error}`)
    return { changed: false, failed: true }
  }

  return { changed: true }
}

/** 本群开着广播吗（没开过就是关着） */
export function isTeamSub (groupId) {
  return broadcastList().includes(String(groupId || ''))
}

/** 开着广播的群号集合。播报时和机器人所在的群取交集 */
export function enabledGroups () {
  return new Set(broadcastList())
}

/**
 * 记下「这个房是本机在哪个群发起的、发起人是谁」。
 *
 * 两次用到：
 *   · 发起人发 `#发起开黑` 时当场就收到一条带编号的回复，轮询再往同一个群播一遍
 *     就是重复 —— 播「有人发起」时跳过这个群（只用 groupId）
 *   · 满员播报只发参与过的群、并 @ 参与的人 —— 发起群是参与者之一，qq 就是用来 @ 的
 *
 * ⚠️ **这里不能顺手把里程碑记成 `new`**：里程碑是**按房间**记的，不是按群 ——
 *    记上之后本机**所有**订阅群都会被判成「播过了」，而其他群的人根本没看到
 *    当场那条回复。发起群靠 `origins` 单独跳过就够了。
 */
export function markOrigin (room, groupId, qq = '') {
  const gid = String(groupId || '')
  if (!gid) return
  const store = loadTeamStore()
  store.origins[roomKey(room)] = { groupId: gid, qq: String(qq || '') }
  saveTeamStore(store)
}

/**
 * 记下「本机哪个群里的谁加入了哪个房」。
 *
 * 满员播报**只发这些群**、并 @ 这些人（主人 2026-10-16 定）：没参与过的群不该收到
 * 「X 号房满了」——那对它们毫无用处，只是噪音。
 *
 * ⚠️ 只有**群里**加入才有记录。私聊加的没有群可播，也就没有可 @ 的对象。
 * ⚠️ 记「QQ 列表」而不是单个值：同一个群里可能先后有两个人进了同一个房，两个都要 @。
 */
export function markJoin (room, groupId, qq) {
  const gid = String(groupId || '')
  const uid = String(qq || '')
  if (!gid || !uid) return

  const store = loadTeamStore()
  const key = roomKey(room)
  if (!store.joins[key]) store.joins[key] = {}
  const list = store.joins[key][gid] || (store.joins[key][gid] = [])
  if (!list.includes(uid)) list.push(uid)
  saveTeamStore(store)
}

/**
 * 本机在哪个群发起了这个房（没有则空串）。播「有人发起」时要跳过它。
 *
 * 读的是**当轮轮询开头那份快照**，不是现读文件 —— 调用方一轮里要问几十个群，
 * 每个群现读一次文件是白扔几百次 IO。
 */
export function originGroupOf (store, room) {
  return String(store?.origins?.[roomKey(room)]?.groupId || '')
}

/**
 * 本机参与过这个房的群，以及每个群里参与的人。
 *
 * 「参与」= 在本机发起了（发起群 + 发起人）或在本机加入了（加入群 + 加入者）。
 * 满员播报据此决定：发给谁、@ 谁。
 *
 * @returns {Map<string, Set<string>>} 群号 -> 要 @ 的 QQ 集合
 */
export function roomGroups (store, room) {
  const key = roomKey(room)
  const out = new Map()

  const origin = store?.origins?.[key]
  if (origin?.groupId) {
    const set = new Set()
    if (origin.qq) set.add(String(origin.qq))
    out.set(String(origin.groupId), set)
  }

  const joined = store?.joins?.[key]
  if (joined && typeof joined === 'object') {
    for (const [gid, list] of Object.entries(joined)) {
      const groupId = String(gid || '')
      if (!groupId) continue
      const set = out.get(groupId) || new Set()
      for (const qq of (Array.isArray(list) ? list : [])) {
        const uid = String(qq || '')
        if (uid) set.add(uid)
      }
      out.set(groupId, set)
    }
  }

  return out
}

/**
 * 这一轮每个群要发什么 —— 播报的收件人决策。
 *
 * 放在这里（而不是 apps/teamUp.js）是为了能脱机单测：那边顶层 import 了 puppeteer
 * 和一堆宿主模块，进不了沙箱；这里是纯数据进出，一份 store 快照就能验。
 *
 * 规则：
 *   · 新房（`fresh`）发给每个候选群，但**发起群除外** —— 它当场已经收到带编号的回复了
 *   · 满员（`full`）**只发给本机参与过的群**（发起群 + 有人加入的群），
 *     并给出这些房里本机在这个群的参与者（`ats`，用来 @）
 *   · 发送账上已经记过的群跳过 —— 那是重启前那轮已经发到的（见文件头「发送账」）
 *   · 两者都为空的群不进结果 —— 调用方据此跳过
 *
 * @param {string[]} groups 候选群（机器人所在、且开着广播的群）
 * @param {Array} freshRooms 这轮的新房
 * @param {Array} fullRooms 这轮刚满员的房
 * @param {object} store loadTeamStore() 的快照
 * @returns {Map<string, {fresh: Array, full: Array, ats: string[]}>} 群号 -> 内容
 */
export function planBroadcast (groups, freshRooms, fullRooms, store) {
  // 每个满员房的参与群算一次就够，别在群循环里反复解析
  const fullTargets = new Map()
  for (const room of fullRooms) fullTargets.set(roomKey(room), roomGroups(store, room))

  const plan = new Map()
  for (const groupId of groups) {
    const fresh = freshRooms.filter(room =>
      originGroupOf(store, room) !== groupId && !sentTo(store, room, 'new', groupId))

    const full = []
    const ats = []
    for (const room of fullRooms) {
      const set = fullTargets.get(roomKey(room))?.get(groupId)
      if (!set || sentTo(store, room, 'full', groupId)) continue
      full.push(room)
      for (const qq of set) if (!ats.includes(qq)) ats.push(qq)
    }

    if (!fresh.length && !full.length) continue
    plan.set(groupId, { fresh, full, ats })
  }
  return plan
}

/** 这条播报（`new` 有人发起 / `full` 人齐了）已经发到过这个群了吗 */
function sentTo (store, room, kind, groupId) {
  const list = store?.sent?.[roomKey(room)]?.[kind]
  return Array.isArray(list) && list.includes(String(groupId))
}

/**
 * 记一笔：这个群收到了这些房的播报。**每发成一个群就记一次**，重启后据此跳过它。
 *
 * 直接改传进来的 store —— 调用方在 commitTeamStore 里现读现写。
 */
export function recordSent (store, groupId, fresh = [], full = []) {
  const gid = String(groupId || '')
  if (!gid) return
  if (!store.sent || typeof store.sent !== 'object') store.sent = {}

  const add = (room, kind) => {
    const key = roomKey(room)
    const entry = store.sent[key] || (store.sent[key] = {})
    const list = Array.isArray(entry[kind]) ? entry[kind] : (entry[kind] = [])
    if (!list.includes(gid)) list.push(gid)
  }
  for (const room of fresh) add(room, 'new')
  for (const room of full) add(room, 'full')
}

/** 清掉一个房某一条播报的发送账：那条播报整轮播完了，或者房又开了、要重新等满员 */
export function clearSent (store, key, kind) {
  const entry = store?.sent?.[key]
  if (!entry) return
  delete entry[kind]
  if (!Object.keys(entry).length) delete store.sent[key]
}

/**
 * 这一轮哪些房的这条播报算「播完了」，可以记里程碑。
 *
 * 算播完的两种：
 *   · 这轮没有群要发它 —— 一个群都没开广播，或者开着的群重启前都已经收过了
 *   · 发送账上至少有一个群收到了 —— 有群发不出去（机器人被禁言、没权限）的话，
 *     重试多少轮都一样，有群收到就算数（和原来「一个群都没发出去才重试」是同一条线）
 *
 * 剩下的（要发、却一个群都没收到）这轮不记，下轮重试。
 *
 * @param {Array} rooms 这轮的新房或满员房
 * @param {'new'|'full'} kind
 * @param {Map} plan planBroadcast 的结果（这轮没播就传空 Map）
 * @param {object} store **播完之后现读**的状态 —— 发送账是边发边记的
 */
export function settledRooms (rooms, kind, plan, store) {
  const field = kind === 'new' ? 'fresh' : 'full'
  const targeted = new Set()
  for (const item of plan.values()) {
    for (const room of item[field]) targeted.add(roomKey(room))
  }

  return rooms.filter(room => {
    const key = roomKey(room)
    if (!targeted.has(key)) return true
    const list = store?.sent?.[key]?.[kind]
    return Array.isArray(list) && list.length > 0
  })
}
