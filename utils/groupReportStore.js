/**
 * 群战绩日报 / 周报 / 月报的数据层。
 *
 * 和个人报告的关系：单人汇总仍然走 reportStore.summarizeReport，本模块只负责
 * 「这个群要统计谁」+「逐个成员采集」+「群级别的订阅开关」。
 *
 * 两个设计取舍：
 * - **统计范围和 #排位排名 一个口径**：群成员列表 ∩ UserData.yaml 的绑定关系。
 *   不是「只统计开了推送的人」——群里没订阅推送的人也想上群榜。
 * - **每个成员至少 1 次营地请求**（collectBattles 固定要实拉第一页才敢信库是新的，
 *   原因见 battleArchive 的注释），所以成员数必须有上限，且不自己 sleep 错峰：
 *   api.js 的全局队列已经保证相邻真实请求间隔 MIN_REQUEST_GAP_MS，
 *   在这里再 sleep 是白等（rankStore 踩过，22 个账号白等 13 秒）。
 *
 * 订阅表单独存 data/GroupReportPush.yaml：pushList（GameRecordPush.yaml）是按 QQ 存的，
 * 群报是按群存的，塞进去会让 SUB_FLAGS 那套「全关了就删订阅」的判断变得没法维护。
 */
import path from 'path'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'
import { quarantineCorrupt } from './safeStore.js'
import { collectBattles, getArchiveRange } from './battleArchive.js'
import { getAllBindings, readSnapshot } from './rankStore.js'
import { loadPushList } from './pushStore.js'
import { summarizeReport, getHeroNameMap, summarizeGroup } from './reportStore.js'
import { PluginData } from '#components'

const GROUP_PUSH_FILE = path.join(PluginData, 'GroupReportPush.yaml')

/** 群报的三路开关。加新种类时记得往这里补，setGroupFlag 靠它判「是不是全关了」 */
export const GROUP_SUB_FLAGS = ['daily', 'weekly', 'monthly']

/**
 * 一次群报最多扫多少个成员。
 * 每人至少 1 次请求、全局队列 1.2 秒一发，25 人约 30 秒——
 * 再多用户就会觉得指令「卡住了」，而且撞 -30107 的概率线性上升。
 * 超出的按「归档库里最近一场的时间」排序裁掉，活跃的人优先。
 */
export const MAX_MEMBERS = 25

/**
 * 补页上限，比个人报告小一档。
 * 个人报告是 1 个号翻 12 页，群报是 N 个号各翻 N 页，乘起来才是真实开销。
 * 群报的定位是「群里谁在肝」，少几场不影响排序，所以宁可截断也不翻页翻到频控。
 */
export const GROUP_MAX_PAGES = { daily: 2, weekly: 3, monthly: 3 }

/* ---------------------------------------------------------------- 订阅存取 */

/**
 * 读群订阅表，坏了返回空表——绝不让定时任务因为这个文件挂掉。
 * 解析失败时先隔离坏文件：否则空表会被下一次 saveGroupSubs 固化，群报订阅静默消失。
 */
export function loadGroupSubs () {
  try {
    const data = readYamlFile(GROUP_PUSH_FILE)
    const list = data?.pushList
    return list && typeof list === 'object' ? list : {}
  } catch (error) {
    quarantineCorrupt(GROUP_PUSH_FILE, error, '[王者群报]')
    return {}
  }
}

export function saveGroupSubs (pushList) {
  writeYamlFile(GROUP_PUSH_FILE, { pushList: pushList || {} })
}

/** 某一路开关是否开着。三路都是后加的，缺字段就是没开（没有 battle 那种历史包袱） */
export function isGroupFlagOn (sub, kind) {
  return Boolean(sub) && sub[kind] === true
}

/**
 * 开 / 关一个群的某一路群报推送。
 * 三路全关了就把整条记录删掉，别留空壳。
 *
 * @param {string|number} groupId 群号
 * @param {'daily'|'weekly'|'monthly'} kind
 * @param {boolean} enable
 * @param {object} [extra] 要一起写进订阅项的字段（如 operator / groupName）
 * @returns {{changed:boolean, removed:boolean}} changed 为假表示状态本来就是这样，什么都没改
 */
export function setGroupFlag (groupId, kind, enable, extra = {}) {
  const key = String(groupId || '')
  if (!key || !GROUP_SUB_FLAGS.includes(kind)) return { changed: false, removed: false }

  const list = loadGroupSubs()
  const sub = list[key]

  if (!enable) {
    if (!isGroupFlagOn(sub, kind)) return { changed: false, removed: false }

    sub[kind] = false
    const removed = !GROUP_SUB_FLAGS.some(flag => isGroupFlagOn(sub, flag))
    if (removed) delete list[key]
    else list[key] = sub

    saveGroupSubs(list)
    return { changed: true, removed }
  }

  if (isGroupFlagOn(sub, kind)) return { changed: false, removed: false }

  list[key] = {
    ...(sub || { enabledAt: Date.now() }),
    ...extra,
    [kind]: true
  }
  saveGroupSubs(list)
  return { changed: true, removed: false }
}

/** 开了某一路群报的群号列表 */
export function listGroupSubs (kind) {
  return Object.entries(loadGroupSubs())
    .filter(([, sub]) => isGroupFlagOn(sub, kind))
    .map(([groupId, sub]) => ({ groupId, sub }))
}

