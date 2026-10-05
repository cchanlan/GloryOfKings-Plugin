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
 *   api.js 的队列已经保证同一个账号相邻真实请求间隔 MIN_REQUEST_GAP_MS，
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
import { mapConcurrent } from './parallel.js'
import { loadPushList } from './pushStore.js'
import { summarizeReport, getHeroNameMap, summarizeGroup } from './reportStore.js'
import { fetchRoleIdentities } from './roleName.js'
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
 * ⚠️⚠️ **空 `memberIds` = 谁也不匹配，不是「不过滤」**（2026-10-06 修）。
 *    原先判据是 `if (memberSet.size && !memberSet.has(...))`，空集合时整个条件为假、
 *    等于**放行全部绑定**（上限 MAX_MEMBERS=25）。这是跨群数据泄露：
 *    `apps/groupReport.js` 的 `resolveMembers` 在 `group.getMemberMap()` 拿不到时
 *    （官方机器人常态）会降级用订阅表里的单值 `group` 字段拼名单，
 *    而多群订阅的人只把主群写在 `group`、其余在 `groups[]` 里 —— 于是
 *    **某个群可能拼出空名单**，接着 `resolveGroupTargets([])` 返回全服 25 个绑定，
 *    群报照常出图并推送一张「本群榜」，里面全是别的群的人。
 *    实测：群 `972915804` 的降级名单正好是空的（它只在某个号的 `groups[]` 里），
 *    且 `resolveGroupTargets([])` 返回 `bound=26, targets.length=25`。
 *
 *    现在空数组自然「谁都不匹配」，调用方原有的 `if (!targets.length) 跳过` 正好接住
 *    （四个调用点都是这么写的，没有一处依赖旧的「空=全部」语义）。
 *    真要「不过滤」时**显式**传 `{ noFilter: true }`，别再靠传空数组表达。
 *
 * @param {Array<string>} memberIds 群成员的 bot user_id 列表
 * @param {object} [options]
 * @param {number} [options.limit=MAX_MEMBERS]
 * @param {boolean} [options.noFilter=false] 显式表示「不过滤」（只在确实要全服榜时用）
 * @returns {{targets:Array<{campId:string, qq:string}>, bound:number}}
 *   bound 是裁剪前的账号数，用于提示「只统计了前 N 个」
 */
export function resolveGroupTargets (memberIds = [], { limit = MAX_MEMBERS, noFilter = false } = {}) {
  const memberSet = new Set(memberIds.map(String))
  const byCamp = new Map()

  for (const item of getAllBindings()) {
    if (!item.isCurrent) continue
    // `noFilter` 是唯一「不过滤」的入口；否则名单里没有他就不算他
    if (!noFilter && !memberSet.has(item.botUserId)) continue
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
 * 一个账号的展示名与头像。
 *
 * 优先读本地现成的两处，都命中就零请求：
 *   - 推送订阅项里的 roleName 是轮询时刚更新过的，最准
 *   - 排名快照次之（默认 12 小时有效）
 *
 * 两处都没有（典型是**刚绑定、快照还没刷到**）时不再退回 QQ 号裸奔 ——
 * 这里只如实返回空值，由 collectGroupReport 统一补查一次 profile，
 * 昵称和头像一起补上（见那里 needFetch 的注释）。
 * 头像只用营地头像：官方机器人拿不到 QQ 头像（openid 形态），营地头像对谁都能显示。
 *
 * @returns {{name:string, icon:string}} name 为空表示本地查不到，需要补查
 */
export function resolveMemberIdentity (campId, qq, { snapshot = readSnapshot(), pushList = loadPushList() } = {}) {
  const entry = snapshot.entries?.[String(campId)] || {}
  const sub = pushList[String(qq)] || {}

  return {
    name: String(sub.roleName || entry.roleName || ''),
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

  // 并发采集：每个成员至少一次请求，25 个人串行就是半分多钟。
  // mapConcurrent 按 targets 原序返回，下面拼 members 的顺序不受影响。
  const collectedList = await mapConcurrent(targets, async ({ campId, qq }) => {
    try {
      return { campId, qq, collected: await collectBattles(campId, qq, fromSec, { maxPages, toSec }) }
    } catch (error) {
      // 单个成员失败（登录态失效 / 频控）不能让整份群报挂掉，跳过就是少一行
      logger.debug(`[王者群报] ${campId} 采集失败: ${error.message}`)
      return null
    }
  })

  for (const item of collectedList) {
    if (!item) continue

    const { campId, qq, collected } = item
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

  // 本地（推送订阅项 / 排名快照）凑不齐「名字 + 头像」的人，补查一次 profile，两样一起补。
  //
  // 为什么非补不可：快照只在有人发 `#排位排名` 时才刷新（TTL 12 小时），
  // 而推送订阅项只有开了战绩推送的人才有 —— 于是**刚绑定、快照还没刷到**的成员
  // 两处都查不到，榜上就裸奔成一串 QQ 号、头像也空着
  // （2026-09-30 实测：群里 9 个上榜的人有 2 个是这样）。
  // 补查是每人一发请求，所以只补「已经确认有对局、会上榜」的人 ——
  // 没上榜的人不该为一次群报白花频控额度。
  // 走 mapConcurrent 而不是串行 await：每个人要用自己的属主身份去查（和 collectBattles 一致），
  // 串行会退化成一次一发；fetchRoleIdentities 有 600 秒缓存，常驻成员只会在第一次补。
  const incomplete = members.filter(member => !member.name || !member.icon)
  if (incomplete.length) {
    await mapConcurrent(incomplete, async (member) => {
      try {
        const identity = (await fetchRoleIdentities([member.campId], member.qq))[member.campId]
        if (identity?.name && !member.name) member.name = identity.name
        if (identity?.icon && !member.icon) member.icon = identity.icon
      } catch (error) {
        // 补查失败只是显示成 QQ 号 / 没头像，不该影响这份群报
        logger.debug(`[王者群报] ${member.campId} 补查昵称失败: ${error.message}`)
      }
    })
  }

  // 最后还是查不到的（隐藏主页、登录态失效）退回 QQ 号而不是统一的「召唤师」：
  // 群里多个人都叫「召唤师」就没法分辨谁是谁了，QQ 号至少认得出人
  for (const member of members) {
    if (!member.name) member.name = String(member.qq || '')
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
