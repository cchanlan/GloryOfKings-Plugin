/**
 * 战绩推送 / 开局提醒的数据层。
 *
 * 数据源只有一个：营地战绩列表 /game/morebattlelist（ApiService.getMoreBattleList）。
 * 2026-08-22 实跑测试账号完整抓到一局的开始与结束，证实一次请求就能同时喂两个功能：
 *   19:08  isGaming=true   gaming={巅峰赛 hero519 dur=7 start=1787396452}  list[0].gameSeq=1787395410
 *   19:16  isGaming=false  gaming=null                                     list[0].gameSeq=1787396363
 * isGaming 翻转与新场次进入 list 是同一时刻发生的，所以不需要两个轮询任务、不需要两次请求。
 *
 * 三个实测出来的坑（光看返回体猜不出来，改动前务必先看）：
 * 1. straightWin / straightLose 不可用：上面那局明确赢了，两个字段仍是 0/0。连胜自己从 list 连续段算。
 * 2. 列表里的 oldMasterMatchScore / newMasterMatchScore 在巅峰赛场次才有意义。
 *    排位赛场次也会带上这两个字段（实测「排位赛 三排」一局 old=new=1795），但前后相等，
 *    表示这局不影响巅峰分 —— 所以判据是 old != new，不是「字段有没有值」。
 *    真正没打过巅峰赛的号这两个字段才是 0（data/BattleList.json 那份缓存 30 场全是 0）。
 *    巅峰分拿不到时回落到 roleJobName + stars 显示段位星数变化。
 * 3. stars 的语义随段位体系变化：旧体系「最强王者」按 roleJob 小编号每 5 星一段
 *    （段内星 0~5 循环，2026-07 底赛季切换前的数据实测 roleJob=23~26）；新体系
 *    「荣耀王者」恒为 roleJob=16、stars 直接是累计星数。所以判升降优先比 roleJob
 *    编号，编号没变时星数差才是真实变动；段位名变了就只报段位变化，不算差。
 *
 * 纯计算逻辑（连胜、筛新场次、文案）都放在这个文件里而不是 apps/ 下，
 * 因为 apps/*.js 的 `extends plugin` 依赖 Yunzai 注入的全局，脱离 Bot 环境 import 就崩，没法单测。
 */
import fs from 'node:fs'
import path from 'path'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'
import { quarantineCorrupt } from './safeStore.js'
import ApiService from './api.js'
import cache from './cache.js'
import { archiveBattles } from './battleArchive.js'
// 营地昵称里常有私有区图标和不可见字符，直接拼进文案会显示成豆腐块或整段空白，
// 清洗规则和排行榜是同一套，复用 rankStore 的实现。
// 再导出一次：apps/gameRecordPush.js 拼战绩文案时也要洗名字，
// 让它只依赖 pushStore 这一个数据层，不用再单独引 rankStore
import { normalizeName } from './rankStore.js'
export { normalizeName }
// ⚠️ 必须 **import 一次再 export** —— 只写 `export { x } from './y.js'` 是**转出**，
//    本文件作用域里没有 `x` 这个绑定，同文件里调用它就是 `ReferenceError: x is not defined`
//    （2026-09-20 踩过：decideHint 里调 isWatchableMode 直接炸，见文件里那处注释）
import { isWatchableMode } from './watchMode.js'
// 段位高低的判据（大段位层级）与「跳变」的判据都在段位趋势那边，同一套口径只留一份实现
import { rankBand, isRankJump } from './rankTrend.js'
import { PluginData } from '#components'

const PUSH_FILE = path.join(PluginData, 'GameRecordPush.yaml')

/**
 * 深拷贝。优先 `structuredClone`（Node 17+ 全局），拿不到时退回 JSON 往返 ——
 * 订阅项里只有字符串/数字/布尔，JSON 往返语义完全够。能力探测是必要的：
 * 插件会被装在各种 Node 版本上跑，这里不该成为启动即崩的那一行。
 */
const deepCopy = typeof structuredClone === 'function'
  ? structuredClone
  : (value) => JSON.parse(JSON.stringify(value))

/**
 * 订阅表的解析结果缓存：`{ mtimeNs, size, data }`。data 是整张表（qq -> 订阅项）。
 *
 * ## 为什么必须有它
 *
 * 这张表被读写得极频繁，而且**都在同步循环里**：推送轮询给每个退避中的订阅
 * 减一次 skipTicks，用户规模下是几百次「整表读 + 整表写」。实测（2026-09-26）
 * 一张 400 条记录 / 155KB 的表，单次 parse 198ms + stringify 89ms ——
 * 几百次就是**一分多钟的同步阻塞**，而那段循环里一个 await 都没有，
 * 事件循环完全停摆（表现就是「定时任务一跑，机器人整个僵住」）。
 *
 * 缓存靠**文件指纹**失效，不靠写入方主动通知：这张表的写入方有指令、日报、推送轮询
 * 好几处，逐个加失效调用一定会漏，漏一处就是「用户刚关掉的推送又自己开回来了」。
 * 指纹判定对写入方零要求。
 *
 * ⚠️ `currentList()` 返回的是**缓存本体**，只给本文件内部用，调用方不得修改。
 * 对外的 `loadPushList()` 一律返回拷贝 —— 调用方拿到的表可以随便改，
 * 而写盘失败时也不会留下「内存有、盘上没有」的脏缓存。
 */
let listCache = null

/**
 * 取文件的指纹。文件不存在或 stat 失败时返回 null。
 *
 * 用 `bigint: true` 拿**纳秒级**的 mtimeNs，而不是毫秒级的 mtimeMs：毫秒精度下同一
 * 毫秒内的两次写会得到同一个值，只能靠 size 兜底，而「改了个等长的值」（skipTicks
 * 5→4 就是）size 也不变 —— 那就漏判了。纳秒精度下这个窗口小到可以忽略。
 *
 * ⚠️ 纳秒精度的上限取决于文件系统（ext4 纳秒、NTFS 约 100 纳秒、FAT 只有 2 秒），
 *    所以它不是绝对保证。真正的保证来自写入方：`savePushList` 写完会主动把缓存
 *    对齐过去，不依赖指纹；指纹只用来接住「用户手改了文件」这类外部改动。
 */
function fingerprint () {
  try {
    const stat = fs.statSync(PUSH_FILE, { bigint: true })
    return { mtimeNs: stat.mtimeNs, size: stat.size }
  } catch {
    return null
  }
}

/** 拿缓存里的整张订阅表（**不拷贝**）。调用方不得修改返回值 */
function currentList () {
  const fp = fingerprint()
  if (!fp) {
    listCache = null
    return {}
  }
  if (listCache && listCache.mtimeNs === fp.mtimeNs && listCache.size === fp.size) return listCache.data

  try {
    const data = readYamlFile(PUSH_FILE)
    const list = data?.pushList
    const value = list && typeof list === 'object' ? list : {}
    listCache = { mtimeNs: fp.mtimeNs, size: fp.size, data: value }
    return value
  } catch (error) {
    // 解析失败要把坏文件隔离出去（留证 + 打日志），理由见 utils/safeStore.js。
    // 隔离后文件不在了，下次读会走上面 !fp 那条路返回空表
    quarantineCorrupt(PUSH_FILE, error, '[王者推送]')
    listCache = null
    return {}
  }
}

/* ------------------------------------------------------------------ 订阅存取 */

/**
 * 读取订阅表（返回**拷贝**，调用方随便改）。文件缺失或内容损坏时返回空表，不抛错——
 * 这个文件由 index.js 启动时创建成 { pushList: {} }，但用户手动编辑坏了也不该让定时任务挂掉。
 *
 * 「坏了返回空表」有个隐蔽的副作用必须堵住：轮询和指令都会在读完之后写回，
 * 空表会被 savePushList 固化下来，于是「文件坏了」变成「所有人的订阅都没了」，
 * 而且一行日志都没有。所以解析失败时把坏文件隔离出去（留证 + 打日志），
 * 详见 utils/safeStore.js。
 *
 * @returns {Record<string, object>} qq -> 订阅项
 */
export function loadPushList () {
  return deepCopy(currentList())
}

/** 整表写回。只在指令场景用（开启/关闭订阅），轮询里一律走 mergeSubState / mergeSubStates */
export function savePushList (pushList) {
  const data = { pushList: pushList || {} }
  writeYamlFile(PUSH_FILE, data)

  // 写盘之后把缓存对齐到刚写下去的内容。存的是拷贝：调用方常常是
  // `savePushList(list)` 之后就 return，但也可能顺手再改 list，存引用会让缓存跟着变。
  // ⚠️ 顺序不能反 —— 必须先写盘成功再更新缓存，写盘抛错时缓存保持旧值，
  //    下次读会因指纹对不上而重新读盘，不会出现「内存新、盘上旧」的假象
  const fp = fingerprint()
  listCache = fp ? { mtimeNs: fp.mtimeNs, size: fp.size, data: deepCopy(data.pushList) } : null
}

/**
 * 批内待落盘的 patch。null = 当前不在批里。
 * 见 beginSubBatch / endSubBatch。
 */
let pendingPatches = null

/**
 * 开始一个「订阅写批」。
 *
 * 一轮检查单个订阅会分好几处写同一条记录（战绩游标、上下线基准、开播提示、退避计数…），
 * 每处都整表读改写一次。用户规模下那是几百毫秒一次的同步阻塞，而它们改的是**互不重叠的
 * 字段**，没有任何一处需要读到前一处刚写的值 —— 攒起来最后写一次，结果完全等价。
 *
 * ⚠️ 批内 `mergeSubState` 的返回值是**乐观的 true**（此刻还不知道订阅在不在），
 *    所以**不要在批内靠返回值判断订阅是否存在**，那个判断请用 loadPushList()。
 * ⚠️ 不支持嵌套：已经在批里时返回 false，调用方自己保证成对。
 *
 * @returns {boolean} 是否成功开批（false = 已经在批里）
 */
export function beginSubBatch () {
  if (pendingPatches) return false
  pendingPatches = []
  return true
}

/**
 * 结束批并把攒下的 patch 一次落盘。
 * @returns {number} 实际写入的条数（订阅已被删掉的会跳过，不计入）
 */
export function endSubBatch () {
  const patches = pendingPatches
  pendingPatches = null
  if (!patches?.length) return 0
  return mergeSubStates(patches)
}

