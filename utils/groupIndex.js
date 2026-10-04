/**
 * 「谁在哪个群」的群成员索引 —— 本插件所有「按群展示」功能的归属判据。
 *
 * ## 为什么需要它
 *
 * 一个 QQ 可以同时在好几个群里，也可能哪天退群。而营地绑定表（UserData.yaml）是
 * **全局的**：它只知道「谁绑了哪个营地ID」，不知道那个人现在还在不在某个群。
 *
 * 早先 `#谁在打游戏` 直接拿全局绑定表 + `sub.group` 单值来过滤，后果是：
 *   1. 一个人只有一个 `group` 字段，在 A 群开的在线状态会漏到 B 群去（实测 R 群里
 *      能列出 19 个压根不在 R 群的号）；
 *   2. 退群的人绑着营地ID 就一直赖在名单里，谁也没法把他弄出去。
 *
 * 正确的归属只有一个来源：**适配器的真实群成员表**（`Bot.gl` 群列表 + `Bot.gml` 群成员缓存）。
 * 本模块把它和绑定表求交集，落成 `群号 -> [QQ]`，之后所有功能都查这张表。
 *
 * ## 数据来源与刷新时机
 *
 * `Bot.gml` 是进程内的运行时缓存，重启就没了；它会随着收到群消息、以及
 * `cache_group_member: true` 时收到「群成员增加」事件自动填充。
 * 所以索引**不能只建一次**，见 refreshGroupIndex 的调用点。
 *
 * 冷启动时 `Bot.gl` 要等各适配器连上才有值，启动瞬间读会拿到空表 ——
 * 调用方必须容忍「索引为空」并回落到别的判据，不能因此把人全判成不在群里。
 */
import path from 'path'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'
import { PluginData } from '#components'

/** 落盘位置：索引只是运行时缓存的快照，删了会自动重建，不参与备份 */
const INDEX_FILE = path.join(PluginData, 'GroupIndex.yaml')

/**
 * 索引内容。结构是 `{ updatedAt, groups: { 群号: { name, members: [QQ...] } } }`。
 * members 只存**已绑定营地ID** 的 QQ —— 群成员动辄几百人，全存下来没有意义，
 * 这个索引服务的每一个功能都要求「已绑定」。
 */
let index = null

/** 取一次全局 Bot 实例，没有就返回 null（脱机脚本里没有这个全局） */
function getBot () {
  try {
    return typeof Bot !== 'undefined' ? Bot : null
  } catch {
    return null
  }
}

/**
 * 判断某个 ID 是不是「长得像 QQ 号」。
 *
 * 不能只判数字：官方 QQ 机器人的 user_id 是 `appid:openid`，群号是 openid。
 * 但本索引的键统一用字符串原样存，所以这里只用来过滤明显的脏数据（空串、undefined）。
 */
function cleanId (value) {
  const text = String(value ?? '').trim()
  return text || ''
}

/**
 * 从绑定表里汇总「QQ -> 当前在用的营地ID」。
 *
 * 只取 `isCurrent` 那一个：一个人绑了好几个营地号时，在线状态只跟当前在用的那个走
 * （和 getAllBindings / 推送轮询一个口径）。
 *
 * 这里刻意不复用 rankStore.getAllBindings：那个函数带黑名单过滤（排行榜要的语义），
 * 而索引要不要滤黑名单由**调用方**决定 —— 黑名单是不让他在群里被看到，
 * 但索引本身是事实数据，滤早了别的用途（比如管理面板）就拿不到真实归属了。
 *
 * @returns {Map<string, string>} QQ -> 营地ID
 */
function readCurrentBindings () {
  const userData = readYamlFile(path.join(PluginData, 'UserData.yaml')) || {}
  const map = new Map()

  for (const [qq, info] of Object.entries(userData)) {
    const ids = info?.ids
    if (!Array.isArray(ids)) continue

    const current = Number(info?.current ?? 0)
    const campId = cleanId(ids[current])
    // 纯数字才算：UserData 里有非数字脏数据（有人把自己的用户名当营地号存过），
    // 那种号发到营地接口只会报错，不能进索引
    if (!campId || !/^\d+$/.test(campId)) continue

    map.set(cleanId(qq), campId)
  }

  return map
}

/**
 * 重建索引并落盘。
 *
 * 群成员来源按可靠性排两级：
 *   ① `Bot.gl` + `Bot.gml.get(群号)` —— 适配器的真实成员表，最准；
 *   ② 全都拿不到时**保留上一次的索引**，绝不用空表覆盖 ——
 *      冷启动时适配器还没连上，用空表覆盖会让所有群的人瞬间「消失」，
 *      得等下一轮刷新才回来，而 `#谁在打游戏` 恰好在这期间发就会报「本群没人」。
 *
 * @param {object} [bot] 指定 bot 实例，默认全局 Bot
 * @returns {{ok: boolean, groups: number, members: number, reason?: string}}
 *   ok 为假表示这轮没拿到群列表，索引保持原样
 */
