/**
 * 战绩归档。日报 / 周报的数据层。
 *
 * 为什么要落库，而不是每次现拉（2026-08-23 实测测试账号 1580886057）：
 * - `getMoreBattleList` **第一页 30 场，第二页起只给 10 场**。api.js 里
 *   「服务端固定一页 30 场」的注释只对第一页成立，翻页后每页缩到 10。
 * - 这个号一天打 28 场、3 天 58 场。本周（最多 7 天）约 200 场，
 *   现拉要 30 + 17×10 ≈ 18 次请求，而营地对请求总量敏感（-30107 频控）。
 * - 但战绩推送的轮询在玩家在线时每 2 分钟就拉一次第一页 —— 顺手落库就能把数据攒全，
 *   日报/周报直接读本地，零请求。所以归档挂在 pushStore.fetchLatest 里，
 *   轮询、订阅初始化、日报补页全都走它，一处覆盖所有入口。
 *
 * 存储：data/BattleArchive.json，按营地ID 分组，battles 按 dtEventTime 倒序（和接口一致）。
 */
import path from 'path'
import { readJsonFile, writeJsonFile } from './fileUtils.js'
import ApiService from './api.js'
import { PluginData } from '#components'

const ARCHIVE_FILE = path.join(PluginData, 'BattleArchive.json')

/**
 * 保留多少天。留到 35 天而不是 7 天，是给「月报」留余地，
 * 也让周报在轮询断过几天之后仍有历史可比。
 * 重度玩家一天 30 场 × 35 天 ≈ 1050 场 ≈ 210KB/账号，可以接受。
 */
export const ARCHIVE_KEEP_DAYS = 35

/**
 * 落库时只留这些字段。
 *
 * 完整的列表项有 60+ 个字段、约 1.5KB/场，全存 35 天单个账号就 1.3MB。
 * 这份清单是按「日报/周报真的会用到」挑的，其中
 * roleJobName / roleJob / stars / gameSeq 是给 pushStore.summarizeSession 用的——
 * 段位星数那套逻辑（小编号回绕、赛季切换、0 星是真实值）已经踩平了坑，
 * 少存一个字段就得在这边重写一遍。
 */
const KEEP_FIELDS = [
  'gameSeq', 'dtEventTime', 'gameresult', 'heroId', 'gradeGame',
  'mvpcnt', 'losemvp', 'mapName', 'usedTime',
  'killcnt', 'deadcnt', 'assistcnt',
  'roleJobName', 'roleJob', 'stars',
  'oldMasterMatchScore', 'newMasterMatchScore', 'desc'
]

const toInt = value => {
  const num = Number(value)
  return Number.isFinite(num) ? Math.trunc(num) : 0
}

/**
 * 整库的内存缓存。null 表示还没读过盘。
 *
 * 为什么要缓存：这个模块的每个导出函数原来都自己 `loadAll()` 一次，而
 * `collectBattles` 翻一页就要走 `archiveBattles`（读+写）+ `getWatermark`（读），
 * 周报翻 12 页 = 几十次整库 readFileSync/writeFileSync。现在 6 个账号 64KB 还无感，
 * 但保留 35 天、订阅涨到 20 个号就是 MB 级，而这些同步 IO 全发生在
 * 2 分钟一次的轮询里，会卡住整个 Bot 的事件循环。
 *
 * 缓存安全的前提：这个文件**只有本模块写**（全仓库检索确认过没有别处写 ARCHIVE_FILE），
 * 且 Yunzai 是单进程，所以内存里的就是权威副本，不存在别人改了盘而我们不知道的情况。
 * 用户手动改了盘上的文件不会被感知——那是可接受的，重启即生效。
 */
let cacheAll = null

/** 整库读。文件不存在或坏了都返回空表，绝不让定时任务因为归档挂掉 */
function loadAll () {
  if (cacheAll) return cacheAll

  try {
    const data = readJsonFile(ARCHIVE_FILE)
    cacheAll = data && typeof data === 'object' ? data : {}
  } catch {
    cacheAll = {}
  }

  return cacheAll
}

/**
 * 整库写。先更新内存再落盘：盘写失败时内存仍是最新的，
 * 后续读到的是正确数据，下一次写有机会把它持久化。
 */
function saveAll (data) {
  cacheAll = data || {}

  try {
    writeJsonFile(ARCHIVE_FILE, cacheAll)
    return true
  } catch (error) {
    logger.warn(`[战绩归档] 写入失败: ${error.message}`)
    return false
  }
}