/**
 * 字段级合并写回单个订阅。
 *
 * 轮询一轮要几十秒（串行 + 800ms 间隔），期间用户完全可能开启或关闭订阅。
 * 如果拿轮询开始时的旧快照整体写回，用户这期间的改动会被静默覆盖掉，
 * 表现出来就是「刚关了推送又自己开回来了」。所以每次写之前重新读一遍再合并。
 * 订阅已被删除时不重建，直接返回 false。
 *
 * @param {string|number} qq 订阅者 QQ
 * @param {object} patch 要合并进去的字段
 * @returns {boolean} 是否写入成功（在批里时恒为 true，见 beginSubBatch 的警告）
 */
export function mergeSubState (qq, patch) {
  const key = String(qq)
  // 在批里：只攒不写，批结束时统一落盘
  if (pendingPatches) {
    pendingPatches.push([key, patch])
    return true
  }

  const list = deepCopy(currentList())
  if (!list[key]) return false

  list[key] = { ...list[key], ...patch }
  savePushList(list)
  return true
}

/**
 * 批量字段合并写回。语义与逐条调 `mergeSubState` 完全一致，只是把 N 次
 * 「整表读 + 整表写」合并成 1 次。
 *
 * 推送轮询里对**每个退避中的订阅**都要把 skipTicks 减一，用户规模下那是几百次全表
 * 读改写（155KB 的表单次约 287ms）—— 几百次就是一分多钟的同步阻塞。攒起来一次写完。
 *
 * ⚠️ 只在**批结束时**读表，所以期间用户改过订阅（文件指纹变了）会自动拿到最新那份，
 *    逐条合并进去，不会整表覆盖掉用户刚做的改动。订阅已被删除的跳过、不重建。
 *
 * @param {Array<[string|number, object]>} patches 要合并的 (qq, patch) 列表
 * @returns {number} 实际写入的条数
 */
export function mergeSubStates (patches) {
  if (!patches?.length) return 0

  const list = deepCopy(currentList())
  let count = 0
  for (const [qq, patch] of patches) {
    const key = String(qq)
    // 订阅已被删除时不重建，理由同 mergeSubState
    if (!list[key]) continue
    list[key] = { ...list[key], ...patch }
    count += 1
  }

  if (count) savePushList(list)
  return count
}

/**
 * 每个订阅之间的间隔。rankStore 用 600ms 拉 profile 能稳定跑完 20+ 账号，
 * morebattlelist 返回体比 profile 大一个量级，这里保守一档取 800ms。
 */
export const REQUEST_INTERVAL = 800

/** 对方隐藏了主页，这类账号永远拿不到战绩，不必重试 */
const CODE_PROFILE_HIDDEN = -10107

/** fetchLatest 的特殊返回：账号隐藏了战绩 */
export const FETCH_HIDDEN = Symbol('hidden')

/** 一次推送最多详细列几场，多出来的只报数量，避免轮询间隔内打了好几局把群刷炸 */
export const MAX_DETAIL_BATTLES = 3

/** 英雄总表的内存缓存键与有效期（秒）。表内容几乎不变，只有新英雄上线才需要更新 */
const HERO_MAP_CACHE_KEY = 'gok:heroNameMap'
const HERO_MAP_TTL = 6 * 60 * 60

/**
 * 离线退避的档位：不活跃多久（毫秒）→ 检查间隔是 cron 的几倍。
 * `multiplier: null` 表示用配置的封顶值。
 *
 * 用**倍数**而不是绝对分钟，是因为 Yunzai 的 task cron 在 constructor 里注册就固定了、
 * 运行时改不了，所以降频只能在应用层按 tick 跳过。用倍数就不必解析 cron 表达式，
 * 而且用户把 battleResultCron 从 2 分钟改成 5 分钟时，整套策略跟着缩放。
 *
 * 档位从长到短排列，取第一个命中的。
 */
const IDLE_BACKOFF_STEPS = [
  { afterMs: 3 * 3600 * 1000, multiplier: null },
  { afterMs: 1 * 3600 * 1000, multiplier: 3 },
  { afterMs: 0, multiplier: 2 }
]

/** 离线最长退避到几倍 cron 间隔。1 = 关闭自适应，全程按 cron 轮询 */
export const DEFAULT_IDLE_BACKOFF_MAX = 5

/**
 * 「最近打过」的判定窗口（秒）。只开战绩推送、没有 profile 信号的订阅靠它判活跃：
 * 玩家真在连着打时每 15 分钟左右就有一局进列表，30 分钟没有新场次基本就是收工了。
 */
const RECENT_BATTLE_WINDOW = 30 * 60

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const toInt = value => {
  const num = Number(value)
  return Number.isFinite(num) ? Math.trunc(num) : 0
}

/* --------------------------------------------------------------- 订阅开关 */

/**
 * 一条订阅上所有的推送开关。
 *
 * 这份清单必须是**全的**：`disableSubFlag` 靠它判断「还有没有别的开关开着」，
 * 漏一个就会在关掉某个开关时把整条订阅删掉，连带把漏掉那个也静默关了。
 * 加新的推送种类时记得往这里补一项。
 *
 * battle / online 在 apps/gameRecordPush.js，daily / weekly / monthly 在 apps/battleReport.js，
 * 五者共用 GameRecordPush.yaml 的同一条记录（group / campId / roleName 都是现成的）。
 * 群报的订阅不在这里——那是按群存的，见 utils/groupReportStore.js。
 *
 * ⚠️ 这份清单里**只有会播报的推送**。曾经还有一个 `onlineStatus`——它不播报，只用来标记
 *    「这是自动补建出来的影子订阅，给 `#谁在打游戏` 垫名单用」。整套影子订阅机制已在
 *    2026-09-26 废除：那份名单现在由群成员索引现算、查看时现刷（apps/whoIsPlaying.js），
 *    不需要任何订阅记录垫底。别把它加回来。
 */
export const SUB_FLAGS = ['battle', 'online', 'daily', 'weekly', 'monthly']

/**
 * 某个开关是否开着。
 * battle 要按「缺字段算开着」处理——首个版本的订阅没写这个字段，
 * 其余几个都是后加的，缺失就是没开。
 */
export function isFlagOn (sub, key) {
  if (!sub) return false
  return key === 'battle' ? sub.battle !== false : sub[key] === true
}

/** 这条订阅还有任何一路推送开着吗 */
export function hasAnyFlag (sub) {
  return SUB_FLAGS.some(key => isFlagOn(sub, key))
}

/**
 * 关掉一路推送。全部开关都关了才把整条订阅删掉，别留个空壳占着轮询名额。
 *
 * 判「是不是全关了」必须过 SUB_FLAGS 全集。早先这里只看 battle / online，
 * 于是先 #开启日报推送 再 #关闭战绩推送 会把整条记录 delete，日报跟着静默失效。
 *
 * @param {string|number} qq 订阅者 QQ
 * @param {'battle'|'online'|'daily'|'weekly'|'monthly'} key 要关掉的开关
 * @returns {{wasOn: boolean, removed: boolean}} wasOn 为假时什么都没改
 */
export function disableSubFlag (qq, key) {
  const id = String(qq)
  const list = loadPushList()
  const sub = list[id]
  if (!sub) return { wasOn: false, removed: false }

  if (!isFlagOn(sub, key)) return { wasOn: false, removed: false }

  sub[key] = false
  const removed = !hasAnyFlag(sub)

  if (removed) delete list[id]
  else list[id] = sub

  savePushList(list)
  return { wasOn: true, removed }
}

/* --------------------------------------------------------------- 推送群 */

/**
 * 这条订阅要推到哪些群。
 *
 * 历史上 `group` 是**单值**字符串（一个用户只能推一个群，换群开启就把旧群顶掉），
 * 后来加了 `groups` 数组支持多群。两个字段同时读并去重，是为了兼容老订阅：
 * 老记录只有 `group`，新记录两者都写（`group` 保留第一个群，给只认单值的旧代码兜底）。
 *
 * @param {object} sub 订阅项
 * @returns {string[]} 群号数组，已去重去空
 */
export function subGroups (sub) {
  const out = []
  const push = value => {
    const id = String(value ?? '').trim()
    if (id && !out.includes(id)) out.push(id)
  }

  push(sub?.group)
  if (Array.isArray(sub?.groups)) sub.groups.forEach(push)

  return out
}

/**
 * 这条订阅是不是「空壳」——**既没有任何一路推送开着，也没有推送目标群**。
 *
 * ⚠️ 判据不能用 `hasAnyFlag`：它对**缺失**的 `battle` 字段按「开着」算（为了兼容首个
 * 版本写下的订阅，那些记录没有这个字段），而空壳恰好也没有 `battle` 字段，会被它
 * 误判成正式订阅。所以这里要求开关**显式为 true**。
 *
 * 空壳是怎么来的：`#开启在线状态` 把隐身标记（`optedOut`）清掉之后，如果这个人本来就
 * 没开任何推送，记录里就只剩个 `{}`。留着它有害无益 —— `checkAll` 的 entries 过滤走
 * `isFlagOn(sub,'battle')`（缺字段算开着），于是这条空壳会被收进轮询名单：每轮白占
 * 一个请求预算（`MAX_REQUESTS_PER_ROUND` 才 6 个）、白等一次 800ms 错峰，
 * 而且它**永远清不掉**（`hasAnyFlag` 恒为真，`disableSubFlag` 也碰不到它）。
 *
 * ⚠️ 「有推送目标群」的订阅一律不算空壳：用户开着 battle 但还没打过、groups 是空的，
 * 那是他明确要的推送；首个版本的订阅同样没有 `battle` 字段，靠群号把它认出来。
 */
export function isJunkSub (sub) {
  if (!sub) return true
  if (subGroups(sub).length) return false
  return !SUB_FLAGS.some(key => sub[key] === true)
}

/**
 * 把群号并进订阅的推送群列表，返回要写回的字段。
 * `group` 恒等于列表第一项：只认单值 `group` 的旧代码路径至少还能推到一个群。
 * @returns {{groups:string[], group:string, added:boolean}}
 */
export function withSubGroup (sub, groupId) {
  const id = String(groupId ?? '').trim()
  const groups = subGroups(sub)
  const added = Boolean(id) && !groups.includes(id)
  if (added) groups.push(id)

  return { groups, group: groups[0] || '', added }
}

/**
 * 从订阅的推送群列表里摘掉一个群。
 * @returns {{groups:string[], group:string, removed:boolean, empty:boolean}}
 *   empty 为真表示一个群都不剩了，调用方应该顺手把开关整个关掉
 */
export function withoutSubGroup (sub, groupId) {
  const id = String(groupId ?? '').trim()
  const groups = subGroups(sub)
  const rest = id ? groups.filter(item => item !== id) : groups

  return {
    groups: rest,
    group: rest[0] || '',
    removed: rest.length !== groups.length,
    empty: rest.length === 0
  }
}

