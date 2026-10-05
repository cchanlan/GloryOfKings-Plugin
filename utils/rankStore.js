/**
 * 排行榜数据层。
 *
 * 数据来源是营地主页接口 /game/koh/profile 的 head.mods：
 * - modId 701 是 5v5 排位：name 是段位名（如「至尊星耀III」「最强王者」），
 *   param1.rankingStar 是当前段位内的星数。
 *   注意 content 字段**不能**当排序键：它是段内累计星数，最强王者=16 反而小于尊贵铂金IV=19，
 *   而王者进阶段（无双101/至圣103/绝世105）又跳到三位数，跨段完全不单调。
 *   所以排位排序按 name 解析出的段位权重来算，见 TIER_WEIGHT。
 * - modId 702 是巅峰赛：content 即巅峰分，0 表示未继承/无巅峰分，param1.desc 是展示文案
 *   （有分时就是分数字符串，无分时是「未继承」「定级中」「王者开启」等）。
 *
 * 逐个账号拉接口很慢（营地有频控只能串行），所以结果写快照到 data/RankSnapshot.json，
 * 有效期内直接复用，避免每次 #排位排名 都把全部绑定用户刷一遍。
 * 具体时长看 SNAPSHOT_TTL（当前 12 小时），想立刻更新用「#排位排名刷新」。
 */
import path from 'path'
import { readJsonFile, writeJsonFile } from './fileUtils.js'
import { quarantineCorrupt } from './safeStore.js'
import { readYamlFile } from './yamlUtils.js'
import { isBlackUser } from './blackList.js'
import ApiService from './api.js'
import { mapConcurrent } from './parallel.js'
import { isProfileHidden } from './hiddenProfiles.js'
import { PluginData } from '#components'

const SNAPSHOT_FILE = path.join(PluginData, 'RankSnapshot.json')
const USER_DATA_FILE = path.join(PluginData, 'UserData.yaml')

/** 快照有效期，12 小时。过期后下次查榜才会重新拉取，想立刻更新用「#排位排名刷新」 */
export const SNAPSHOT_TTL = 12 * 60 * 60 * 1000

/** 对方隐藏了主页，这类账号永远进不了榜，不必重试 */
const CODE_PROFILE_HIDDEN = -10107

// 刷榜节奏由 api.js 的队列统一控制（MIN_REQUEST_GAP_MS，**同一个账号**相邻两次真实请求 1200ms；
// 多个全局账号之间是轮询的，所以实际总吞吐按账号数倍增），
// 这里不再自己 sleep 错峰。早先每个账号还额外 sleep 600ms，那 600ms 完全被 1200ms 的
// 队列间隔吃掉（队列本来就要等到 1200ms 才放行），纯粹白等——22 个账号一轮多花 13 秒。
// 想调整节奏改 api.js 的 MIN_REQUEST_GAP_MS。

/**
 * 不可见字符：C0/C1 控制符（含 DELETE U+007F，实测营地昵称里带过）、
 * 零宽空格/连接符、方向标记与隔离符、word joiner、弃用格式符、BOM、
 * 变体选择符，以及不占字形的空格（U+2000~200A、U+202F、U+205F、U+3000、韩文填充符）。
 * 营地昵称里很常见（有人专门拿它们做「隐形名」），保留下来整行看着就是空的。
 */
const INVISIBLE_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFE00-\uFE0F\u3164\u2000-\u200A\u202F\u205F\u3000]/g

/**
 * Unicode 私有使用区（BMP 的 U+E000~F8FF 与 15/16 平面）。
 * 营地 App 用这些码位显示自家图标（大神认证、赛事标等），
 * 换到别的字体里就是豆腐块或空白，所以统一剔除。
 */
const PRIVATE_USE_RE = /[\uE000-\uF8FF]|[\uDB80-\uDBBF][\uDC00-\uDFFF]/g

/**
 * 昵称清洗：剔除渲染不出来的字符，但**不兜底**——清洗后为空就返回空串，
 * 由调用方决定退回什么（有的地方要显示占位名，有的地方要退回 QQ 号）。
 */
export function cleanName (name) {
  return String(name || '')
    .replace(PRIVATE_USE_RE, '')
    .replace(INVISIBLE_RE, '')
    .trim()
}

/**
 * 昵称兜底：清洗规则同 cleanName，全被剔光了就给个占位名。
 * 推送那边（utils/pushStore.js）也要拿营地昵称拼文案，同一套清洗规则，所以导出复用。
 */
export function normalizeName(name) {
  return cleanName(name) || '无名召唤师'
}

