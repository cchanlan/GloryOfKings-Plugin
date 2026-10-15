/**
 * 开黑的本地状态：群级开关、轮询水位、已播报的里程碑、已通知过的成员。
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
 * `new` 广播到所有群（那是招人）；`full` 只发**本机参与过的群**，并 @ 参与的人
 * （主人 2026-10-16 定）。收件人名单就是下面两张表：
 *   · `origins` 本机在哪个群发起的（连同发起人 QQ，用来 @）
 *   · `joins`   本机哪个群里的谁加入了（用来挑群 + @ 人）
 * 本机没发起、也没人加入过的房，一条满员播报都不会发出去。
 *
 * ## 群级开关默认开，所以存的是「关掉的群」
 *
 * 装了插件、接入了服务端的机器人，**所在的每个群默认都收播报**（主人 2026-10-15 定）。
 * 于是这里存的是**关掉的群**（`offList`），不是开着的群 —— 存开着的群就得在
 * 机器人每进一个新群时补一条，漏一次那个群就永远收不到。
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
import { PluginData } from '#components'

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
 * 也不能让空表被下一次保存固化、把所有群的开关静默清掉（同 gameNews / skinNews）。
 */
export function loadTeamStore () {
  try {
    const data = readYamlFile(TEAM_FILE)
    return {
      // 群号 -> {since, groupName}：发过 #关闭开黑广播 的群。不在这里的群一律收播报
      offList: data?.offList && typeof data.offList === 'object' ? data.offList : {},
      // 服务端的变更号。相等就只回几十字节，所以它值得落盘（重启后不用全量拉一遍）
      rev: Number(data?.rev) || 0,
      // roomKey -> 'new' | 'full'（full 蕴含 new）
      milestones: data?.milestones && typeof data.milestones === 'object' ? data.milestones : {},
      // roomKey -> {groupId, qq}：本机在哪个群发起的、发起人是谁。满员播报 @ 他
      origins: normalizeOrigins(data?.origins),
      // roomKey -> {群号: [QQ]}：本机哪些群里的谁加入了。见 markJoin
      joins: data?.joins && typeof data.joins === 'object' ? data.joins : {},
      // roomKey -> 已经替发起人通知过的成员 QQ。防止每轮都私聊同一条
      notified: data?.notified && typeof data.notified === 'object' ? data.notified : {}
    }
  } catch (error) {
    quarantineCorrupt(TEAM_FILE, error, '[开黑]')
    return { offList: {}, rev: 0, milestones: {}, origins: {}, joins: {}, notified: {} }
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
    offList: store?.offList || {},
    rev: Number(store?.rev) || 0,
    milestones: trim(store?.milestones),
    origins: trim(store?.origins),
    joins: trim(store?.joins),
    notified: trim(store?.notified)
  })
}

/**
 * 开 / 关一个群的开黑广播。重新打开就删记录，不留空壳。
 * @returns {{changed: boolean}} changed 为假表示状态本来就是这样
 */
export function setTeamSub (groupId, enable, extra = {}) {
  const key = String(groupId || '')
  if (!key) return { changed: false }

  const store = loadTeamStore()
  const on = !store.offList[key]
  if (on === enable) return { changed: false }

  if (enable) {
    delete store.offList[key]
  } else {
    store.offList[key] = { since: Date.now(), ...extra }
  }

  saveTeamStore(store)
  return { changed: true }
}

/** 本群开着广播吗（没关过就是开着） */
export function isTeamSub (groupId) {
  return !loadTeamStore().offList[String(groupId || '')]
}

/** 关掉广播的群号集合。播报时从机器人所在的全部群里减掉它 */
export function mutedGroups () {
  return new Set(Object.keys(loadTeamStore().offList))
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
 *   · 新房（`fresh`）广播给所有群，但**发起群除外** —— 它当场已经收到带编号的回复了
 *   · 满员（`full`）**只发给本机参与过的群**（发起群 + 有人加入的群），
 *     并给出这些房里本机在这个群的参与者（`ats`，用来 @）
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
    const fresh = freshRooms.filter(room => originGroupOf(store, room) !== groupId)

    const full = []
    const ats = []
    for (const room of fullRooms) {
      const set = fullTargets.get(roomKey(room))?.get(groupId)
      if (!set) continue
      full.push(room)
      for (const qq of set) if (!ats.includes(qq)) ats.push(qq)
    }

    if (!fresh.length && !full.length) continue
    plan.set(groupId, { fresh, full, ats })
  }
  return plan
}
