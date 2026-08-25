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
 * 默认 30 分钟内直接复用，避免每次 #排位排名 都把全部绑定用户刷一遍。
 */
import path from 'path'
import { readJsonFile, writeJsonFile } from './fileUtils.js'
import { readYamlFile } from './yamlUtils.js'
import ApiService from './api.js'
import { PluginData } from '#components'

const SNAPSHOT_FILE = path.join(PluginData, 'RankSnapshot.json')
const USER_DATA_FILE = path.join(PluginData, 'UserData.yaml')

/** 快照有效期，12 小时。过期后下次查榜才会重新拉取，想立刻更新用「#排位排名刷新」 */
export const SNAPSHOT_TTL = 12 * 60 * 60 * 1000

/**
 * 命中 -30107 时的退避重试次数与基础等待。
 *
 * 这里不再自己 sleep 错峰：营地对 profile 接口有频控（并发拉取时大量返回 -30107），
 * 但错峰现在由 api.js 的全局队列统一做，相邻两次真实请求间隔 MIN_REQUEST_GAP_MS(1200ms)。
 * 早先这里每个账号还额外 sleep 600ms，那 600ms 完全被 1200ms 的队列间隔吃掉
 * （队列本来就要等到 1200ms 才放行），纯粹是白等——22 个账号一轮要多花 13 秒。
 * 想调整刷榜节奏改 api.js 的 MIN_REQUEST_GAP_MS，别在这里加 sleep。
 */
const RATE_LIMIT_RETRY = 2
const RATE_LIMIT_BACKOFF = 3000

/** 营地频控错误码 */
const CODE_RATE_LIMITED = -30107
/** 对方隐藏了主页，这类账号永远进不了榜，不必重试 */
const CODE_PROFILE_HIDDEN = -10107

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 不可见字符：零宽空格/连接符、方向标记与隔离符、word joiner、弃用格式符、BOM、
 * 变体选择符，以及不占字形的空格（U+2000~200A、U+202F、U+205F、U+3000、韩文填充符）。
 * 营地昵称里很常见（有人专门拿它们做「隐形名」），保留下来整行看着就是空的。
 */
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFE00-\uFE0F\u3164\u2000-\u200A\u202F\u205F\u3000]/g

/**
 * Unicode 私有使用区（BMP 的 U+E000~F8FF 与 15/16 平面）。
 * 营地 App 用这些码位显示自家图标（大神认证、赛事标等），
 * 换到别的字体里就是豆腐块或空白，所以统一剔除。
 */
const PRIVATE_USE_RE = /[\uE000-\uF8FF]|[\uDB80-\uDBBF][\uDC00-\uDFFF]/g

/**
 * 昵称兜底：剔除渲染不出来的字符，全没了就给个占位名。
 * 推送那边（utils/pushStore.js）也要拿营地昵称拼文案，同一套清洗规则，所以导出复用。
 */
export function normalizeName(name) {
  const cleaned = String(name || '')
    .replace(PRIVATE_USE_RE, '')
    .replace(INVISIBLE_RE, '')
    .trim()
  return cleaned || '无名召唤师'
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
 */
export function getAllBindings() {
  const userData = readYamlFile(USER_DATA_FILE) || {}
  const list = []

  for (const [botUserId, info] of Object.entries(userData)) {
    const ids = info?.ids || []
    const current = Number(info?.current ?? 0)

    ids.forEach((campId, index) => {
      const id = String(campId ?? '').trim()
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
  } catch {
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

  for (const [campId, botUserId] of targets) {
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
  }

  const result = { updatedAt: Date.now(), entries }
  writeSnapshot(result)

  return { ...result, fromCache: false, failed, hidden }
}

/**
 * 拉取单个账号的排名数据。
 * @returns 成功返回数据对象；隐藏主页返回 CODE_PROFILE_HIDDEN；其它失败返回 null
 */
async function fetchOne(campId, botUserId) {
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRY; attempt += 1) {
    try {
      const profileData = await ApiService.getProfile(campId, botUserId)
      const code = Number(profileData?.returnCode || 0)

      if (code === CODE_PROFILE_HIDDEN) {
        return CODE_PROFILE_HIDDEN
      }

      // 频控：退避后重试，等待时间随次数递增
      if (code === CODE_RATE_LIMITED) {
        if (attempt < RATE_LIMIT_RETRY) {
          await sleep(RATE_LIMIT_BACKOFF * (attempt + 1))
          continue
        }
        logger.debug(`[王者排名] ${campId} 多次触发频控，已跳过`)
        return null
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

  return null
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
export function buildRankList(entries, type, { campIds = null, ownerMap = {} } = {}) {
  const allow = campIds ? new Set(campIds.map(String)) : null

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

  return list.map((item, index) => ({
    ...item,
    index: index + 1,
    botUserId: ownerMap[String(item.campId)] || '',
    value: type === 'peak' ? String(item.peakScore) : `${item.rankName} ${item.rankStar}星`
  }))
}
