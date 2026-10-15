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
      // roomKey -> 本机在哪个群发起的。播报时跳过它，免得发起群收到两遍
      origins: data?.origins && typeof data.origins === 'object' ? data.origins : {},
      // roomKey -> 已经替发起人通知过的成员 QQ。防止每轮都私聊同一条
      notified: data?.notified && typeof data.notified === 'object' ? data.notified : {}
    }
  } catch (error) {
    quarantineCorrupt(TEAM_FILE, error, '[开黑]')
    return { offList: {}, rev: 0, milestones: {}, origins: {}, notified: {} }
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
 * 记下「这个房是本机在哪个群发起的」。
 *
 * 发起人发 `#发起开黑` 时当场就收到一条带编号的回复，轮询再往同一个群播一遍
 * 就是重复。记下来，播「有人发起」时跳过这个群。
 *
 * ⚠️ **这里不能顺手把里程碑记成 `new`**：里程碑是**按房间**记的，不是按群 ——
 *    记上之后本机**所有**订阅群都会被判成「播过了」，而其他群的人根本没看到
 *    当场那条回复。发起群靠 `origins` 单独跳过就够了。
 *
 * 满员那条反而要播给发起群：群里其他人得知道别再加了（发起人自己走私聊）。
 */
export function markOrigin (room, groupId) {
  const store = loadTeamStore()
  store.origins[roomKey(room)] = String(groupId || '')
  saveTeamStore(store)
}
