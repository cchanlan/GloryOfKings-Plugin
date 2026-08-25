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
import path from 'path'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'
import ApiService from './api.js'
import cache from './cache.js'
import { archiveBattles } from './battleArchive.js'
// 营地昵称里常有私有区图标和不可见字符，直接拼进文案会显示成豆腐块或整段空白，
// 清洗规则和排行榜是同一套，复用 rankStore 的实现。
// 再导出一次：apps/gameRecordPush.js 拼战绩文案时也要洗名字，
// 让它只依赖 pushStore 这一个数据层，不用再单独引 rankStore
import { normalizeName } from './rankStore.js'
export { normalizeName }
import { PluginData } from '#components'

const PUSH_FILE = path.join(PluginData, 'GameRecordPush.yaml')

/**
 * 每个订阅之间的间隔。rankStore 用 600ms 拉 profile 能稳定跑完 20+ 账号，
 * morebattlelist 返回体比 profile 大一个量级，这里保守一档取 800ms。
 */
export const REQUEST_INTERVAL = 800

/** 命中频控时的退避重试次数与基础等待，沿用 rankStore 的经验值 */
const RATE_LIMIT_RETRY = 2
const RATE_LIMIT_BACKOFF = 3000

/** 营地频控错误码 */
const CODE_RATE_LIMITED = -30107
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

/* ------------------------------------------------------------------ 订阅存取 */

/**
 * 读取订阅表。文件缺失或内容损坏时返回空表，不抛错——
 * 这个文件由 index.js 启动时创建成 { pushList: {} }，但用户手动编辑坏了也不该让定时任务挂掉。
 * @returns {Record<string, object>} qq -> 订阅项
 */
export function loadPushList () {
  try {
    const data = readYamlFile(PUSH_FILE)
    const list = data?.pushList
    return list && typeof list === 'object' ? list : {}
  } catch {
    return {}
  }
}

