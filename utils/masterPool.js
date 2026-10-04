/**
 * 大神观战池的纯逻辑：从营地返回的一坨条目里，挑出「这一轮开哪几路」。
 *
 * 单独放 `utils/` 是为了能**脱机单测** —— `apps/` 下要整套 Yunzai 桩才能 import
 * （见仓库约定）。这里不碰网络、不碰配置，只做筛选和分流。
 *
 * 数据长什么样（2026-09-27 实测 `/info/tv/choiceitem`）：
 *   `tvChoiceItems` 里混着主播 / 活动 / 节目 / 赛事，**只有 `tvType === 2` 是对局**；
 *   对局自带 `battle.liveStream.stream.liveStreamUrl`（带签名的 RTMP，约 2h 过期）、
 *   `battleInfo.gameType`（4 排位 / 14 巅峰）、`battleInfo.roleInfo.tag`（分路在里面）。
 */

/** 五个分路 —— 就是营地 `roleInfo.tag` 里 `id === 4` 那几条的 name，别自己造词 */
export const LANES = ['对抗路', '打野', '中路', '发育路', '游走']

/** `gameType` → 人话。营地只开放这两种模式观战（判据见 utils/watchMode.js） */
export const MODE_NAME = { 4: '排位', 14: '巅峰' }

/** 分路标签在 `tag` 数组里的 id */
const LANE_TAG_ID = 4

/**
 * 池子里的一条 → 内部结构。
 *
 * 不是对局（`tvType !== 2`）、或者这条的流没就绪（`liveStream.success` 假 / 没给地址）
 * 都返回 null —— 开一个没有流的房间只会让群友看一个永远转圈的页面。
 */
export function toBattle (item) {
  if (item?.tvType !== 2 || !item.battle) {
    return null
  }
  const { battleInfo: info = {}, liveStream } = item.battle
  const url = liveStream?.success && liveStream?.stream?.liveStreamUrl
  if (!url) {
    return null
  }
  return {
    url,
    battleId: String(info.battleID || ''),
    gameType: Number(info.gameType) || 0,
    nick: [info.roleInfo?.roleName, info.heroName].filter(Boolean).join('·') || '大神',
    lane: (info.roleInfo?.tag || []).find((tag) => tag.id === LANE_TAG_ID)?.name || '',
    desc: info.desc || ''
  }
}

/** 一坨原始条目 → 可用的对局列表 */
export function toBattles (items) {
  return (Array.isArray(items) ? items : []).map(toBattle).filter(Boolean)
}

/**
 * 挑出这一轮要开的对局。
 *
 * 规则：**两种模式各占一半**（默认 5 + 5），凑不齐就用另一边补满，最后按 `count` 截断。
 *
 * ⚠️ 为什么非得补：**巅峰赛每天 12:00 才开**，那之前池子里一场巅峰都没有 ——
 * 不补的话主人半夜发指令就只能开到 5 路。反过来只开巅峰的人也一样。
 *
 * @param {Array} items 原始条目（`tvChoiceItems`）
 * @param {object} opts
 * @param {string} [opts.lane] 只要这个分路（认不出就当作没筛，调用方该先校验）
 * @param {number} [opts.count] 一共开几路
 * @param {number} [opts.perMode] 每种模式最多几路
 * @return {{picked: Array, total: number, laneMissed: boolean}}
 *   `laneMissed` = 指定了分路但一场都没有（调用方据此给「这批没有打野」的提示）
 */
export function pickBattles (items, opts = {}) {
  return pickFromBattles(toBattles(items), opts)
}

/** 同上，但吃的是**已经转换好**的对局列表（多次拉池子累积之后用这个） */
export function pickFromBattles (battles, { lane = '', count = 10, perMode = 5 } = {}) {
  const all = Array.isArray(battles) ? battles : []
  const matched = lane ? all.filter((it) => it.lane === lane) : all
  if (!matched.length) {
    return { picked: [], total: all.length, laneMissed: Boolean(lane) }
  }

  const rank = matched.filter((it) => it.gameType === 4)
  const peak = matched.filter((it) => it.gameType === 14)
  // 不在两种可观望模式里的（理论上不会有）也留着，别白扔 —— 排在最后当补充
  const other = matched.filter((it) => it.gameType !== 4 && it.gameType !== 14)

  const picked = [
    ...rank.slice(0, perMode),
    ...peak.slice(0, perMode),
    ...other.slice(0, perMode)
  ]
  if (picked.length < count) {
    const rest = [
      ...rank.slice(perMode),
      ...peak.slice(perMode),
      ...other.slice(perMode)
    ]
    picked.push(...rest.slice(0, count - picked.length))
  }

  return { picked: picked.slice(0, count), total: all.length, laneMissed: false }
}

/** 分路筛选：把用户输入对上 `LANES` 里的一个（认不出返回空串） */
export function matchLane (input) {
  const want = String(input || '').trim()
  if (!want) {
    return ''
  }
  return LANES.find((it) => want === it || want.startsWith(it)) || ''
}