/* ------------------------------------------------------- 连胜/连败里程碑 */

/**
 * 开始额外播报的连胜/连败场次。到这个数之后**每一场**都播，文案每场随机挑。
 * 之下不播：2 连胜起战绩文案里本来就有一行 `🔥 当前 N 连胜`（见 buildBattleMessage），
 * 里程碑是在那之上单独拎出来的一条，太早喊就成了每局都在刷。
 */
export const STREAK_MIN = 3

/**
 * 连胜文案池：按连胜数落在哪一段分池，播报时从那一池里随机抽一条。`{count}` 换连胜数。
 * 分段而不是一档一条 —— 语气得跟场次配得上（3 连说「趁热再来」，18 连说「巡视领地」），
 * 同一段里的话在这个区间里读起来都成立。最后一段 max 是 Infinity，兜住无上限的长串。
 *
 * 三条硬要求，加新文案时照着来：
 * 1. 不写玩家名 —— 这条是拼在战绩那条消息末尾一起发的（见 gameRecordPush 的 blocks），
 *    开头已经有昵称和「打完一局」，再提一次就是同一句话说两遍。
 * 2. 不提「排位」「段位」这类只对排位成立的词 —— 巅峰赛、娱乐局同样会走到这里，
 *    写死模式名就会出现「打的是巅峰赛却说排位」。要提分数就用通用的「上分」「分数」。
 * 3. 不写只对某个具体数字成立的话（「再赢一把就上两位数」这种）—— 一池覆盖好几个场次，
 *    抽到时数字对不上就闹笑话。一句话要在整段区间里都说得通才能放进来。
 */
const WIN_STREAK_POOLS = [
  {
    max: 4,
    texts: [
      '🎉🔥 {count} 连胜！手感彻底热起来了，趁热再来一把',
      '🔥🔥 {count} 连胜！已经可以开始挑对手了',
      '✨🔥 {count} 连胜！今天这手感建议别停',
      '🎯 {count} 连胜！稳住这个节奏就行',
      '🔥 {count} 连胜！开局就顺，接着来',
      '😎 {count} 连胜！看着是准备干票大的',
      '⚡ {count} 连胜！热身结束了是吧',
      '🎉 {count} 连胜！这波状态在线'
    ]
  },
  {
    max: 6,
    texts: [
      '⚡ {count} 连胜！对面要开始查战绩了',
      '⚡🔥 {count} 连胜！一个人把全队胜率抬起来了',
      '🔥⚡ {count} 连胜！这手感有点烫手',
      '🌟 {count} 连胜！赢得有点习惯了',
      '💪 {count} 连胜！这一串开始有分量了',
      '⚔️ {count} 连胜！谁遇上谁倒霉',
      '📈 {count} 连胜！分数一路往上走',
      '😏 {count} 连胜！对面大概不太想再碰到'
    ]
  },
  {
    max: 9,
    texts: [
      '🚀 {count} 连胜！这是要打穿一整个赛季',
      '🚀✨ {count} 连胜！排到一队的都在偷偷道谢',
      '🔥🚀 {count} 连胜！刹车是坏了吗',
      '🌠 {count} 连胜！这势头有点收不住',
      '🛡️ {count} 连胜！队友只要跟着走就行',
      '🎢 {count} 连胜！这一串越滚越大',
      '💥 {count} 连胜！打谁都像打训练营',
      '😤 {count} 连胜！这会儿谁劝退都不好使'
    ]
  },
  {
    max: 12,
    texts: [
      '👑🎉 {count} 连胜达成！建议直接开个直播',
      '🏆 {count} 连胜！已经开始不讲道理了',
      '🏆🔥 {count} 连胜！对面选人阶段看到就想投',
      '💯 {count} 连胜！两位数了，这数字自己都不敢信',
      '👑 {count} 连胜！峡谷今天姓你了',
      '🎇 {count} 连胜！赢到有点找不到对手',
      '🥇 {count} 连胜！这一串够吹一整周了',
      '🔮 {count} 连胜！开局就知道结果那种'
    ]
  },
  {
    max: 16,
    texts: [
      '💫 {count} 连胜！这把要是输了都算大新闻',
      '💫👑 {count} 连胜！峡谷公告栏该挂个名了',
      '🌟 {count} 连胜！已经是本群传说了',
      '🌟🔥 {count} 连胜！胜率曲线开始垂直向上',
      '🎆 {count} 连胜！这战绩截图出去没人信',
      '⚜️ {count} 连胜！对面是排队来送的吗',
      '🧨 {count} 连胜！这串数字看着都发烫',
      '🗿 {count} 连胜！稳得让人怀疑是不是本人'
    ]
  },
  {
    max: 20,
    texts: [
      '🐉 {count} 连胜！这已经不是上分，是搬家',
      '🐉✨ {count} 连胜！再来两把该被写进史书了',
      '🎖️👑 {count} 连胜！不是在打游戏，是在巡视领地',
      '🌟 {count} 连胜！这一串已经不像人类战绩了',
      '🏅 {count} 连胜！峡谷该给发个荣誉证书',
      '⛩️ {count} 连胜！对面已经放弃抵抗了',
      '🎇 {count} 连胜！这数字群里能吹一整个赛季',
      '🚩 {count} 连胜！这块地方算是插旗了'
    ]
  },
  {
    max: Infinity,
    texts: [
      '🔱 {count} 连胜！还在赢，已经没人拦得住了',
      '🔱🔥 {count} 连胜！这对局记录看着像假的',
      '🌌 {count} 连胜！给对面留一条活路吧',
      '🌌👑 {count} 连胜！这一串到底什么时候能到头',
      '🛸 {count} 连胜！这已经超出正常范围了',
      '🗻 {count} 连胜！这数字看着都得仰头',
      '♾️ {count} 连胜！赢的次数比歇的次数都多',
      '🎺 {count} 连胜！峡谷该奏乐了'
    ]
  }
]

/** 连败文案池，分段规则同上（不写名字、不写模式名、不写死数字）。语气要泄气但不能真扎人，群里被推的是本人 */
const LOSE_STREAK_POOLS = [
  {
    max: 4,
    texts: [
      '😮‍💨🧊 {count} 连败，先去喝口水，下一把稳住',
      '🧊🧊 {count} 连败，换个英雄试试运气',
      '😮‍💨 {count} 连败，节奏乱了，缓一把',
      '🧊 {count} 连败，这几局队友是抽到什么了',
      '💧 {count} 连败，不慌，翻回来不难',
      '🌀 {count} 连败，先深呼吸，别急着再开',
      '🍵 {count} 连败，喝口茶再战',
      '🙃 {count} 连败，运气也该轮到你了'
    ]
  },
  {
    max: 6,
    texts: [
      '☕ {count} 连败，认真的，歇一把再打',
      '☕😵 {count} 连败，今天大概不是上分的日子',
      '🌧️ {count} 连败，这雨下得有点久',
      '😵‍💫 {count} 连败，手感是不是不在身上',
      '🧊😮‍💨 {count} 连败，越急越乱，停一会儿',
      '🎧 {count} 连败，听两首歌再回来',
      '🍜 {count} 连败，先去吃点东西',
      '🙈 {count} 连败，这几把就当没打'
    ]
  },
  {
    max: 9,
    texts: [
      '🌧️ {count} 连败，峡谷欠一个正式道歉',
      '🌧️😮‍💨 {count} 连败，系统怕是安排了一路扶贫',
      '🛌 {count} 连败，下线睡觉才是最优解',
      '😩 {count} 连败，这运气该被投诉了',
      '🧊🧊 {count} 连败，真的该停手了',
      '🕯️ {count} 连败，给今天的手感点根蜡',
      '🪫 {count} 连败，电量见底了，充会儿',
      '🤝 {count} 连败，不是你的问题，是今天的问题'
    ]
  },
  {
    max: 12,
    texts: [
      '🛌💤 {count} 连败达成，明天再战一点都不丢人',
      '🕳️ {count} 连败，分数正在自由落体',
      '🕳️😭 {count} 连败，这是在挖隧道吗',
      '🧊💔 {count} 连败，两位数了，今天到此为止吧',
      '😔 {count} 连败，这串数字看着都心疼',
      '🚧 {count} 连败，前面全是坑，绕个路',
      '📉 {count} 连败，曲线已经不忍直视',
      '🫂 {count} 连败，群里给个抱抱'
    ]
  },
  {
    max: 16,
    texts: [
      '🆘 {count} 连败，群里有人愿意来救一下吗',
      '🆘🧊 {count} 连败，强烈建议今天到此为止',
      '⚰️ {count} 连败，峡谷已经降半旗了',
      '⚰️😵 {count} 连败，还在坚持，这份毅力值得敬礼',
      '🥶 {count} 连败，手感冻成冰了',
      '🧱 {count} 连败，撞墙撞了这么久，绕一下吧',
      '😭 {count} 连败，真的别再点开始了',
      '🛑 {count} 连败，这里插个牌子：请停'
    ]
  },
  {
    max: 20,
    texts: [
      '🌑 {count} 连败，运气应该已经见底了',
      '🌑😔 {count} 连败，真的不用再证明什么了',
      '🧯 {count} 连败，谁去把手机没收一下',
      '🧯🪦 {count} 连败，今天这一串就当没发生过',
      '🌚 {count} 连败，今晚的运气全被吃掉了',
      '💤 {count} 连败，睡一觉比什么都管用',
      '🫥 {count} 连败，建议原地消失一会儿',
      '🙏 {count} 连败，明天重新开始，真的'
    ]
  },
  {
    max: Infinity,
    texts: [
      '🥀 {count} 连败，已经打出了一种境界',
      '🥀😵‍💫 {count} 连败，胜率需要考古修复了',
      '🫠 {count} 连败，明天一定会赢的（大概）',
      '🫠🧊 {count} 连败，这一串再长下去要立碑了',
      '🕸️ {count} 连败，这一串能进博物馆了',
      '😶‍🌫️ {count} 连败，已经打到没有情绪了',
      '🔚 {count} 连败，今天该收摊了',
      '🌪️ {count} 连败，这阵风什么时候能过去'
    ]
  }
]

/** 上一条抽到的文案，同一池连着播两次时避开它，免得刚说过的话又来一遍。只放内存，重启忘掉无所谓 */
const lastStreakText = new Map()

/** 按场次找到所在那一段的文案池 */
function streakPool (type, count) {
  const pools = type === 'win' ? WIN_STREAK_POOLS : LOSE_STREAK_POOLS
  const at = pools.findIndex(p => count <= p.max)
  const idx = at < 0 ? pools.length - 1 : at
  return { key: `${type}:${idx}`, texts: pools[idx].texts }
}