/**
 * 大段权重表（星耀及以下）。王者段不在表里，见 KING_WEIGHT。
 * 大段内还有罗马数字小段（V/IV/III/II/I，数字越小段位越高）。
 */
const TIER_WEIGHT = {
  倔强青铜: 1,
  秩序白银: 2,
  荣耀黄金: 3,
  尊贵铂金: 4,
  永恒钻石: 5,
  至尊星耀: 6
}

/**
 * 王者段（最强/非凡/无双/绝世/至圣/荣耀/传奇王者）统一用这个基础权重。
 * 王者段的 rankingStar 是跨子段累计的（实测：最强2星 < 非凡14星 < 无双26星
 * < 绝世32星 < 至圣45星），所以段内直接按星数排就是对的，
 * 不必维护子段名顺序——官方调整子段划分时这里也不用改。
 */
const KING_WEIGHT = 7

/** 罗马小段 → 数值，数字越小段位越高（如 铂金I 高于 铂金IV） */
const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5 }

/**
 * 把段位名 + 段内星数换算成全局单调的排序键。
 * 公式：大段权重 × 100000 + 小段偏移 × 1000 + 星数
 * 小段偏移用 (6 - 罗马数字) 保证 I > II > … > V。
 * 王者段没有小段，偏移恒为 0，靠累计星数拉开差距。
 */
export function calcRankSort(rankName = '', rankStar = 0) {
  const name = String(rankName || '').trim()
  if (!name) return 0

  const star = Number(rankStar) || 0

  // 先判王者段：「荣耀王者」和「荣耀黄金」都含「荣耀」，必须靠「王者」二字区分
  if (name.includes('王者')) {
    return KING_WEIGHT * 100000 + star
  }

  const tierKey = Object.keys(TIER_WEIGHT).find(key => name.includes(key))
  if (!tierKey) return 0

  const romanMatch = name.slice(tierKey.length).match(/^(I{1,3}|IV|V)$/)
  const subTier = romanMatch ? (6 - ROMAN[romanMatch[1]]) : 0

  return TIER_WEIGHT[tierKey] * 100000 + subTier * 1000 + star
}

/**
 * 读取全部绑定关系，返回 [{ botUserId, campId, isCurrent }]。
 * 一个用户可能绑多个营地ID，排名里全部计入，但标记出他当前在用的那个。
 *
 * 被拉黑的人整个人不进榜。这里是排行榜和群报统计（groupReportStore）共同的入口，
 * 在这一处滤掉，两边就都不会再出现他 —— 绑定数据本身不动，移出黑名单即恢复。
 */
export function getAllBindings() {
  const userData = readYamlFile(USER_DATA_FILE) || {}
  const list = []

  for (const [botUserId, info] of Object.entries(userData)) {
    if (isBlackUser(botUserId)) continue

    // 这里刻意**不用** `info?.ids || []` 兜底：UserData 里出现过 `{ ids: "" }` 这种
    // 被写坏的记录，空串是 truthy 但不可迭代，会让 forEach 直接抛 TypeError，
    // 整张榜单连带排行榜一起崩。Array.isArray 一票否决，坏记录直接跳过。
    if (!Array.isArray(info?.ids)) {
      if (info?.ids !== undefined) {
        logger?.debug?.(`[王者] 绑定记录 ${botUserId} 的 ids 不是数组，已跳过`)
      }
      continue
    }

    const ids = info.ids
    const current = Number(info?.current ?? 0)

    ids.forEach((campId, index) => {
      const id = String(campId ?? '').trim()
      // 空串是「这条绑定被清过但没删干净」，不是有效绑定，跳过它但**不影响同一个人
      // 的其它绑定** —— 早先这里 return 的是 forEach 的回调，效果一样，
      // 但配合上面的非数组判据才能保证「一个人有脏记录时整条记录不会静默消失」
      if (!id) return
      list.push({
        botUserId: String(botUserId),
        campId: id,
        isCurrent: index === current
      })
    })
  }

  return list
}

/**
 * 把绑定关系按营地ID 去重，得到实际要发几次请求。
 * 同一个营地ID 常被多人绑定（实测 25 条绑定里只有 22 个不同ID），拉一次就够，
 * 值取第一个绑定者作为属主QQ —— authStore 按属主取鉴权候选，不能传空。
 * @param {Array<{botUserId:string, campId:string}>} [bindings]
 * @returns {Map<string, string>} campId -> botUserId
 */