/** 裁出要存的字段，顺手把数值字段规整成 number */
function slim (item) {
  const out = {}
  for (const key of KEEP_FIELDS) {
    const value = item?.[key]
    if (value === undefined || value === null) continue
    out[key] = typeof value === 'number' || /^(dtEventTime|gameresult|heroId|mvpcnt|losemvp|usedTime|killcnt|deadcnt|assistcnt|roleJob|stars|oldMasterMatchScore|newMasterMatchScore)$/.test(key)
      ? toInt(value)
      : String(value)
  }
  return out
}

/** 读单个账号的归档，倒序（最新在前） */
export function loadArchive (campId) {
  return loadAll()[String(campId)]?.battles || []
}

/**
 * 归档覆盖到什么范围，用来判断日报/周报要不要翻页补齐。
 * @returns {{earliest:number, latest:number, count:number}} 时间戳单位秒，空库全 0
 */
export function getArchiveRange (campId) {
  const battles = loadArchive(campId)
  if (!battles.length) return { earliest: 0, latest: 0, count: 0 }

  return {
    earliest: toInt(battles[battles.length - 1]?.dtEventTime),
    latest: toInt(battles[0]?.dtEventTime),
    count: battles.length
  }
}

/**
 * 完整性水位：已经确认翻页拉取到的最早时刻（秒），0 表示从没翻过页。
 *
 * 和「库里最早一场的时间」是两回事，别混用：玩家上周休假一局没打时，
 * 库里最早一场可能是三天前，但水位可以是十天前——那段确实翻过，只是没有战绩。
 * 判断「要不要为某个区间发请求」只能看水位。
 */
export function getWatermark (campId) {
  return toInt(loadAll()[String(campId)]?.oldestFetched)
}

/** 水位只能往更早推进（取 min），并且不能早于裁剪边界——那之前的数据已经被删了 */
function setWatermark (campId, reachedSec) {
  const key = String(campId)
  const reached = toInt(reachedSec)
  if (!key || reached <= 0) return

  const all = loadAll()
  const entry = all[key] || { battles: [] }
  const current = toInt(entry.oldestFetched)
  const next = current > 0 ? Math.min(current, reached) : reached

  if (next === current) return

  entry.oldestFetched = Math.max(next, cutoffSec())
  all[key] = entry
  saveAll(all)
}

/** 保留窗口的下边界（秒） */
function cutoffSec () {
  return Math.floor(Date.now() / 1000) - ARCHIVE_KEEP_DAYS * 86400
}

/**
 * 把一批战绩合并进归档。
 *
 * 幂等：按 gameSeq 去重，同一场重复落库只留一份（轮询每 2 分钟拉的 30 场里
 * 绝大多数都是上一轮见过的，全靠这里去重）。
 *
 * @param {string|number} campId 营地ID
 * @param {Array<object>} list 战绩列表项（原始的，函数内部自己裁字段）
 * @returns {number} 本次新增了几场
 */
export function archiveBattles (campId, list) {
  const key = String(campId || '')
  if (!key || !Array.isArray(list) || !list.length) return 0

  const all = loadAll()
  const existed = all[key]?.battles || []

  const bySeq = new Map()
  for (const item of existed) {
    const seq = String(item?.gameSeq || '')
    if (seq) bySeq.set(seq, item)
  }

  const before = bySeq.size
  for (const item of list) {
    const seq = String(item?.gameSeq || '')
    if (!seq || bySeq.has(seq)) continue
    bySeq.set(seq, slim(item))
  }

  const added = bySeq.size - before
  // 没有新场次就别写文件：轮询每 2 分钟一次，绝大多数轮次都是这种情况
  if (!added) return 0

  const cutoff = cutoffSec()
  const battles = [...bySeq.values()]
    .filter(item => toInt(item?.dtEventTime) >= cutoff)
    .sort((a, b) => toInt(b?.dtEventTime) - toInt(a?.dtEventTime))

  const prevMark = toInt(all[key]?.oldestFetched)
  all[key] = {
    updatedAt: Date.now(),
    // 水位要跟着写回，别被这次落库覆盖掉；而且裁剪已经把老数据删了，
    // 水位不能还声称覆盖到裁剪线之前
    ...(prevMark > 0 ? { oldestFetched: Math.max(prevMark, cutoff) } : {}),
    battles
  }
  saveAll(all)

  return added
}