export function refreshGroupIndex (bot = null) {
  const host = bot || getBot()
  if (!host) return { ok: false, groups: 0, members: 0, reason: 'no-bot' }

  let groupMap
  try {
    groupMap = host.gl
  } catch (err) {
    logger?.debug?.(`[王者索引] 取群列表失败: ${err.message}`)
    return { ok: false, groups: 0, members: 0, reason: 'gl-failed' }
  }

  if (!groupMap || !groupMap.size) {
    return { ok: false, groups: 0, members: 0, reason: 'empty-gl' }
  }

  const bindings = readCurrentBindings()
  const groups = {}
  let memberCount = 0

  for (const [groupId, groupInfo] of groupMap) {
    const gid = cleanId(groupId)
    if (!gid) continue

    // 频道 / 公会（有 guild 字段）不走群成员那套，跳过
    if (groupInfo?.guild) continue

    let memberMap = null
    try {
      memberMap = host.gml?.get?.(groupId) || host.gml?.get?.(Number(groupId)) || null
    } catch (err) {
      logger?.debug?.(`[王者索引] 取群 ${gid} 成员表失败: ${err.message}`)
    }

    // 这个群还没有成员缓存：不写进索引（写了就是空成员，会让本群的人全被判成不在群）
    if (!memberMap || !memberMap.size) continue

    const members = []
    for (const userId of memberMap.keys()) {
      const uid = cleanId(userId)
      if (uid && bindings.has(uid)) members.push(uid)
    }

    members.sort()
    memberCount += members.length
    groups[gid] = {
      name: String(groupInfo?.group_name || groupInfo?.name || ''),
      members
    }
  }

  // 一个群都没扫到（成员缓存全空）时也不覆盖，理由同上
  if (!Object.keys(groups).length) {
    return { ok: false, groups: 0, members: 0, reason: 'no-member-cache' }
  }

  index = { updatedAt: Date.now(), groups }
  try {
    writeYamlFile(INDEX_FILE, index)
  } catch (err) {
    // 落盘失败不影响内存索引，下次启动重建即可
    logger?.debug?.(`[王者索引] 落盘失败: ${err.message}`)
  }

  return { ok: true, groups: Object.keys(groups).length, members: memberCount }
}

/**
 * 取索引。内存里没有就从磁盘读；磁盘也没有就现建一次。
 * @returns {{updatedAt: number, groups: Record<string, {name: string, members: string[]}>}}
 */
export function getGroupIndex () {
  if (index) return index

  try {
    const saved = readYamlFile(INDEX_FILE)
    if (saved?.groups && typeof saved.groups === 'object') {
      index = { updatedAt: Number(saved.updatedAt) || 0, groups: saved.groups }
      return index
    }
  } catch {
    // 索引坏了不值得留证（它随时可重建），直接现建
  }

  refreshGroupIndex()
  return index || { updatedAt: 0, groups: {} }
}

/**
 * 这个群里的已绑定成员。
 * @param {string|number} groupId
 * @returns {string[]} QQ 数组，群不存在或没有绑定成员时是空数组
 */
export function membersOfGroup (groupId) {
  const gid = cleanId(groupId)
  if (!gid) return []

  const entry = getGroupIndex().groups?.[gid]
  return Array.isArray(entry?.members) ? entry.members : []
}

/**
 * 一个 QQ 在哪些群里（可能多个）。
 *
 * 用于「这个人退群了没有」的判断：返回值是空数组 = 不在任何已索引的群里。
 * 注意**索引里没有的群不等于他不在**（可能只是那个群还没扫到成员缓存），
 * 所以调用方要区分「确定不在任何群」和「拿不到索引」两种情况，
 * 后者应该回落到旧判据而不是把人删掉。
 *
 * @param {string|number} qq
 * @returns {string[]} 群号数组
 */
export function groupsOfMember (qq) {
  const uid = cleanId(qq)
  if (!uid) return []

  const { groups } = getGroupIndex()
  const out = []
  for (const [gid, entry] of Object.entries(groups || {})) {
    if (Array.isArray(entry?.members) && entry.members.includes(uid)) out.push(gid)
  }
  return out
}

/**
 * 索引是否可用。
 *
 * 调用方拿它决定「能不能信索引」：索引不可用（冷启动还没建出来）时必须回落到
 * 旧判据，绝不能因为「索引里查不到」就把人判成退群删掉。
 */
export function isIndexReady () {
  return Object.keys(getGroupIndex().groups || {}).length > 0
}