/**
 * 挑出这一段的文案并填好场次。
 * `{who}` 仍然支持替换，但现在所有文案都不用它（名字由消息开头那段负责，见 WIN_STREAK_POOLS 注释）。
 */
function streakText (type, count, who) {
  const { key, texts } = streakPool(type, count)
  const last = lastStreakText.get(key)
  const pool = texts.length > 1 ? texts.filter(t => t !== last) : texts
  const tpl = pool[Math.floor(Math.random() * pool.length)] || texts[0] || ''
  lastStreakText.set(key, tpl)
  return tpl.replace(/\{who\}/g, who).replace(/\{count\}/g, String(count))
}

/**
 * 算这一局要不要播连胜/连败，以及播什么。
 *
 * 3 连起**每一场都播**，文案从场次所在那一段的池子里随机抽（见 WIN_STREAK_POOLS / LOSE_STREAK_POOLS）。
 * 去重键是「类型 + 具体场次」（`win:4`），所以 3 连之后每多赢一场就是新键、会再播一条；
 * 同一场被重复轮询到时键没变，不会重播。连胜断了（type 变或归零）返回空 key，
 * 下次从 3 连重新开始播。
 *
 * 注意一轮补推多场时只按**最新一场**的连胜数播一条（calcStreak 从最新往前数），
 * 中间跨过的档位不会逐条补喊 —— 补推本身已经是异常情况，不该把消息量放大到 N 倍。
 *
 * @param {{type:'win'|'lose'|'', count:number}} streak calcStreak 的结果
 * @param {string} [notifiedKey] 订阅项里存的上次播报键（lastStreakKey）
 * @param {string} [name] 玩家名，写进文案
 * @returns {{text:string, key:string}} text 为空表示这局不用额外播报；key 一律写回订阅项
 */
export function streakMilestone (streak, notifiedKey = '', name = '') {
  const type = streak?.type
  const count = toInt(streak?.count)

  if ((type !== 'win' && type !== 'lose') || count < STREAK_MIN) {
    return { text: '', key: '' }
  }

  const key = `${type}:${count}`
  if (key === String(notifiedKey || '')) return { text: '', key }

  return { text: streakText(type, count, name ? normalizeName(name) : '这位召唤师'), key }
}

/* ------------------------------------------------------------------ 拉取 */

/**
 * 拉取单个账号的最新战绩列表。
 * 形状照 rankStore.fetchOne：成功返回响应的 data，隐藏战绩返回 FETCH_HIDDEN，其它失败返回 null。
 *
 * 频控（-30107）不在这里处理：api.js 会按账号冷却并自动换号，只有全池都限流时才抛错，
 * 落到下面的 catch 直接跳过本轮——下一次轮询自然会重试。
 *
 * @param {string} campId 营地ID
 * @param {string} qq 属主QQ，必传——authStore 按属主取鉴权候选，传空会直接报「未找到登录态」
 */
export async function fetchLatest (campId, qq) {
  try {
    const res = await ApiService.getMoreBattleList(String(campId), String(qq), { option: 0, lastTime: 0 })
    const code = Number(res?.returnCode || 0)

    if (code === CODE_PROFILE_HIDDEN) return FETCH_HIDDEN

    if (code !== 0) {
      logger.debug(`[王者推送] ${campId} 返回异常码 ${code}: ${res?.returnMsg || ''}`)
      return null
    }

    // 隐藏战绩时 returnCode 是 0，靠 invisible 标记判断
    if (res?.data?.invisible) return FETCH_HIDDEN

    // 顺手归档，喂日报/周报。挂在这里而不是各调用方：轮询、#开启战绩推送 初始化游标、
    // 日报补页全都走 fetchLatest，一处就覆盖所有入口。
    // 玩家在线时轮询每 2 分钟拉一次第一页，这样数据是慢慢攒全的，日报周报读库就够，
    // 不用为了「本周」现翻十几页（第二页起每页只有 10 场，详见 battleArchive 文件头）
    if (res?.data?.list?.length) {
      try {
        archiveBattles(campId, res.data.list)
      } catch (error) {
        // 归档失败绝不能影响推送本身
        logger.debug(`[王者推送] ${campId} 归档失败: ${error.message}`)
      }
    }

    return res?.data || null
  } catch (error) {
    logger.debug(`[王者推送] 拉取 ${campId} 失败: ${error.message}`)
    return null
  }
}

/**
 * heroId → 英雄名 的映射。
 *
 * 战绩列表项只给 heroId 和 heroIcon，不给英雄名，得靠官网英雄总表翻译。
 * 官网 herolist.json 的 ename 就是营地这套 heroId（实测 519=敖隐、547=卢雅那、558=影 全对得上），
 * queryGameStats.js:254 也是这么用的。表不大但每次推送都拉一遍没必要，缓存 6 小时。
 * 拉失败返回空对象，文案会退化成「英雄519」，不影响推送本身。
 * @returns {Promise<Record<string, string>>}
 */
export async function getHeroNameMap () {
  const cached = cache.get(HERO_MAP_CACHE_KEY)
  if (cached) return cached

  try {
    const list = await ApiService.getHeroList()
    if (!Array.isArray(list) || !list.length) return {}

    const map = {}
    for (const hero of list) {
      if (hero?.ename == null) continue
      map[String(hero.ename)] = String(hero.cname || '')
    }

    cache.set(HERO_MAP_CACHE_KEY, map, HERO_MAP_TTL)
    return map
  } catch (error) {
    logger.debug(`[王者推送] 拉取英雄总表失败: ${error.message}`)
    return {}
  }
}

/**
 * 拉取账号的在线状态（上下线提醒用）。
 *
 * 走 /game/koh/profile，和战绩列表是两个不同的端点，所以开了上下线提醒的订阅
 * 每轮要多花一次请求。只有订阅里 online 为真时才该调这个。
 *
 * gameOnline 三态实测（2026-08-22 采样 20 个账号 × 多轮）：
 *   0 = 离线    1 = 在线（营地/游戏客户端开着，不在对局）    2 = 游戏中
 * 关键：**gameOnline=2 不等于在对局里**。同一账号出现过 gameOnline=2 而 isGaming=false
 * （在大厅、匹配中、翻战绩都算 2），真正在打的判据是战绩列表的 isGaming。
 * 所以上下线提醒（0 ↔ 非0）和开局提醒（isGaming）是两件独立的事，不会互相顶替。
 *
 * onlineTime / offlineTime 单独看都判不了状态（见文件头注释里 523924587 那个反例），
 * 而且 **offlineTime 在刚下线时不会立刻更新**（账号 1557825900 已经 gameOnline=0 时，
 * offlineTime 19:23 仍早于 onlineTime 20:16），所以在线时长不能靠这两个相减，
 * 要用推送自己记下的上线时刻（订阅项的 onlineSince）。
 * 只有在 gameOnline 非 0 时 onlineTime 是可信的「本次上线时刻」，可作 onlineSince 的初值。
 *
 * 还有第四种情况：**营地压根不给这个号的在线状态**，三个字段全 0（判据见 hasOnlineSignal）。
 * 营地里「在线状态」和「战绩」是两个独立的隐私开关，只关前者的号战绩照旧能读，
 * 所以不能因为在线状态是空的就顺带把战绩那一路也停掉。
 *
 * @returns {Promise<{gameOnline:number, onlineTime:number, offlineTime:number, roleName:string}|null|symbol>}
 */
export async function fetchOnlineState (campId, qq) {
  try {
    const res = await ApiService.getProfile(String(campId), String(qq))
    const code = Number(res?.returnCode || 0)

    if (code === CODE_PROFILE_HIDDEN) return FETCH_HIDDEN

    if (code !== 0) return null

    const data = res?.data || {}
    const roles = data.roleList || []
    // 主角色认 targetRoleId，取不到就退回第一个（多角色账号只跟主角色的状态）
    const role = roles.find(r => r.roleId === data.targetRoleId) || roles[0]
    if (!role) return null

    return {
      gameOnline: toInt(role.gameOnline),
      onlineTime: toInt(role.onlineTime),
      offlineTime: toInt(role.offlineTime),
      roleName: String(role.roleName || '')
    }
  } catch (error) {
    // 频控同 fetchLatest：api.js 按账号冷却并换号，全池限流才抛到这里，跳过本轮即可
    logger.debug(`[王者推送] 拉取 ${campId} 在线状态失败: ${error.message}`)
    return null
  }
}

/* ------------------------------------------------------------------ 纯计算 */

/**
 * 从最新一场往前数连胜/连败。
 * gameresult: 1=胜 2=负，其它值（逃跑/未结算）中断计数。
 * 服务端的 straightWin / straightLose 实测赢了一局后仍是 0，不能用，只能自己算。
 * @param {Array<object>} list 战绩列表，服务端按时间倒序，list[0] 最新
 * @returns {{ type: 'win'|'lose'|'', count: number }}
 */
export function calcStreak (list = []) {
  const first = list[0]
  if (!first || (first.gameresult !== 1 && first.gameresult !== 2)) {
    return { type: '', count: 0 }
  }

  const target = first.gameresult
  let count = 0
  for (const item of list) {
    if (item?.gameresult !== target) break
    count += 1
  }

  return { type: target === 1 ? 'win' : 'lose', count }
}

/**
 * 筛出「上次推送之后」的新场次，按时间从旧到新返回（方便顺着讲「先赢后输」）。
 *
 * 为什么不只看 list[0]：轮询间隔 2 分钟，一局王者最快 5 分钟，正常不会漏，
 * 但机器人重启、频控退避、cron 被调长都会让一轮跳过好几局，只推最新一场就丢了中间的。
 * 用时间戳而不是 gameSeq 做筛选条件，是因为 gameSeq 只能判「等不等」，判不了「谁更新」。
 *
 * @param {Array<object>} list 战绩列表（倒序）
 * @param {object} sub 订阅项，用 lastGameSeq / lastGameTime 做游标
 * @returns {Array<object>} 新场次，从旧到新
 */
export function pickNewBattles (list = [], sub = {}) {
  if (!Array.isArray(list) || !list.length) return []

  const lastSeq = String(sub.lastGameSeq || '')
  const lastTime = toInt(sub.lastGameTime)

  // 游标为空 = 刚订阅还没初始化，此时不该把历史战绩当新的推出来
  if (!lastSeq && !lastTime) return []

  // 最新一场就是上次推过的那场，没有新战绩，最常见的情况，直接短路
  if (lastSeq && String(list[0]?.gameSeq || '') === lastSeq) return []

  const fresh = list.filter(item => {
    if (String(item?.gameSeq || '') === lastSeq) return false
    return toInt(item?.dtEventTime) > lastTime
  })

  return fresh.reverse()
}

