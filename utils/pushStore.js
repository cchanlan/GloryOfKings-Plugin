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
 * 2. 列表里的 oldMasterMatchScore / newMasterMatchScore 只有巅峰赛场次有值，排位场次恒为 0
 *    （data/BattleList.json 缓存里全是 0，就是因为那 30 场全是排位赛）。所以巅峰分拿不到时
 *    回落到 roleJobName + stars 显示段位星数变化。
 * 3. stars 的语义随段位变化：同一批数据里「最强王者」是段内星数（1~5 循环），
 *    「荣耀王者」却是累计星数（59）。所以只在 roleJobName 相同时才做星数差值，
 *    段位名变了就只报段位变化，不算差。
 *
 * 纯计算逻辑（连胜、筛新场次、文案）都放在这个文件里而不是 apps/ 下，
 * 因为 apps/*.js 的 `extends plugin` 依赖 Yunzai 注入的全局，脱离 Bot 环境 import 就崩，没法单测。
 */
import path from 'path'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'
import ApiService from './api.js'
import cache from './cache.js'
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

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

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

/** 删除订阅 */
export function removeSub (qq) {
  const key = String(qq)
  const list = loadPushList()
  if (!list[key]) return false

  delete list[key]
  savePushList(list)
  return true
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

/* ------------------------------------------------------------------ 纯计算 */

const toInt = value => {
  const num = Number(value)
  return Number.isFinite(num) ? Math.trunc(num) : 0
}

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
 * 巅峰分：列表项自带 oldMasterMatchScore / newMasterMatchScore，实测只有巅峰赛场次有值。
 * 段位星数：列表项自带 roleJobName + stars，但 stars 的语义随段位变化（见文件头注释），
 *           所以要和上一场比，且只在段位名相同时才算差值。
 *
 * @param {object} item 当前场次
 * @param {object} [prev] 时间上更早的一场（list 里紧邻的下一项），用于比段位星数
 * @returns {string} 展示文案，如「巅峰分 1833 → 1845 (+12)」
 */
export function formatScoreChange (item, prev) {
  const oldScore = toInt(item?.oldMasterMatchScore)
  const newScore = toInt(item?.newMasterMatchScore)

  if (oldScore > 0 || newScore > 0) {
    const diff = newScore - oldScore
    const sign = diff > 0 ? '+' : ''
    return `巅峰分 ${oldScore} → ${newScore} (${sign}${diff})`
  }

  const job = String(item?.roleJobName || '').trim()
  if (!job) return ''

  const stars = toInt(item?.stars)
  const prevJob = String(prev?.roleJobName || '').trim()

  // 段位名变了：stars 两边不同口径，减出来的差没意义，只报段位变化
  if (prevJob && prevJob !== job) {
    return `段位 ${prevJob} → ${job} ${stars}星`
  }

  if (prevJob === job) {
    const diff = stars - toInt(prev?.stars)
    if (diff !== 0) {
      const sign = diff > 0 ? '+' : ''
      return `${job} ${stars}星 (${sign}${diff})`
    }
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
 */
export function formatBattleText (item, prev, heroMap = {}) {
  const win = item?.gameresult === 1
  const heroName = heroMap[String(item?.heroId)] || `英雄${item?.heroId ?? '?'}`
  const kda = `${toInt(item?.killcnt)}/${toInt(item?.deadcnt)}/${toInt(item?.assistcnt)}`

  const head = `${win ? '🏆 胜利' : '💧 失败'} · ${heroName} · ${kda}`
  const grade = item?.gradeGame ? ` · 评分 ${item.gradeGame}` : ''

  const lines = [head + grade]

  const score = formatScoreChange(item, prev)
  if (score) lines.push(`${win ? '📈' : '📉'} ${score}`)

  const parts = []
  const duration = formatDuration(item?.usedTime)
  if (duration) parts.push(`⏱ ${duration}`)
  if (item?.desc) parts.push(item.desc)
  if (parts.length) lines.push(parts.join(' · '))

  return lines.join('\n')
}

/**
 * 开局提醒文案。
 * gaming 实测字段：{ isGaming, dtEventTime(开局时间戳,全程恒定), heroId, heroIcon,
 *                    mapName, duration(已进行分钟), gameNum(该英雄场次), winRate, detailUrl, watch }
 * @param {object} gaming data.gaming
 * @param {object} [heroMap] heroId -> 英雄名
 */
export function formatGamingText (gaming, heroMap = {}) {
  const mode = String(gaming?.mapName || '').trim() || '对局'
  const heroName = heroMap[String(gaming?.heroId)] || (gaming?.heroId ? `英雄${gaming.heroId}` : '')

  const lines = [`开打了 · ${mode}`]

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