export function dedupeTargets (bindings = getAllBindings()) {
  const targets = new Map()
  for (const item of bindings) {
    if (!targets.has(item.campId)) targets.set(item.campId, item.botUserId)
  }
  return targets
}

/** 从 profile 响应里抽出排名需要的字段，失败返回 null */
export function extractRankInfo(profileData) {
  const data = profileData?.data
  const mods = data?.head?.mods
  if (!data || !Array.isArray(mods)) return null

  const role = (data.roleList || []).find(r => r.roleId === data.targetRoleId) || {}

  const mod5v5 = mods.find(m => m.modId === 701)
  const modPeak = mods.find(m => m.modId === 702)
  const param5v5 = safeParse(mod5v5?.param1)
  const paramPeak = safeParse(modPeak?.param1)

  // 段位内星数，接口偶发返回空串，用 0 兜底避免 NaN 污染排序
  const rankStar = toInt(param5v5?.rankingStar)
  const peakScore = toInt(modPeak?.content)
  const rankName = mod5v5?.name || ''

  return {
    // 营地昵称里常有私有区图标和不可见字符，直接渲染会整行空白，统一清洗
    roleName: normalizeName(role.roleName),
    roleIcon: role.roleIcon || '',
    serverName: role.roleText || role.areaName || '',
    rankName,
    rankIcon: mod5v5?.icon || '',
    rankStar,
    starImg: param5v5?.starImg || '',
    // 段位名 + 星数换算出的跨段单调排序键
    rankSort: calcRankSort(rankName, rankStar),
    peakScore,
    // 无巅峰分时 desc 是「未继承」这类文案，直接拿来展示
    peakDesc: peakScore > 0 ? String(peakScore) : (paramPeak?.desc || '未继承')
  }
}