/** 整表写回。只在指令场景用（开启/关闭订阅），轮询里一律走 mergeSubState */
export function savePushList (pushList) {
  writeYamlFile(PUSH_FILE, { pushList: pushList || {} })
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
 * @returns {boolean} 是否写入成功
 */
export function mergeSubState (qq, patch) {
  const key = String(qq)
  const list = loadPushList()
  if (!list[key]) return false

  list[key] = { ...list[key], ...patch }
  savePushList(list)
  return true
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

/* ------------------------------------------------------------------ 拉取 */

/**
 * 拉取单个账号的最新战绩列表。
 * 形状照 rankStore.fetchOne：成功返回响应的 data，隐藏战绩返回 FETCH_HIDDEN，其它失败返回 null。
 * @param {string} campId 营地ID
 * @param {string} qq 属主QQ，必传——authStore 按属主取鉴权候选，传空会直接报「未找到登录态」
 */
export async function fetchLatest (campId, qq) {
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRY; attempt += 1) {
    try {
      const res = await ApiService.getMoreBattleList(String(campId), String(qq), { option: 0, lastTime: 0 })
      const code = Number(res?.returnCode || 0)

      if (code === CODE_PROFILE_HIDDEN) return FETCH_HIDDEN

      // 频控：退避后重试，等待时间随次数递增
      if (code === CODE_RATE_LIMITED) {
        if (attempt < RATE_LIMIT_RETRY) {
          await sleep(RATE_LIMIT_BACKOFF * (attempt + 1))
          continue
        }
        logger.debug(`[王者推送] ${campId} 多次触发频控，本轮跳过`)
        return null
      }

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

  return null
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
 * @returns {Promise<{gameOnline:number, onlineTime:number, offlineTime:number, roleName:string}|null|symbol>}
 */
export async function fetchOnlineState (campId, qq) {
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRY; attempt += 1) {
    try {
      const res = await ApiService.getProfile(String(campId), String(qq))
      const code = Number(res?.returnCode || 0)

      if (code === CODE_PROFILE_HIDDEN) return FETCH_HIDDEN

      if (code === CODE_RATE_LIMITED) {
        if (attempt < RATE_LIMIT_RETRY) {
          await sleep(RATE_LIMIT_BACKOFF * (attempt + 1))
          continue
        }
        return null
      }

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
      logger.debug(`[王者推送] 拉取 ${campId} 在线状态失败: ${error.message}`)
      return null
    }
  }

  return null
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
 * @param {object} item 当前场次
 * @param {object} [prev] 时间上更早的一场（list 里紧邻的下一项），用于比段位星数
 * @returns {string} 展示文案，如「巅峰分 1833 → 1845 (+12)」
 */
export function formatScoreChange (item, prev) {
  const oldScore = toInt(item?.oldMasterMatchScore)
  const newScore = toInt(item?.newMasterMatchScore)

  if ((oldScore > 0 || newScore > 0) && oldScore !== newScore) {
    const diff = newScore - oldScore
    const sign = diff > 0 ? '+' : ''
    return `巅峰分 ${oldScore} → ${newScore} (${sign}${diff})`
  }

  const job = String(item?.roleJobName || '').trim()
  if (!job) return ''

  const stars = toInt(item?.stars)
  const prevJob = String(prev?.roleJobName || '').trim()
  const prevStars = toInt(prev?.stars)

  // 段位名变了：stars 两边不同口径，减出来的差没意义，只报段位变化
  if (prevJob && prevJob !== job) {
    return `段位 ${prevJob} → ${job}（${stars}星）`
  }

  if (prevJob === job) {
    const jobNum = toInt(item?.roleJob)
    const prevJobNum = toInt(prev?.roleJob)

    // 同名段下营地还有个小编号 roleJob：旧体系把王者按 5 星编成连续小段
    // （段内星 0~5 循环，跨小段时 stars 前后不可比），新体系（荣耀王者）恒为 16、
    // stars 直接是累计星数。编号变了说明跨了小段，按编号判升降，不算星数差
    if (jobNum && prevJobNum && jobNum !== prevJobNum) {
      if (jobNum > prevJobNum) return `${job} ${prevStars} → ${stars}星（升段）`
      // 赢了编号却降只可能是赛季切换/段位重置（实测 2026-07-26 26→16），不是掉段，
      // 前后星数不可比，只报当前
      if (item?.gameresult === 1) return `${job} ${stars}星`
      return `${job} ${prevStars} → ${stars}星（掉段）`
    }

    const diff = stars - prevStars
    if (diff > 0) return `${job} ${prevStars} → ${stars}星（上了${diff}星）`
    if (diff < 0) {
      // roleJob 缺失时的兜底：赢了星数却下降，只可能是旧体系的段内循环重置
      if (item?.gameresult === 1) return `${job} ${prevStars} → ${stars}星（升段）`
      return `${job} ${prevStars} → ${stars}星（掉了${-diff}星）`
    }
    // 差值为 0：王者段输了有保星机制，星数不动是真实结果，如实只报当前星数
  }

  return `${job} ${stars}星`
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

  const score = formatScoreChange(item, prev)
  if (score) lines.push(`${win ? '📈' : '📉'} ${score}`)

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
 * 这一轮要不要花一次战绩列表请求（morebattlelist，返回体比 profile 大一个量级）。
 *
 * 玩家离线时既不会开局也不会出新战绩，那一次请求是纯浪费，跳过它不影响任何提醒：
 * - 只开上下线提醒：战绩列表只在「刚下线」那一轮有用（喂 summarizeSession 做收工总结），
 *   在线期间拉回来的数据原样丢掉
 * - 两个都开：在线要推战绩/开局，刚下线要收尾最后那几局，持续离线就跳
 * - 只开战绩推送：没有 profile 信号，战绩列表是唯一信息源，只能每轮拉
 *
 * profile 这轮拉失败（state 为 null）时一律按「要拉」处理——宁可多一次请求，
 * 也不能因为拿不到在线状态就把战绩推送停掉。
 *
 * @param {object} opts
 * @param {boolean} opts.battleOn 订阅开了战绩推送
 * @param {boolean} opts.onlineOn 订阅开了上下线提醒
 * @param {object|null} opts.state 本轮的 profile 结果
 * @param {object} opts.sub 订阅项，读 lastOnlineState 判「是不是刚下线那一轮」
 * @returns {boolean}
 */
export function needBattleList ({ battleOn, onlineOn, state, sub = {} } = {}) {
  // 没有 profile 信号可用：只能靠战绩列表本身
  if (!onlineOn || !state) return battleOn

  const online = toInt(state.gameOnline) !== 0
  const wasOnline = sub.lastOnlineState !== undefined &&
    sub.lastOnlineState !== null &&
    String(sub.lastOnlineState) !== '' &&
    String(sub.lastOnlineState) !== '0'
  const justWentOffline = !online && wasOnline

  return battleOn ? (online || justWentOffline) : justWentOffline
}

/**
 * 这个订阅现在算不算「活跃」，决定下一轮是保持高频还是开始退避。
 *
 * 判据按信号可靠性排序：
 * 1. 有 profile → `gameOnline !== 0` 最可靠（三态语义见 fetchOnlineState 的注释）
 * 2. 没有 profile（只开战绩推送、或 profile 这轮拉失败）→ 退回战绩列表本身：
 *    正在打（isGaming）算活跃，最新一场在 RECENT_BATTLE_WINDOW 内也算
 * 3. 两个都没拿到 → **算不活跃**。接口一直失败就该退避，别按高频硬刚，
 *    正好和 api.js 的频控冷却一个方向
 *
 * @param {object|null} state fetchOnlineState 的返回（已排除 FETCH_HIDDEN）
 * @param {object|null} data fetchLatest 的返回（已排除 FETCH_HIDDEN）
 * @param {number} nowSec 当前时间戳（秒）
 * @returns {boolean}
 */
export function isSubActive (state, data, nowSec) {
  if (state) return toInt(state.gameOnline) !== 0

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