/**
 * 一场战绩的分数变化。巅峰赛给巅峰分，排位给段位星数，都拿不到就返回空。
 *
 * 巅峰分：列表项自带 oldMasterMatchScore / newMasterMatchScore。
 *   注意**不能只看字段有没有值**：排位赛场次也会带上当前巅峰分（实测「排位赛 三排」
 *   一局 old=new=1795），只是前后相等表示这局不影响巅峰分。所以要求 old != new 才当巅峰分用，
 *   相等就回落到段位星数——否则排位赛会推出「巅峰分 1795 → 1795 (0)」这种废话。
 * 段位星数：列表项自带 roleJobName + stars，但 stars 的语义随段位变化（见文件头注释），
 *   所以要和上一场比，且只在段位名相同时才算差值。
 *
 * 返回值带 `tone`，**调用方必须用它来选涨跌图标，不能用胜负代替**：娱乐局不影响段位、
 * 王者段输了还有保星，这两种情况都是「输了但一格没动」，拿胜负配图标会推出
 * 「📉 至圣王者 41星」——读起来像掉星，其实什么都没变（实测无限乱斗两连败推了两条这样的）。
 *
 * @param {object} item 当前场次
 * @param {object} [prev] 时间上更早的一场（list 里紧邻的下一项），用于比段位星数
 * @returns {{text:string, tone:'up'|'down'|'flat'}|null} 连当前段位都取不到时返回 null
 */
export function formatScoreChange (item, prev) {
  const oldScore = toInt(item?.oldMasterMatchScore)
  const newScore = toInt(item?.newMasterMatchScore)

  if ((oldScore > 0 || newScore > 0) && oldScore !== newScore) {
    const diff = newScore - oldScore
    const sign = diff > 0 ? '+' : ''
    return {
      text: `巅峰分 ${oldScore} → ${newScore} (${sign}${diff})`,
      tone: diff > 0 ? 'up' : 'down'
    }
  }

  const job = String(item?.roleJobName || '').trim()
  if (!job) return null

  const stars = toInt(item?.stars)
  // 比不出变化时的兜底：只报当前段位，不带方向
  const current = { text: `${job} ${stars}星`, tone: 'flat' }

  const prevJob = String(prev?.roleJobName || '').trim()
  if (!prevJob) return current

  const prevStars = toInt(prev?.stars)
  const jobNum = toInt(item?.roleJob)
  const prevJobNum = toInt(prev?.roleJob)

  // 一个营地号名下可能有多个游戏角色，而战绩列表里没有任何角色标识（详见 rankTrend.js
  // 文件头第 4 点），切了角色的两场混在一起硬减会报出「掉了 9 星」这种假结论。
  // 判据与段位趋势的断线口径共用一份 isRankJump
  if (isRankJump(
    { band: rankBand(prevJob), jobNum: prevJobNum },
    { band: rankBand(job), jobNum }
  )) return current

  // 段位名变了：stars 两边不同口径，减出来的差没意义，只报段位变化。
  // 方向按大段层级判（星耀 → 王者是升），认不出段位名就不带方向
  if (prevJob !== job) {
    const gap = rankBand(job) - rankBand(prevJob)
    return {
      text: `段位 ${prevJob} → ${job}（${stars}星）`,
      tone: gap > 0 ? 'up' : gap < 0 ? 'down' : 'flat'
    }
  }

  // 同名段下营地还有个小编号 roleJob：旧体系把王者按 5 星编成连续小段
  // （段内星 0~5 循环，跨小段时 stars 前后不可比），新体系（荣耀王者）恒为 16、
  // stars 直接是累计星数。编号变了说明跨了小段，按编号判升降，不算星数差
  if (jobNum && prevJobNum && jobNum !== prevJobNum) {
    if (jobNum > prevJobNum) {
      return { text: `${job} ${prevStars} → ${stars}星（升段）`, tone: 'up' }
    }
    // 赢了编号却降只可能是赛季切换/段位重置（实测 2026-07-26 26→16），不是掉段，
    // 前后星数不可比，只报当前
    if (item?.gameresult === 1) return current
    return { text: `${job} ${prevStars} → ${stars}星（掉段）`, tone: 'down' }
  }

  const diff = stars - prevStars
  if (diff > 0) {
    return { text: `${job} ${prevStars} → ${stars}星（上了${diff}星）`, tone: 'up' }
  }
  if (diff < 0) {
    // roleJob 缺失时的兜底：赢了星数却下降，只可能是旧体系的段内循环重置
    if (item?.gameresult === 1) {
      return { text: `${job} ${prevStars} → ${stars}星（升段）`, tone: 'up' }
    }
    return { text: `${job} ${prevStars} → ${stars}星（掉了${-diff}星）`, tone: 'down' }
  }

  // 差值为 0：王者段输了有保星机制，星数不动是真实结果，如实只报当前星数
  return current
}

/** 秒 → 「15分16秒」 */
export function formatDuration (seconds) {
  const total = toInt(seconds)
  if (total <= 0) return ''
  const min = Math.floor(total / 60)
  const sec = total % 60
  return min > 0 ? `${min}分${sec}秒` : `${sec}秒`
}

/**
 * 单场战绩的推送文案（不含 @ 和头像）。
 * 用到的字段全在列表项里，不需要再拉 battledetail。
 * @param {object} item 场次
 * @param {object} [prev] 更早的一场，用于比段位星数
 * @param {object} [heroMap] heroId -> 英雄名，列表项本身不带英雄名，只有 heroId 和 heroIcon
 * @param {object} [options]
 * @param {boolean} [options.brief=false] 精简模式：省略 KDA / 评分 / 时长 / 局评价。
 *   配详情图发送时用——那些信息图里都有，文字只留图上没有的巅峰分与段位变化。
 */
export function formatBattleText (item, prev, heroMap = {}, { brief = false } = {}) {
  const win = item?.gameresult === 1
  const heroName = heroMap[String(item?.heroId)] || `英雄${item?.heroId ?? '?'}`

  const lines = []

  if (brief) {
    lines.push(`${win ? '🏆 胜利' : '💧 失败'} · ${heroName}`)
  } else {
    const kda = `${toInt(item?.killcnt)}/${toInt(item?.deadcnt)}/${toInt(item?.assistcnt)}`
    const grade = item?.gradeGame ? ` · 评分 ${item.gradeGame}` : ''
    lines.push(`${win ? '🏆 胜利' : '💧 失败'} · ${heroName} · ${kda}${grade}`)
  }

  // 图标看 tone 不看胜负：娱乐局不动段位、王者段输了还有保星，
  // 这两种「输了但一格没动」拿胜负配图标会推出「📉 至圣王者 41星」这种假掉星
  const change = formatScoreChange(item, prev)
  if (change) {
    const icon = change.tone === 'up' ? '📈' : change.tone === 'down' ? '📉' : '⭐'
    lines.push(`${icon} ${change.text}`)
  }

  if (!brief) {
    const parts = []
    const duration = formatDuration(item?.usedTime)
    if (duration) parts.push(`⏱ ${duration}`)
    if (item?.desc) parts.push(item.desc)
    if (parts.length) lines.push(parts.join(' · '))
  }

  return lines.join('\n')
}

/**
 * 开局提醒文案。
 * gaming 实测字段：{ isGaming, dtEventTime(开局时间戳,全程恒定), heroId, heroIcon,
 *                    mapName, duration(已进行分钟), gameNum(该英雄场次), winRate, detailUrl, watch }
 * @param {object} gaming data.gaming
 * @param {object} [heroMap] heroId -> 英雄名
 * @param {string} [name] 玩家名。开局提醒不 @ 本人（是给群友看的），
 *   所以要把名字写进文案里，否则群里没人知道是谁开打了。
 */
export function formatGamingText (gaming, heroMap = {}, name = '') {
  const mode = String(gaming?.mapName || '').trim() || '对局'
  const heroName = heroMap[String(gaming?.heroId)] || (gaming?.heroId ? `英雄${gaming.heroId}` : '')
  const who = normalizeName(name)

  const lines = [`${name ? `${who} · ` : ''}进入了${mode}`]

  if (heroName) {
    const stat = []
    const gameNum = toInt(gaming?.gameNum)
    if (gameNum > 0) stat.push(`${gameNum} 场`)
    if (gaming?.winRate) stat.push(`胜率 ${gaming.winRate}`)
    lines.push(`🎮 ${heroName}${stat.length ? `（${stat.join(' · ')}）` : ''}`)
  }

  const duration = toInt(gaming?.duration)
  if (duration > 0) lines.push(`已进行 ${duration} 分钟`)

  return lines.join('\n')
}

/* ------------------------------------------------------- 开播提示（盯梢） */

/**
 * 能观战的模式 —— ⚠️ **判据本体在 `utils/watchMode.js`**（唯一一份），这里只做转出。
 *
 * 以前这里和 `server/lib/camp.js` 各写一份 `new Set([4, 14])`，靠注释提醒两边都改；
 * 漏改就会「列表说能看、盯梢说不能看」。现在服务端直接 import 同一份，
 * 改一处就够了 —— 别在这儿重新定义。
 */
export { isWatchableMode }

/**
 * 这一局已经打了多久（分钟）。算不出来返回 -1。
 *
 * `gaming.dtEventTime` 是**秒级字符串**（实测 1789641772），要 ×1000 才和 Date.now() 同量纲。
 * 服务端时间跟本地可能有偏差，负值 / 超过一天的都当「算不出来」——
 * 宁可不提示，也不能拿一个离谱的时长去判「满 3 分钟了」。
 *
 * @param {object} gaming data.gaming
 * @param {number} [now] 当前毫秒时间戳
 * @returns {number} 分钟数，-1 = 算不出来
 */
export function gamingMinutes (gaming, now = Date.now()) {
  const start = toInt(gaming?.dtEventTime) * 1000
  if (!start) return -1
  const ms = now - start
  if (ms < 0 || ms > 24 * 3600 * 1000) return -1
  return Math.floor(ms / 60000)
}