/**
 * 实时查「这些人现在还在不在各自要推送的群里」——**刻意不走落盘索引**。
 *
 * ## 为什么不复用 membersOfGroup / groupsOfMember
 *
 * 那两个查的是 `GroupIndex.yaml`（内存里那份），而它**只在 `#谁在打游戏` 触发时
 * 刷新一次**（`refreshGroupIndex()` 不会自己跑，定时任务那条链完全不碰它）。推送
 * 轮询可能几小时没人看过那张图，索引就停在几小时前的快照 —— 拿它判退群，要么该清的
 * 没清、要么把刚退群的人留着继续推。退群这件事要的正是「现在」，索引给不了。
 *
 * 适配器的 `gml`（群成员缓存）本身是**实时**的：OneBotv11 收到 `group_decrease`
 * 就 `gml.get(gid)?.delete(user_id)`（NapCat / icqq 同款做法），人一退群缓存立刻少一个。
 * 所以这里直接问它。
 *
 * ## 为什么签名是「一次问一批」
 *
 * JiuLi 内核的 `Bot.gml` 是个 **getter**，每次访问都遍历所有账号、把每个群的成员表
 * `Object.assign(new Map(i), …)` **全量深拷贝**一遍（见 src/core/bot.ts 的 gml getter）。
 * 逐个人逐次调用就是几千次深拷贝，纯属白烧 CPU。所以这里收一份
 * `[{ qq, groups }]`，只访问一次 `Bot.gml`，把需要的群成员表一次性拿出来。
 *
 * ## 返回值语义（调用方必须区分这三种）
 *
 * - `ok: false` —— **拿不到成员缓存**（冷启动、适配器没连上、群不在缓存里）。
 *   调用方必须原样放行，绝不能让「查不到」变成「退群了」。
 * - `ok: true` + `gone[qid] = [群号]` —— 这个人**确定不在**这些群里了。
 * - `ok: true` 且 `gone[qid]` 里没有 —— 在群里，或者**那个人压根不在 gml 里**
 *   （icqq 只在 `cache_group_member` 开着时才缓存成员，关掉时 gml 整个是空的）。
 *
 * ⚠️ 「人在 gml 里、但不在这个群」才算确定退群；gml 里连群都没有时宁可放行，
 *    误判会把好端端的人的推送停掉，比漏判糟得多。
 *
 * @param {Array<{qq: string, groups: string[]}>} entries 待判定的 QQ 与各自的推送群
 * @returns {{ok: boolean, gone: Record<string, string[]>, reason?: string}}
 */
export function detectLeftGroups (entries) {
  const host = getBot()
  if (!host) return { ok: false, gone: {}, reason: 'no-bot' }

  const list = Array.isArray(entries) ? entries.filter(item => item?.groups?.length) : []
  if (!list.length) return { ok: true, gone: {} }

  let memberMap
  try {
    memberMap = host.gml
  } catch (err) {
    logger?.debug?.(`[王者索引] 取成员缓存失败: ${err.message}`)
    return { ok: false, gone: {}, reason: 'gml-failed' }
  }

  if (!memberMap || !memberMap.size) {
    return { ok: false, gone: {}, reason: 'no-member-cache' }
  }

  const gone = {}
  let sawAnyGroup = false

  for (const { qq, groups } of list) {
    const uid = cleanId(qq)
    if (!uid) continue

    for (const groupId of groups) {
      const gid = cleanId(groupId)
      if (!gid) continue

      // 群号形态要跟 gl/gml 的键一致：icqq 是数字，官bot 是 openid 字符串
      let members = memberMap.get(gid)
      if (!members) members = memberMap.get(Number(gid))
      // ⚠️⚠️ 这个群没有成员缓存 —— 无从判断，跳过（不许判成退群）。
      //
      // `!members.size` 那一半是**必须的**，别当成多余的防守：OneBotv11 的
      // `getMemberMap` 在营地/适配器 API 抽风时会 `gml.set(group_id, new Map())`
      // 塞一个**空 Map** 进去（它没有 icqq 那句 `if (!mlist?.size) gml.delete(gid)`
      // 保护）。空 Map 的 `.has` 是存在的，只看 `.has` 就会得出「这个群有成员表、
      // 而人人都不在里面」—— 一次把整群人的推送全删掉。
      // 口径和 refreshGroupIndex 保持一致：**空成员表 == 没有缓存**。
      if (!members?.has || !members.size) continue

      sawAnyGroup = true
      // 反向确认：这个群有**非空**成员表，而人不在里面 → 确定不在这个群了
      if (!members.has(uid) && !members.has(Number(uid))) {
        if (!gone[uid]) gone[uid] = []
        gone[uid].push(gid)
      }
    }
  }

  // 一个群的成员表都没拿到（缓存全空）时同样不许下结论
  if (!sawAnyGroup) return { ok: false, gone: {}, reason: 'no-member-cache' }

  return { ok: true, gone }
}

/** 清掉内存缓存，下次 getGroupIndex 会重新读盘。主要给测试用 */
export function resetGroupIndexCache () {
  index = null
}