function safeParse(text) {
  if (!text || typeof text !== 'string') return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function toInt(value) {
  const num = Number(value)
  return Number.isFinite(num) ? Math.trunc(num) : 0
}

/** 读取快照，结构为 { updatedAt, entries: { [campId]: {...} } }；文件缺失或损坏时返回空快照 */
export function readSnapshot() {
  let snapshot = {}
  try {
    snapshot = readJsonFile(SNAPSHOT_FILE) || {}
  } catch (error) {
    // 快照是可再生的（发 #排位排名 刷新就重建），但坏文件留在原地会让每次读都失败，
    // 挪走它下次就能干净地重建
    quarantineCorrupt(SNAPSHOT_FILE, error, '[王者排名]')
    snapshot = {}
  }

  return {
    updatedAt: Number(snapshot.updatedAt) || 0,
    entries: snapshot.entries && typeof snapshot.entries === 'object' ? snapshot.entries : {}
  }
}

function writeSnapshot(snapshot) {
  writeJsonFile(SNAPSHOT_FILE, snapshot)
}

/**
 * 采集全部绑定账号的排名数据。
 * @param {object} [options]
 * @param {boolean} [options.force=false] 忽略快照有效期强制刷新
 * @param {number}  [options.ttl=SNAPSHOT_TTL] 快照有效期（毫秒）
 * @returns {Promise<{updatedAt:number, entries:object, fromCache:boolean, failed:number}>}
 */
export async function collectRankData({ force = false, ttl = SNAPSHOT_TTL } = {}) {
  const snapshot = readSnapshot()
  const fresh = Date.now() - snapshot.updatedAt < ttl

  if (!force && fresh && Object.keys(snapshot.entries).length) {
    return { ...snapshot, fromCache: true, failed: 0 }
  }

  // 同一个营地ID可能被多人绑定，去重后只拉一次
  const targets = dedupeTargets()

  const entries = {}
  let failed = 0
  let hidden = 0

  // 并发采集：每个请求会被 api 层轮着分给不同的全局账号（见 utils/parallel.js 的文件头）。
  // 写 entries 和两个计数都是同步动作，多路协程不会互相踩；每次请求的耗时远大于自增本身。
  await mapConcurrent(targets, async ([campId, botUserId]) => {
    // 隐藏了主页的号：24 小时内不再主动查（见 utils/hiddenProfiles.js），
    // 沿用上一次快照里的数据——和「采集失败」走同一条路
    if (isProfileHidden(campId)) {
      keepOld(entries, snapshot, campId)
      return
    }

    const info = await fetchOne(campId, botUserId)

    if (info === CODE_PROFILE_HIDDEN) {
      // 隐藏主页的账号不算失败，只是进不了榜
      hidden += 1
      keepOld(entries, snapshot, campId)
    } else if (info) {
      entries[campId] = { ...info, campId, updatedAt: Date.now() }
    } else {
      failed += 1
      keepOld(entries, snapshot, campId)
    }
  })

  const result = { updatedAt: Date.now(), entries }
  writeSnapshot(result)

  return { ...result, fromCache: false, failed, hidden }
}

/**
 * 拉取单个账号的排名数据。
 *
 * 频控（-30107）不在这里处理：api.js 会按账号冷却并自动换号，只有全池都限流时才抛错，
 * 落到下面的 catch 跳过这个账号——下一次刷榜自然会重试。
 *
 * @returns 成功返回数据对象；隐藏主页返回 CODE_PROFILE_HIDDEN；其它失败返回 null
 */
async function fetchOne(campId, botUserId) {
  try {
    const profileData = await ApiService.getProfile(campId, botUserId)
    const code = Number(profileData?.returnCode || 0)

    if (code === CODE_PROFILE_HIDDEN) {
      return CODE_PROFILE_HIDDEN
    }

    if (code !== 0) {
      logger.debug(`[王者排名] ${campId} 返回异常码 ${code}: ${profileData?.returnMsg || ''}`)
      return null
    }

    return extractRankInfo(profileData)
  } catch (error) {
    logger.debug(`[王者排名] 采集 ${campId} 失败: ${error.message}`)
    return null
  }
}

/** 采集失败时沿用上一次快照里的数据，避免榜单突然少人 */
function keepOld(entries, snapshot, campId) {
  const old = snapshot.entries?.[campId]
  if (old) entries[campId] = old
}

/**
 * 按指定维度生成榜单。
 * @param {object} entries 快照里的 entries
 * @param {'rank'|'peak'} type 榜单类型
 * @param {object} [options]
 * @param {string[]} [options.campIds] 只保留这些营地ID（本群排名用）
 * @param {object}   [options.ownerMap] campId -> botUserId，用于回显归属
 */
/**
 * 把快照条目拼成排行榜。
 *
 * `ownerMap` 的取值有两种形态（都支持）：
 *   · `{ [campId]: 'qq' }`            —— 老写法，一个营地号只记一个绑定人
 *   · `{ [campId]: ['qq', 'qq2'] }`   —— **同一个营地号被多人绑定时必须用这种**
 *
 * ⚠️⚠️ 为什么必须支持多绑定（2026-10-06 修）：
 *    `apps/rankList.js` 原先用 `if (!ownerMap[campId]) ownerMap[campId] = botUserId`
 *    只留**第一个**绑定人，然后靠 `botUserId === selfId` 找「查询者自己那一行」。
 *    同一个营地号被两个人绑定时，第二个人的 `botUserId` 是空串 →
 *    `selfEntry` 为 null → **他掉出前 N 名时看不到自己那行**（排行榜里自己凭空消失）。
 *    实测线上 `RankSnapshot.json`：campId `1807995411` 被 `3220564986` 和
 *    `3667259455` 同时绑定；以后者身份查询时 rank #18 那行不显示（前者身份正常）。
 *
 * 所以每个条目同时给出：
 *   · `botUserId`  —— 首个绑定人（头像、归属回显用，保持老语义）
 *   · `botUserIds` —— **全部**绑定人（判断「这行是不是我」必须用它）
 */
export function buildRankList(entries, type, { campIds = null, ownerMap = {} } = {}) {
  const allow = campIds ? new Set(campIds.map(String)) : null

  const ownersOf = (campId) => {
    const raw = ownerMap[String(campId)]
    if (raw == null) return []
    const list = Array.isArray(raw) ? raw : [raw]
    return list.map(String).filter(Boolean)
  }

  const list = Object.values(entries || {})
    .filter(item => !allow || allow.has(String(item.campId)))
    // 旧快照里可能存着按老公式算的 rankSort、以及没清洗过的昵称，这里统一重算
    .map(item => ({
      ...item,
      roleName: normalizeName(item.roleName),
      rankSort: calcRankSort(item.rankName, item.rankStar)
    }))
    .filter(item => (type === 'peak' ? item.peakScore > 0 : item.rankSort > 0))
    .sort((a, b) => (type === 'peak'
      ? b.peakScore - a.peakScore
      : b.rankSort - a.rankSort))

  return list.map((item, index) => {
    const owners = ownersOf(item.campId)
    return {
      ...item,
      index: index + 1,
      botUserId: owners[0] || '',
      botUserIds: owners,
      value: type === 'peak' ? String(item.peakScore) : `${item.rankName} ${item.rankStar}星`
    }
  })
}