/**
 * 这条盯梢该不该发开播提示、还是该放弃。
 *
 * 盯梢的来龙去脉：订阅者上线 → 我们开始盯他进对局 → 进对局满 N 分钟且**能看**时
 * 往群里发一条「要不要开播」。三种结局：
 *
 *   `hint`   → 发提示（模式能看 + 已满 N 分钟）
 *   `wait`   → 还没进对局 / 时长还不够，继续盯
 *   `drop`   → 放弃（模式不支持、查不到战绩）
 *
 * ⚠️⚠️ **「隐私」和「还没进对局」在数据上分不出来，别以为能区分**：
 *    实测关战绩隐私的号（`choiceitem` 里看着在打）查 `morebattlelist` 拿到的是
 *    `rc=0` + `isGaming=false` + `gaming=null` —— 和「刚上线还没开打」**一模一样**。
 *    所以这里只能返回 `wait`，靠**盯梢超时**兜底（见 HINT_WATCH_MAX_MS）：
 *    隐私的号会一直 wait 到超时，白打若干次请求，但不会误报「能看」。
 *    宁可白等，也不能给一个点了开不了的提示。
 *
 * @param {object} data `fetchLatest` 的返回（含 isGaming / gaming）
 * @param {number} afterMin 满几分钟才提示
 * @returns {{action:'hint'|'wait'|'drop', minutes:number, reason:string}}
 */
export function decideHint (data, afterMin = 3) {
  // ⚠️⚠️ **「明确藏了战绩」和「接口失败」必须分开**（踩过）：
  //    · `data === FETCH_HIDDEN` → 对方关了战绩隐私，**这一局确定看不了** → 放弃；
  //    · `data === null` → 接口偶发失败（网络抖动 / 频控换号 / 营地上游超时）→
  //      **不是「看不了」**，该下轮重试。早先两者都当 drop，结果一次抖动就把这局
  //      标记成「问过了」，整局再也不问（实测踩过）。
  if (data === FETCH_HIDDEN) {
    return { action: 'drop', minutes: -1, reason: '对方关了战绩' }
  }
  if (!data) {
    return { action: 'wait', minutes: -1, reason: '接口失败，下轮重试' }
  }
  const gaming = data.gaming
  if (!gaming || !data.isGaming) {
    // 没进对局 —— 也可能是有隐私（两者数据同形，见上面的注释），靠超时兜底
    return { action: 'wait', minutes: -1, reason: '还没进对局' }
  }
  if (!isWatchableMode(gaming.gameType)) {
    return { action: 'drop', minutes: -1, reason: `模式不支持（${gaming.mapName || '未知'}）` }
  }
  const minutes = gamingMinutes(gaming)
  if (minutes < 0) return { action: 'wait', minutes: -1, reason: '开局时刻算不出来' }
  if (minutes < afterMin) return { action: 'wait', minutes, reason: `才 ${minutes} 分钟` }
  return { action: 'hint', minutes, reason: '' }
}

/* ------------------------------------------------------------------ 上下线 */

/** gameOnline 三态的展示名。实测只有这三个值，其它值按「在线」处理 */
export const ONLINE_LABEL = { 0: '离线', 1: '在线', 2: '游戏中' }

/**
 * 判断上下线是否发生了值得提醒的变化。
 *
 * 只认「离线 <-> 非离线」的跨越，不认 1<->2 的抖动：
 * 玩家在营地和游戏客户端之间来回切、打完一局退回大厅，都会让 gameOnline 在 1 和 2 之间跳，
 * 每次都提醒就是刷屏。真正想知道的是「他上线了」和「他收工了」。
 *
 * @param {number} current 本轮的 gameOnline
 * @param {number|string|undefined} previous 上一轮记录的 gameOnline，首次订阅时为空
 * @returns {'online'|'offline'|''} 空串表示不用提醒
 */
export function diffOnlineState (current, previous) {
  // 首次记录（订阅后第一轮）没有基准，只登记不提醒，否则一开启就收到一条
  if (previous === undefined || previous === null || previous === '') return ''

  const now = toInt(current)
  const before = toInt(previous)

  if (before === now) return ''
  if (before === 0 && now !== 0) return 'online'
  if (before !== 0 && now === 0) return 'offline'
  // 1 <-> 2 的抖动，不提醒
  return ''
}

/** 秒 -> 「2小时15分」/「45分钟」，用于在线时长 */
export function formatOnlineDuration (seconds) {
  const total = toInt(seconds)
  if (total <= 0) return ''
  const hours = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  if (hours > 0) return mins > 0 ? `${hours}小时${mins}分` : `${hours}小时`
  return mins > 0 ? `${mins}分钟` : '不到1分钟'
}

/**
 * 一次连续在线最长按多久算。超过就认为营地给的 onlineTime 是陈旧值，不是真的挂了这么久。
 * 实测账号 1630945798 明明是离线状态，onlineTime 却是四个月前的时间戳，
 * 直接拿来算时长会推出「本次在线 1427 小时」这种离谱文案。
 */
const MAX_SESSION_SECONDS = 24 * 3600

/**
 * 敲定「本次上线时刻」。
 *
 * 优先信我们自己观察到的时刻（nowSec）：上线提醒是在 0 -> 非0 那一轮检测到的，
 * 此刻的时间就是上线时刻，误差最多一个轮询间隔，比营地的 onlineTime 可靠。
 * 只有在订阅时对方已经在线、我们没观察到上线瞬间的情况下，才回退到 onlineTime，
 * 且要求它落在最近 MAX_SESSION_SECONDS 之内，否则视为陈旧值改用 nowSec。
 *
 * @param {number|string} onlineTime 营地返回的 onlineTime
 * @param {number} nowSec 当前时间戳（秒）
 * @param {boolean} [observed=false] 是否是我们亲眼看到的上线跨越
 * @returns {number} 上线时刻（秒）
 */
export function resolveOnlineSince (onlineTime, nowSec, observed = false) {
  const now = toInt(nowSec)
  if (observed) return now

  const started = toInt(onlineTime)
  if (started <= 0 || started > now) return now
  if (now - started > MAX_SESSION_SECONDS) return now

  return started
}

/**
 * 统计一段时间内打了什么，用于下线时的收工总结。
 * 用的还是同一份战绩列表，不额外发请求。
 *
 * @param {Array<object>} list 战绩列表（倒序）
 * @param {number|string} sinceTime 起始时间戳（秒），一般是本次上线时刻
 * @returns {{count:number, win:number, lose:number, scoreFrom:number, scoreTo:number,
 *            jobFrom:string, starFrom:number, jobNumFrom:number,
 *            jobTo:string, jobNumTo:number, starTo:number}}
 *   jobFrom/starFrom 与 jobTo/starTo 是本次在线前后的段位与星数，全娱乐模式（无排位场次）时 jobTo 为空
 */
export function summarizeSession (list = [], sinceTime = 0) {
  const since = toInt(sinceTime)
  const played = since > 0
    ? (Array.isArray(list) ? list : []).filter(item => toInt(item?.dtEventTime) >= since)
    : []

  const win = played.filter(item => item?.gameresult === 1).length
  const lose = played.filter(item => item?.gameresult === 2).length

  // 列表倒序：最后一项最早、第一项最新，巅峰分取这段区间的首尾
  const withScore = played.filter(item => toInt(item?.newMasterMatchScore) > 0)
  const earliest = withScore[withScore.length - 1]
  const newest = withScore[0]

  // 段位星数：取本次期间最早/最新一场带段位的场次（排位局才有 roleJobName）。
  // 起点要用「最早一场之前那局」的快照才是本次开始前的星数；取不到（翻页翻没了）
  // 就退回最早一场打完后的星数，差值会少算第一局的变动，但比什么都不报强。
  // jobNumFrom/To 是 roleJob 小编号：两边相等时 starFrom→starTo 的差才可信
  // （旧体系段内星 0~5 循环，跨小段直接比星数会算出荒谬的差值）
  const ranked = played.filter(item => String(item?.roleJobName || '').trim())
  const firstRanked = ranked[ranked.length - 1]
  const lastRanked = ranked[0]
  let jobFrom = ''
  let starFrom = 0
  let jobNumFrom = 0
  if (firstRanked) {
    const idx = (Array.isArray(list) ? list : []).findIndex(x => x === firstRanked)
    const prev = idx >= 0 ? list[idx + 1] : undefined
    // prev 可能是娱乐模式场次（无段位），那就没有可用的起点快照。
    // 判据只能是「有没有段位名」，不能拿 stars 真值判：**段内 0 星是真实值**
    // （实测 30 场里出现 2 次，1 星再输一局就是 0 星），用 `||` 兜会把它当成取不到，
    // 起点被顶成第一局打完后的星数，整段差值少算一颗
    const snapshot = String(prev?.roleJobName || '').trim() ? prev : firstRanked
    jobFrom = String(snapshot.roleJobName).trim()
    starFrom = toInt(snapshot.stars)
    // 回退到 firstRanked 时编号也要跟着取，漏了会让 jobNumFrom=0，
    // 下游「两边编号都有值才比编号」的判断短路，跨小段时直接相减算出 -4
    jobNumFrom = toInt(snapshot.roleJob)
  }

  return {
    count: played.length,
    win,
    lose,
    scoreFrom: toInt(earliest?.oldMasterMatchScore),
    scoreTo: toInt(newest?.newMasterMatchScore),
    jobFrom,
    starFrom,
    jobNumFrom,
    jobTo: lastRanked ? String(lastRanked.roleJobName).trim() : '',
    jobNumTo: toInt(lastRanked?.roleJob),
    starTo: toInt(lastRanked?.stars)
  }
}

/**
 * 段位星数变化的一行文案。
 *
 * 收工总结（formatOnlineText）和日报/周报（reportStore）共用这一套判据，别各写一份——
 * 这里面有三个实测出来的坑：段位名变了两边星数口径不同、同名段下 roleJob 小编号变了
 * 说明跨了小段（起止星数不可比）、编号下降可能是赛季重置而不是掉段。详见文件头第 3 点。
 *
 * @param {object} session summarizeSession 的返回（或同形状的对象）
 * @returns {{text:string, icon:string, tone:'up'|'down'|'flat'}|null} 没有可报的变化时返回 null
 */