/**
 * 取「fromSec 到现在」这段的战绩，读库优先、不够才翻页补。
 *
 * 「库够不够」要同时看两头，只看一头就会出错：
 * - **老的那头**看水位 `oldestFetched`，不是「库里最早一场的时间」——玩家那段时间
 *   可能压根没打，库里最早一场永远晚于区间起点，拿它当判据就会每次查都重翻一遍页。
 *   水位记的是「我们确实翻页翻到过哪里」。
 * - **新的那头**必须实拉第一页，不能只靠水位就直接读库。水位只保证「更早的翻过」，
 *   完全不保证库是新的：只开了日报/周报、没开战绩推送的订阅，
 *   `needBattleList` 判定为 false，轮询根本不会调 fetchLatest，库的头就一直冻在
 *   上次落库那天。实测 2026-08-25 有账号库里最新一场停在 08-22，
 *   而水位 08-19 已越过今天零点 —— 于是日报零请求读库、答「今天还没有对局记录」，
 *   同一时刻 #查询战绩 现拉却明明有 6 场。第一页固定 30 场、一次请求，
 *   日报是用户主动查或一天一次的定时，这点开销换正确性是值的。
 *
 * @param {string|number} campId 营地ID
 * @param {string|number} qq 属主QQ，authStore 按它取鉴权候选，不能省
 * @param {number} fromSec 区间起点（秒）
 * @param {object} [options]
 * @param {number} [options.maxPages=12] 最多翻几页。第一页 30 场、之后每页 10，
 *   12 页 ≈ 140 场。重度玩家一整周能打 200 场，所以这里可能盖不住，靠 truncated 如实标注
 * @returns {Promise<{battles:Array<object>, coveredFrom:number, truncated:boolean, fetched:number}>}
 *   battles 倒序且已按 fromSec 过滤；coveredFrom 是实际覆盖到的最早时刻；
 *   truncated 为真表示撞了页数上限、区间起点没够着
 */
export async function collectBattles (campId, qq, fromSec, { maxPages = 12 } = {}) {
  const key = String(campId || '')
  const from = toInt(fromSec)
  const inRange = list => list.filter(item => toInt(item?.dtEventTime) >= from)

  // 落库前库里最新一场。第一页要一直翻到接上它，中间才没有空洞：
  // 库冻了几天的情况下，光拉第一页可能只补上最近几场，和库之间还缺一段
  const headBefore = toInt(loadArchive(key)[0]?.dtEventTime)

  let lastTime = 0
  let reached = 0
  let fetched = 0
  let truncated = false

  for (let page = 0; page < maxPages; page += 1) {
    let res
    try {
      res = await ApiService.getMoreBattleList(key, String(qq), { option: 0, lastTime })
    } catch (error) {
      logger.debug(`[战绩归档] ${key} 第 ${page + 1} 页拉取失败: ${error.message}`)
      break
    }

    if (Number(res?.returnCode || 0) !== 0) {
      logger.debug(`[战绩归档] ${key} 第 ${page + 1} 页返回异常码 ${res?.returnCode}`)
      break
    }

    const data = res?.data || {}
    const list = data.list || []
    if (!list.length) break

    fetched += 1
    archiveBattles(key, list)
    reached = toInt(list[list.length - 1]?.dtEventTime)

    // 这一页已经翻过区间起点，够了
    if (reached <= from) break

    // 水位说更早的翻过了，而且这一页已经接上了原来库里的头 —— 中间没空洞，可以收工。
    // 顺序很重要：这个判断必须在实拉第一页之后，放在循环外就退化成「只看水位」的旧 bug
    const watermark = getWatermark(key)
    if (watermark > 0 && watermark <= from && headBefore > 0 && reached <= headBefore) {
      reached = watermark
      break
    }

    if (!data.hasMore || !data.lastTime) {
      // 接口说没有更多历史了。再往前也拉不到，把水位直接推到区间起点，
      // 否则下次查同一区间又会为这段不存在的历史白翻一遍
      reached = from
      break
    }

    lastTime = data.lastTime

    // 还有页可翻但名额用完了
    if (page === maxPages - 1) truncated = true
  }

  if (reached > 0) setWatermark(key, reached)

  const finalMark = getWatermark(key)

  return {
    battles: inRange(loadArchive(key)),
    coveredFrom: finalMark > 0 ? Math.max(finalMark, from) : from,
    truncated,
    fetched
  }
}
