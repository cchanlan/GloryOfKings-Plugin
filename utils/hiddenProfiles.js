/**
 * 「隐藏了主页」的玩家标注。
 *
 * 营地对隐藏主页的玩家返回 -10107（召唤师隐藏了主页信息，无法查看），这类号的资料
 * 永远拿不到，但插件的定时任务每一轮都会重新查一次——白费一个请求，还助推 -30107 频控。
 *
 * 这里把命中的玩家记下来，24 小时内**主动取数**一律跳过：
 *   gameRecordPush 的定时轮询、rankStore 的批量刷榜、battleArchive 的日报补页、
 *   groupReportStore 的群报扫描，都会先问一句 isProfileHidden。
 *
 * 用户点名查的指令（#王者主页 @某人 / #查询战绩 @某人 …）**不受影响**：那是用户明确
 * 要看的东西，而且对方随时可能取消隐藏，得让他当场就能发现。
 *
 * 标注对象是**被查的那个玩家**（targetUserId），不是发起请求的全局账号。
 *
 * 只处理 -10107。「隐藏战绩」（returnCode 为 0、响应里 invisible=true）不在此列：
 * 那类号 profile 照样查得到，要按接口区分才不误伤在线状态，改动大得多。
 */
import path from 'node:path'
import { PluginData } from '#components'
import { readJsonFile, writeJsonFile } from './fileUtils.js'
import { quarantineCorrupt } from './safeStore.js'

const HIDDEN_FILE = path.join(PluginData, 'HiddenProfiles.json')

/** 标注有效期 */
export const HIDDEN_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 进程内副本。null = 还没读过盘。
 *
 * 加这层是因为 isProfileHidden 会被「一次扫几十个账号」的循环反复调用
 * （collectRankData、collectGroupReport 都是逐账号循环），每次读盘纯属浪费。
 * 前提是**这个文件只由本模块写**、且单进程——与 battleArchive 的 cacheAll 同一假设。
 */
let cacheEntries = null

/** 营地ID 一律按纯数字串归一，认不出来的一律当没有 */
const normalizeId = value => {
  const text = String(value ?? '').trim()
  return /^\d+$/.test(text) ? text : ''
}

/** 读取全部标注，顺带剔除已过期的（惰性清理，不搞定时器） */
function loadEntries () {
  if (cacheEntries) {
    return cacheEntries
  }

  let raw = {}
  try {
    raw = readJsonFile(HIDDEN_FILE) || {}
  } catch (error) {
    // 标注是可再生的（下次命中会重新记），但坏文件留在原地会让每次读都失败，
    // 挪走它下次就能干净重建
    quarantineCorrupt(HIDDEN_FILE, error, '[王者隐藏主页]')
    raw = {}
  }

  const source = raw.entries && typeof raw.entries === 'object' ? raw.entries : {}
  const now = Date.now()
  const entries = {}

  for (const [campId, item] of Object.entries(source)) {
    const id = normalizeId(campId)
    if (!id) continue

    const hiddenUntil = Number(item?.hiddenUntil) || 0
    if (hiddenUntil <= now) continue

    entries[id] = {
      hiddenAt: Number(item?.hiddenAt) || 0,
      hiddenUntil,
      nickname: String(item?.nickname || '')
    }
  }

  cacheEntries = entries
  return entries
}

function saveEntries (entries) {
  cacheEntries = entries
  writeJsonFile(HIDDEN_FILE, { updatedAt: Date.now(), entries })
}

/** 这个玩家是不是还在标注期内 */
export function isProfileHidden (campId) {
  const id = normalizeId(campId)
  if (!id) {
    return false
  }

  return Boolean(loadEntries()[id])
}

/**
 * 标注一个玩家，返回到期时间戳（营地ID 不合法时返回 0）。
 *
 * 重复命中会顺延：24 小时内又查到一次隐藏，说明对方还在隐藏，
 * 到期时间从这次重新算起。
 */
export function markProfileHidden (campId, nickname = '') {
  const id = normalizeId(campId)
  if (!id) {
    return 0
  }

  const entries = loadEntries()
  const now = Date.now()
  const hiddenUntil = now + HIDDEN_TTL_MS

  entries[id] = {
    // hiddenAt 记第一次命中的时刻，方便排查「从什么时候开始隐藏的」
    hiddenAt: entries[id]?.hiddenAt || now,
    hiddenUntil,
    nickname: String(nickname || entries[id]?.nickname || '')
  }
  saveEntries(entries)

  return hiddenUntil
}

/** 供指令展示：标注中的玩家 + 剩余时长，快到期的排前面 */
export function listHiddenProfiles () {
  const now = Date.now()
  return Object.entries(loadEntries())
    .map(([campId, item]) => ({
      campId,
      nickname: item.nickname,
      hiddenAt: item.hiddenAt,
      hiddenUntil: item.hiddenUntil,
      remainMs: Math.max(0, item.hiddenUntil - now)
    }))
    .sort((left, right) => left.hiddenUntil - right.hiddenUntil)
}

/** 清除一条标注，返回是否真的删掉了 */
export function clearHiddenProfile (campId) {
  const id = normalizeId(campId)
  if (!id) {
    return false
  }

  const entries = loadEntries()
  if (!entries[id]) {
    return false
  }

  delete entries[id]
  saveEntries(entries)
  return true
}

/** 清除全部标注，返回清掉的条数 */
export function clearAllHiddenProfiles () {
  const entries = loadEntries()
  const count = Object.keys(entries).length

  if (count > 0) {
    saveEntries({})
  }

  return count
}