export function formatStarChange (session = {}) {
  const { jobFrom, jobTo, starFrom, starTo, jobNumFrom, jobNumTo } = session
  // 判据用 jobFrom/jobTo 而不是星数大于 0：**0 星是真实值**，
  // 拿 starFrom > 0 当门槛会把「连输到 0 星收工」整行吞掉——那正是最该报的一次
  if (!jobTo || !jobFrom) return null

  if (jobFrom !== jobTo) {
    return { text: `段位 ${jobFrom} → ${jobTo}（${starTo}星）`, icon: '📈', tone: 'up' }
  }

  // 同名段但 roleJob 小编号变了（旧体系 5 星一小段）：起止星数不可比，按编号报升降段。
  // 编号下降不下结论——可能是掉段，也可能是期间跨了赛季重置（实测 26→16）
  if (jobNumFrom && jobNumTo && jobNumFrom !== jobNumTo) {
    return jobNumTo > jobNumFrom
      ? { text: `${jobTo} ${starFrom} → ${starTo}星（升段）`, icon: '📈', tone: 'up' }
      : { text: `${jobTo} ${starFrom} → ${starTo}星`, icon: '', tone: 'flat' }
  }

  if (starTo !== starFrom) {
    const diff = starTo - starFrom
    return {
      text: `${jobTo} ${starFrom} → ${starTo}星（${diff > 0 ? `上了${diff}` : `掉了${-diff}`}星）`,
      icon: diff > 0 ? '📈' : '📉',
      tone: diff > 0 ? 'up' : 'down'
    }
  }

  // 净变化为 0（赢几局又输几局、或全程保星）也要给个说法：一行都不显示会和
  // 「取不到数据」长得一模一样，而这条推送的意义就是「今晚上了还是掉了」
  return { text: `${jobTo} ${starTo}星（星数没变）`, icon: '⭐', tone: 'flat' }
}

/**
 * 巅峰分变化的一行文案。判据是 from != to：
 * 排位赛场次也会带上当前巅峰分，只是前后相等（详见文件头第 2 点）。
 * @returns {{text:string, icon:string, tone:'up'|'down'}|null}
 */
export function formatScoreDelta (session = {}) {
  const from = toInt(session.scoreFrom)
  const to = toInt(session.scoreTo)
  if (from <= 0 || to <= 0 || from === to) return null

  const diff = to - from
  return {
    text: `巅峰分 ${from} → ${to} (${diff > 0 ? '+' : ''}${diff})`,
    icon: diff > 0 ? '📈' : '📉',
    tone: diff > 0 ? 'up' : 'down'
  }
}

/**
 * 上线 / 下线提醒文案。
 *
 * 这两条都不 @ 本人（是给群友看的），所以名字必须写进文案，否则群里看不出是谁。
 *
 * 时长不在这里算：营地的 offlineTime 在刚下线时**不会立刻更新**
 * （实测账号 1557825900 已经 gameOnline=0，offlineTime 19:23 仍早于 onlineTime 20:16，
 * 相减是负数），所以在线时长必须由调用方拿「自己记下的上线时刻」算好传进来。
 *
 * @param {'online'|'offline'} kind 变化类型
 * @param {object} [opts]
 * @param {string} [opts.name] 玩家名（营地昵称）
 * @param {number} [opts.gameOnline] 当前状态值，用于区分「上线」和「上线并已进游戏」
 * @param {number} [opts.durationSec] 本次在线秒数，0 表示算不出来、不显示
 * @param {object} [opts.session] summarizeSession 的返回，只在下线时用
 */
export function formatOnlineText (kind, { name = '', gameOnline = 0, durationSec = 0, session = null } = {}) {
  const who = name ? `${normalizeName(name)} · ` : ''

  if (kind === 'online') {
    return `🟢 ${who}王者已上线${toInt(gameOnline) === 2 ? ' · 已进游戏' : ''}`
  }

  const lines = [`⚫ ${who}王者已下线`]

  const duration = formatOnlineDuration(durationSec)
  if (duration) lines[0] += ` · 本次在线 ${duration}`

  if (session?.count > 0) {
    lines.push(`🎮 打了 ${session.count} 局 · ${session.win}胜${session.lose}负`)

    // 段位星数与巅峰分变化，判据见 formatStarChange / formatScoreDelta（日报周报共用同一套）
    const star = formatStarChange(session)
    if (star) lines.push(`${star.icon} ${star.text}`.trim())

    const score = formatScoreDelta(session)
    if (score) lines.push(`${score.icon} ${score.text}`)
  } else if (duration) {
    lines.push('🎮 本次没有排位/巅峰战绩')
  }

  return lines.join('\n')
}

/* ------------------------------------------------------------------ 轮询节流 */

/**
 * 这份 profile 到底给了在线信号没有。
 *
 * 实测（2026-08-27，营地 499601913 / 角色 130084415「槿笙a」）：营地对某些账号的 roleList
 * **三个字段全给 0**——gameOnline=0、onlineTime=0、offlineTime=0，该号名下 3 个角色都一样；
 * 而同一批采样的其他账号哪怕此刻离线也带着上次的时间戳（主人的号 onlineTime 19:29 上线、
 * offlineTime 20:13 下线，字段都在）。该号在营地里打开「在线状态」的授权后，同一个接口
 * 立刻给出 gameOnline=1 / onlineTime 20:26 / offlineTime 20:25，确认就是这个开关。
 *
 * 关键：营地的「在线状态」和「战绩」是**两个独立的隐私开关**，只关在线状态的号
 * 战绩列表照旧 returnCode=0、invisible=false、30 场全给。所以「三个全 0」是
 * 「营地没给这个号的在线状态」，不是「确定离线」，两者必须分开：当成离线的话
 * needBattleList 会一轮都不拉战绩列表，战绩推送和开局提醒跟着一起静默失效
 * （实测后果：该号开了两路推送，一整天打了十几局，一条都没推）。
 *
 * @param {object|null} state fetchOnlineState 的返回（已排除 FETCH_HIDDEN）
 * @returns {boolean} false = 这一轮没有可用的在线信号，按「没拉到 profile」处理
 */
export function hasOnlineSignal (state) {
  if (!state) return false
  return toInt(state.gameOnline) !== 0 || toInt(state.onlineTime) > 0 || toInt(state.offlineTime) > 0
}

/**
 * 这一轮要不要花一次战绩列表请求（morebattlelist，返回体比 profile 大一个量级）。
 *
 * 玩家离线时既不会开局也不会出新战绩，那一次请求是纯浪费，跳过它不影响任何提醒：
 * - 只开上下线提醒：战绩列表只在「刚下线」那一轮有用（喂 summarizeSession 做收工总结），
 *   在线期间拉回来的数据原样丢掉
 * - 两个都开：在线要推战绩/开局，刚下线要收尾最后那几局，持续离线就跳
 * - 只开战绩推送：没有 profile 信号，战绩列表是唯一信息源，只能每轮拉
 *
 * profile 这轮拉失败（state 为 null）时一律按「要拉」处理——宁可多一次请求，
 * 也不能因为拿不到在线状态就把战绩推送停掉。**营地没给在线信号的号同理**
 * （三个字段全 0，判据见 hasOnlineSignal）：那种号的 gameOnline 恒为 0，
 * 按「确定离线」处理会让战绩推送和开局提醒一起永久失效。
 *
 * @param {object} opts
 * @param {boolean} opts.battleOn 订阅开了战绩推送
 * @param {boolean} opts.onlineOn 调用方传的是**采集开关**（这个订阅这一轮采不采在线状态），不是播报开关
 * @param {object|null} opts.state 本轮的 profile 结果
 * @param {object} opts.sub 订阅项，读 lastOnlineState 判「是不是刚下线那一轮」
 * @returns {boolean}
 */
export function needBattleList ({ battleOn, onlineOn, state, sub = {} } = {}) {
  // 没有 profile 信号可用：只能靠战绩列表本身
  if (!onlineOn || !hasOnlineSignal(state)) return battleOn

  const online = toInt(state.gameOnline) !== 0
  // 「游戏中」单独拎出来：只采集不播报的号靠它决定要不要补拉一次战绩列表。
  // 不能把 online 直接改成「含 2」——justWentOffline 复用了 online，一改「刚下线」就失灵
  const playing = toInt(state.gameOnline) === 2
  const wasOnline = sub.lastOnlineState !== undefined &&
    sub.lastOnlineState !== null &&
    String(sub.lastOnlineState) !== '' &&
    String(sub.lastOnlineState) !== '0'
  const justWentOffline = !online && wasOnline

  // 只采集不播报的号在「游戏中」时也要拉一次：英雄只在战绩列表里，
  // 不拉的话 #谁在打游戏 会出现「正在对局却没有英雄」的空行
  return battleOn ? (online || justWentOffline) : (justWentOffline || playing)
}

/**
 * 这个订阅现在算不算「活跃」，决定下一轮是保持高频还是开始退避。
 *
 * 判据按信号可靠性排序：
 * 1. profile 给了在线信号 → `gameOnline !== 0` 最可靠（三态语义见 fetchOnlineState 的注释）
 * 2. 没有 profile 信号（只开战绩推送、profile 这轮拉失败、或营地不给这个号的在线状态）
 *    → 退回战绩列表本身：正在打（isGaming）算活跃，最新一场在 RECENT_BATTLE_WINDOW 内也算
 * 3. 两个都没拿到 → **算不活跃**。接口一直失败就该退避，别按高频硬刚，
 *    正好和 api.js 的频控冷却一个方向
 *
 * @param {object|null} state fetchOnlineState 的返回（已排除 FETCH_HIDDEN）
 * @param {object|null} data fetchLatest 的返回（已排除 FETCH_HIDDEN）
 * @param {number} nowSec 当前时间戳（秒）
 * @returns {boolean}
 */
export function isSubActive (state, data, nowSec) {
  // 三个字段全 0 的号不能当「确定离线」，否则它会一路退避到封顶，越查越少
  if (hasOnlineSignal(state)) return toInt(state.gameOnline) !== 0

  if (!data) return false
  if (data.isGaming) return true

  const latest = toInt((data.list || [])[0]?.dtEventTime)
  if (latest <= 0) return false

  return toInt(nowSec) - latest <= RECENT_BATTLE_WINDOW
}

/**
 * 算这个订阅接下来要跳过几轮，顺带维护「从什么时候开始不活跃」。
 *
 * 返回的两个字段都要写回订阅项：`skipTicks` 每轮递减，减到 0 才真正去查；
 * `idleSince` 是退避档位的计时起点，活跃时清空，这样玩家一上线就立刻回到高频。
 *
 * @param {object} sub 订阅项，读 idleSince
 * @param {object} opts
 * @param {boolean} opts.active isSubActive 的结果
 * @param {number} opts.nowMs 当前时间戳（毫秒）
 * @param {number} [opts.maxMultiplier] 封顶倍数，1 = 关闭自适应（全程按 cron）
 * @returns {{skipTicks:number, idleSince:string}}
 */