/* ------------------------------------------------------------------ 成员 */

/**
 * 这个群要统计哪些账号。
 *
 * 三步去重，每一步都有实测原因：
 * 1. 一个人绑多个营地ID 时只取他**当前**在用的那个（isCurrent），
 *    否则同一个人会在群榜上出现两行、场次还被拆开。
 * 2. 同一个营地ID 被多人绑定（实测 25 条绑定里只有 22 个不同ID，有人共号），
 *    按 campId 去重，属主取第一个——authStore 按属主取鉴权候选，不能传空。
 * 3. 超过 MAX_MEMBERS 时按「归档库里最新一场的时间」倒序裁剪：库里有数据说明这人
 *    最近在打，优先统计他。没库的排后面（时间算 0），但仍参与——否则新人永远进不了榜。
 *
 * @param {Array<string>} memberIds 群成员的 bot user_id 列表
 * @param {object} [options]
 * @param {number} [options.limit=MAX_MEMBERS]
 * @returns {{targets:Array<{campId:string, qq:string}>, bound:number}}
 *   bound 是裁剪前的账号数，用于提示「只统计了前 N 个」
 */
export function resolveGroupTargets (memberIds = [], { limit = MAX_MEMBERS } = {}) {
  const memberSet = new Set(memberIds.map(String))
  const byCamp = new Map()

  for (const item of getAllBindings()) {
    if (!item.isCurrent) continue
    if (memberSet.size && !memberSet.has(item.botUserId)) continue
    if (byCamp.has(item.campId)) continue
    byCamp.set(item.campId, item.botUserId)
  }

  const all = [...byCamp.entries()].map(([campId, qq]) => ({
    campId,
    qq,
    latest: getArchiveRange(campId).latest
  }))

  all.sort((a, b) => b.latest - a.latest)

  return {
    targets: all.slice(0, limit).map(({ campId, qq }) => ({ campId, qq })),
    bound: all.length
  }
}

/**
 * 一个账号的展示名与头像，全部零请求。
 *
 * 优先级是按「准不准」排的：推送订阅项里的 roleName 是轮询时刚更新过的，
 * 排名快照次之（默认 12 小时有效），都没有才退回 QQ 号。
 * 头像用排名快照里的营地头像——官方机器人拿不到 QQ 头像（openid 形态），
 * 而营地头像对谁都能显示。
 */
export function resolveMemberIdentity (campId, qq, { snapshot = readSnapshot(), pushList = loadPushList() } = {}) {
  const entry = snapshot.entries?.[String(campId)] || {}
  const sub = pushList[String(qq)] || {}

  return {
    name: String(sub.roleName || entry.roleName || qq || '召唤师'),
    icon: String(entry.roleIcon || '')
  }
}

/* ------------------------------------------------------------------ 采集 */

/**
 * 采集一个群的群报数据。
 *
 * @param {object} opts
 * @param {'daily'|'weekly'|'monthly'} opts.kind
 * @param {number} opts.fromSec 区间起点
 * @param {number} [opts.toSec] 区间终点（秒），0 = 到现在。周报统计上一整周时要给
 * @param {Array<string>} opts.memberIds 群成员 bot user_id 列表
 * @param {number} [opts.limit] 成员上限
 * @returns {Promise<{group:object|null, scanned:number, bound:number, coveredFrom:number, truncated:boolean}>}
 *   group 为 null 表示这个区间群里一场都没打（不出空图）
 */
export async function collectGroupReport ({ kind = 'daily', fromSec = 0, toSec = 0, memberIds = [], limit = MAX_MEMBERS } = {}) {
  const { targets, bound } = resolveGroupTargets(memberIds, { limit })
  if (!targets.length) return { group: null, scanned: 0, bound: 0, coveredFrom: 0, truncated: false }

  const heroMap = await getHeroNameMap()
  const snapshot = readSnapshot()
  const pushList = loadPushList()
  const maxPages = GROUP_MAX_PAGES[kind] || 2

  const members = []
  let truncated = false
  // 覆盖边界取所有成员里**最差**的那个（最晚的水位）：图上只能承诺「大家都覆盖到了这里」
  let coveredFrom = 0

  for (const { campId, qq } of targets) {
    let collected
    try {
      collected = await collectBattles(campId, qq, fromSec, { maxPages, toSec })
    } catch (error) {
      // 单个成员失败（登录态失效 / 频控）不能让整份群报挂掉，跳过就是少一行
      logger.debug(`[王者群报] ${campId} 采集失败: ${error.message}`)
      continue
    }

    if (collected.truncated) truncated = true
    if (collected.coveredFrom > coveredFrom) coveredFrom = collected.coveredFrom

    if (!collected.battles.length) continue

    const report = summarizeReport(collected.battles, { fromSec, toSec, heroMap })
    if (!report.count) continue

    members.push({
      ...resolveMemberIdentity(campId, qq, { snapshot, pushList }),
      campId,
      qq,
      report,
      battles: collected.battles
    })
  }

  if (!members.length) return { group: null, scanned: targets.length, bound, coveredFrom, truncated }

  return {
    group: summarizeGroup(members),
    scanned: targets.length,
    bound,
    coveredFrom,
    truncated
  }
}