export function resolveNextCheck (sub, { active, nowMs, maxMultiplier = DEFAULT_IDLE_BACKOFF_MAX } = {}) {
  const now = toInt(nowMs)
  // 封顶至少是 1（每轮都查），配置里填 0 或负数不该让轮询彻底停摆
  const cap = Math.max(1, toInt(maxMultiplier) || DEFAULT_IDLE_BACKOFF_MAX)

  if (active) return { skipTicks: 0, idleSince: '' }

  // 第一次判定为不活跃：从现在开始计时，本轮之后先按最短那档退避
  const idleSince = toInt(sub?.idleSince) > 0 ? toInt(sub.idleSince) : now
  const idleFor = Math.max(0, now - idleSince)

  const step = IDLE_BACKOFF_STEPS.find(item => idleFor >= item.afterMs)
  const multiplier = Math.min(step?.multiplier ?? cap, cap)

  // multiplier 倍间隔 = 查一轮 + 跳过 (multiplier - 1) 轮
  return { skipTicks: Math.max(0, multiplier - 1), idleSince: String(idleSince) }
}

/* ------------------------------------------------------------ 观测快照 */

/**
 * 本轮观测快照，写进订阅项供 #谁在打游戏 直接读。
 *
 * 两个数据源都可能缺：只开战绩推送时没有 state，退避轮或 needBattleList 判否时没有 data。
 * 缺的字段就不写（保留上一轮的值），只有真观测到才更新 lastSeenAt —— 否则「数据新鲜度」
 * 会被一个什么都没拿到的轮次刷新成当前时间，指令那头就看不出数据其实是旧的了。
 *
 * @param {object|null} state fetchOnlineState 的返回
 * @param {object|null} data fetchLatest 的返回
 * @param {number} nowMs 观测时刻
 * @param {object} prev 上一轮的订阅项，用来判「刚打完」和「是不是还在打同一局」
 */
function observeSnapshot (state, data, nowMs, prev = {}) {
  if (!state && !data) return {}

  const patch = { lastSeenAt: String(nowMs) }

  if (state) patch.lastOnlineState = String(state.gameOnline)

  // 游戏昵称（营地 roleName）不在这里写，由调用方单独并进来 —— 原因见 collectSnapshot
  // 里 roleNameFromState 的声明：state 可能因为「营地问不出在线状态」被判成无效整个丢弃，
  // 而昵称是同一份响应里另一个独立字段，不该跟着一起没。

  // 在对局中：**只信战绩列表的 isGaming**。
  //
  // 早先用 `state.gameOnline===2` 兜底（那轮没拉战绩列表时），后果是
  // 「正在对局」被标出来、英雄却永远为空 —— 因为英雄只在 data.gaming.heroId 里，
  // 而 gameOnline===2 只代表「客户端开着」（大厅、匹配中、翻战绩都算 2，见
  // pushStore.fetchOnlineState 的三态注释）。两路判据必须同源，否则图上出现空行。
  // 只采集的号在「游戏中」时也会补拉一次战绩列表（见 needBattleList），英雄才有来源。
  const gaming = data ? Boolean(data.isGaming) : false
  const prevGaming = String(prev?.lastGaming || '') === '1'

  patch.lastGaming = gaming ? '1' : ''
  patch.lastGamingHero = gaming ? String(data?.gaming?.heroId || '') : ''
  // 营地给了 isGaming 却没给 heroId：没见过的组合，留一条痕迹方便回查，但不影响出图
  if (gaming && !data?.gaming?.heroId) {
    logger.debug(`[王者推送] ${prev.campId || ''} isGaming=true 但没给 heroId，本轮英雄留空`)
  }

  // 「刚打完」：#谁在打游戏 要显示「X 分钟前刚结束」。
  // 只在 1 -> 0 的那一轮记时刻，之后每轮不再更新，相对时间才会往前走。
  // 反过来 0 -> 1 时清掉，否则上一局的结束时刻会一直挂着。
  //
  // 判 1 -> 0 必须要求**这一轮真的拉到了战绩列表**（data 非空）：没拉到 data 时
  // gaming 恒为 false（上面已收窄），不设防的话一次请求失败/频控就会被当成
  // 「刚打完」，凭空冒出一条「刚刚结束」。存量里那些 lastGaming='1' 的老快照
  // 也会在第一次读到时误入「刚打完」组，这条守卫把过渡期这一下挡掉。
  if (data && prevGaming && !gaming) patch.lastGameEndAt = String(nowMs)
  else if (!prevGaming && gaming) patch.lastGameEndAt = ''
  else if (gaming) patch.lastGameEndAt = ''

  // 同一局的开始时刻：dtEventTime 一局之内恒定，是「一局」的唯一标识。
  // 只在开局那一轮（或换了局的轮次）写，避免退避轮拿旧时间戳反复刷新。
  const start = gaming ? String(data?.gaming?.dtEventTime || '') : ''
  if (startingNewGame(start, prev)) {
    patch.lastGamingStart = start
    // 换局就把「已经打了多久」的起点也一起换掉，否则会显示成上一局的时长
    patch.lastGameSeq = String(data?.list?.[0]?.gameSeq || '')
  }

  // 段位顺手记一份：#谁在打游戏 要显示段位徽章，而它自己不发请求。
  // 战绩列表第一场带 roleJobName/stars；只有 profile 时没有这两个字段，保留旧值。
  if (data) {
    const latest = (data.list || [])[0] || {}
    if (latest.roleJobName) patch.roleJobName = String(latest.roleJobName)
    // stars 是「这局之后的星数」，0 是真实值（1 星再输一局），不能用 || 兜底
    if (latest.stars !== undefined && latest.stars !== null && latest.stars !== '') {
      patch.stars = String(latest.stars)
    }
  }

  return patch
}

/**
 * 这一轮是不是「开了一局新的」。
 *
 * `dtEventTime` 一局之内恒定，所以它变了就是新的一局；从没记过（历史订阅没这个字段）
 * 也算新的一局，好让第一轮就把起点写上。
 *
 * @param {string} start 本轮拿到的一局开始时刻（不在对局时是空串）
 * @param {object} prev 上一轮的订阅项
 * @returns {boolean}
 */
function startingNewGame (start, prev) {
  if (!start) return false
  // prev.lastGamingStart 可能是数字（早期写法）或字符串，统一成字符串比
  return String(prev?.lastGamingStart ?? '') !== start
}

/**
 * 采一次在线状态快照，返回能直接 mergeSubState 进订阅项的字段。
 *
 * **推送轮询和 `#谁在打游戏` 的现刷共用这一份**：图上的「正在对局」和英雄都来自
 * 这些字段，两边各写一套迟早漂移（这正是「对局只认 isGaming」那条规矩的由来）。
 *
 * 只采不播：上下线播报、战绩推送、退避计数都由调用方处理。state / data 一并返回，
 * 调用方要播报时还得用它们。
 *
 * 请求数是自适应的一次或两次：profile（返回体最小）拿在线状态，只有
 * needBattleList 判为「值得拉」时才多打一次战绩列表（详见那个函数）。
 *
 * @param {string|number} qq 属主 QQ（鉴权候选按它取）
 * @param {string} campId 营地 ID
 * @param {object} sub 订阅项
 * @param {number} [nowMs] 观测时刻
 * @param {object} [opts]
 * @param {boolean} [opts.snapshot] 强制采一次在线状态快照，即使这条订阅没开上下线提醒。
 *   `#谁在打游戏` 的现刷路径要传它 —— 那条路是「不管你有没有开推送，只要在本群名单里
 *   就采一份」，与「订阅项开了什么」无关
 * @returns {Promise<{state: object|null, data: object|null, patch: object}>}
 *   state / data 为 null 表示这一轮没拿到；两个都空时 patch 也是空的
 */
export async function collectSnapshot (qq, campId, sub, nowMs = Date.now(), { snapshot = false } = {}) {
  const battleOn = sub?.battle !== false
  const onlineOn = sub?.online === true
  // 要不要采在线状态快照。两个来源：
  //   ① 开了上下线提醒（online）—— 它本来就要拉 profile，顺手记一份不额外发请求
  //   ② 调用方显式要求（`#谁在打游戏` 的现刷，见 opts.snapshot）
  const snapshotOn = onlineOn || snapshot === true

  let state = null
  let onlineSignalMissing = false
  // 本轮 profile 拿到的游戏昵称，独立于 state 存活：营地可能不给在线状态，
  // 但昵称照样给（见下面的分支），所以不能挂在 state 上一起被丢弃
  let roleNameFromState = ''

  if (snapshotOn) {
    state = await fetchOnlineState(campId, qq)
    if (state === FETCH_HIDDEN) state = null
    // 营地只关了「在线状态」授权的号，三个字段全给 0（判据见 hasOnlineSignal）。
    // 这不是离线而是「没告诉你」，当成没拿到，调用方就不会拿它报上下线、
    // observeSnapshot 也不会把 lastOnlineState 记成 0；战绩那一路照旧走
    //（营地的「在线状态」和「战绩」是两个独立的隐私开关）。
    //
    // 注意 roleName 要**先捞出来**再置 null：同一次 profile 返回里，在线状态和昵称是
    // 两个独立的字段，营地关掉前者不代表不给后者（实测这几个号都拿得到昵称）。
    // 早先直接把 state 整个置 null，昵称就跟着被扔了，出图上全是空名字。
    if (state && !hasOnlineSignal(state)) {
      logger.debug(`[王者推送] ${qq} 营地未返回在线状态（三字段全 0），本轮只按战绩列表处理`)
      roleNameFromState = state.roleName ? String(state.roleName) : ''
      state = null
      onlineSignalMissing = true
    } else if (state?.roleName) {
      roleNameFromState = String(state.roleName)
    }
  }

  // 战绩列表这一轮拉不拉，判据见 needBattleList
  // 注意传的是 battleOn 而不是 snapshotOn：只采集时不拉战绩列表，
  // profile 里的 gameOnline 已经够填快照了，省下的请求量正好抵掉扩量的开销
  let data = null
  if (needBattleList({ battleOn, onlineOn: snapshotOn, state, sub })) {
    // profile 刚打过，两个端点的请求别贴在一起
    if (snapshotOn) await sleep(REQUEST_INTERVAL)
    data = await fetchLatest(campId, qq)
    if (data === FETCH_HIDDEN) data = null
  }

  const patch = {
    ...observeSnapshot(state, data, nowMs, sub),
    // 游戏昵称单独并进来，理由见 roleNameFromState 的声明：它不从 state 走，
    // 因为 state 可能被判成「没在线信号」而整个丢掉
    ...(roleNameFromState ? { roleName: roleNameFromState } : {}),
    // 营地这轮没给在线状态：把可能留着的旧值清成空串，让 #谁在打游戏 归到
    // 「还没采集到状态」而不是谎报离线（空串和真的 '0' 语义不同）
    ...(onlineSignalMissing ? { lastOnlineState: '' } : {})
  }

  return { state, data, patch }
}
