/**
 * 营地币**兑换**的纯解析（`#营地兑换` 用）。
 *
 * ## 数据源（2026-10-11 定）
 *
 * `POST /operation/lotteryquery { gameId:'20001', type:'exchange' }` 的
 * `data.exchangeInfo.giftList[]` —— **必须带 `type:'exchange'`**！
 * 不带的话 `exchangeInfo` 恒为 `null`，会误判成「没有兑换活动」，
 * 而实际上有 19 件商品在挂着（`/operation/action/tasklist` 里那份 `exchangeList`
 * 只有 6 件，是**残缺的子集** —— 早先就是被它误导，以为「只有这么点商品」）。
 *
 * ## 字段真相（实测原文）
 *
 *   · `currency`    —— 价格（营地币）
 *   · `exchangePos` —— 兑换接口要的位置号，**不是数组下标**（1..19，可跳号）
 *   · `itemLeft`    —— **活动总剩余**。`-1` = 不限量，`0` = 抢光 ⚠️
 *   · `userLeft`    —— **我还能兑几份**。这才是「我能不能兑」的判据 ⚠️⚠️
 *   · `userLimit`   —— 每人上限（`userLeft` 会随兑换减少）
 *   · `gameId`      —— 归属：`20001` 王者 / `50001` 营地 / `30001`/`30005` 其它游戏
 *
 * ⚠️⚠️ **`itemLeft` 和 `userLeft` 缺一不可**：前者是「活动还有没有货」，
 * 后者是「我的额度用完没有」。只看 `itemLeft` 会把「我兑满了」误报成可兑；
 * 只看 `userLeft` 会把「抢光了」误报成可兑。
 *
 * 零 import，为了能脱开云崽运行时直接单测。
 */

/** 能直接用指令兑的 gameId（只有王者自己的商品发到角色身上） */
export const GAME_ID_SMOBA = '20001'

/** `itemLeft` 的「不限量」哨兵 */
const UNLIMITED = -1

/**
 * 一条兑换商品 → 展示/决策用的统一形状。
 *
 * @param {object} raw `giftList[]` 里的一条
 * @param {number} index 列表序号（从 0 开始），给用户看的编号按它排
 * @param {string[]} ownedIds 已拥有的 `sPackageId` 集合（可选）
 */
export function normalizeGift (raw, index = 0, ownedIds = []) {
  const pos = String(raw?.exchangePos ?? '').trim()
  if (!pos) return null

  const left = toInt(raw?.itemLeft, UNLIMITED)
  const userLeftRaw = raw?.userLeft
  const userLeft = userLeftRaw === undefined || userLeftRaw === null
    ? null                       // 接口没给就是「不知道」，**不是 0**
    : toInt(userLeftRaw, 0)
  const limit = toInt(raw?.userLimit, 0)
  const price = toInt(raw?.currency, 0)

  const pkgId = String(raw?.sPackageId ?? '').trim()
  const owned = pkgId ? ownedIds.includes(pkgId) : false

  return {
    no: index + 1,
    pos,
    gameId: String(raw?.gameId ?? '').trim(),
    name: String(raw?.sPackageName ?? '').trim() || '未命名商品',
    desc: String(raw?.sPackageDesc ?? '').trim(),
    price,
    pkgId,
    left,
    unlimited: left === UNLIMITED,
    soldOut: left === 0,
    userLeft,
    limit,
    /** 我的额度用完了（接口给了 `userLeft` 且为 0） */
    mineUsed: userLeft === 0,
    endTime: String(raw?.endTime ?? '').trim(),
    icon: String(raw?.sPackageIconUrl || raw?.sPackageIcon || '').trim(),
    owned,
    /** 只有王者的商品能兑（见 GAME_ID_SMOBA 的注释） */
    supported: String(raw?.gameId ?? '').trim() === GAME_ID_SMOBA,
    /**
     * 限兑周期（`userLimitType`）：0 本期 / 1 本日 / 2 本周 / 3 本月。
     *
     * ⚠️ 字段名是 `userLimitType` 但**语义是周期** —— 别被名字骗了，
     *    它不是「用户等级」那种东西。分组见 `groupByCycle`。
     */
    cycleType: toInt(raw?.userLimitType, 0)
  }
}

/**
 * 解析整份兑换数据。
 *
 * @param {object} data `/operation/lotteryquery` 的 `data`
 * @returns {{gifts: object[], coin: number|null, endTime: string, ruleText: string, activityId: string}}
 *   `coin` 读不到是 `null`（**不是 0**；「读不到余额」和「余额是 0」对用户是两件事）
 */
export function parseExchange (data, { ownedIds = [] } = {}) {
  const info = data?.exchangeInfo || {}
  const raw = Array.isArray(info.giftList) ? info.giftList : []

  // ⚠️ 排序按 `priority`（服务端给的展示权重，越小越前），其次 `exchangePos` ——
  //    App 里的顺序就是这个，别按 pos 数字排（实测 pos 是 1,2,3…19 但活动可能跳号）
  const sorted = [...raw].sort((a, b) => {
    const pa = toInt(a?.priority, 9999)
    const pb = toInt(b?.priority, 9999)
    if (pa !== pb) return pa - pb
    return toInt(a?.exchangePos, 0) - toInt(b?.exchangePos, 0)
  })

  const gifts = sorted.map((item, i) => normalizeGift(item, i, ownedIds)).filter(Boolean)

  const rawCoin = data?.userCurrencyCnt
  const coin = rawCoin === null || rawCoin === undefined || rawCoin === ''
    ? null
    : toInt(rawCoin, 0)

  return {
    gifts,
    coin,
    endTime: String(info.endTime ?? '').trim(),
    ruleText: String(info.ruleText ?? '').trim(),
    activityId: String(info.exchangeId ?? '').trim()
  }
}

/**
 * 能不能兑这件：**在发请求之前就把必然失败的拦下来**。
 *
 * 兑换是写请求，明知要失败还发一次，白撞频控（而且营地的失败文案
 * 一半是「系统繁忙」，用户看了完全不知道发生了什么）。
 *
 * @param {object} gift normalizeGift 的结果
 * @param {number|null} coin 当前余额
 * @returns {{ok: boolean, reason: string}} `ok=false` 时 `reason` 是给用户看的人话
 */
export function canExchange (gift, coin) {
  if (!gift) return { ok: false, reason: '没有这件商品' }

  // 顺序有讲究：先说「抢光了」，这是用户最能理解的原因；
  // 「我的额度用完」放它后面 —— 前者对所有人成立，后者只对自己
  if (gift.soldOut) return { ok: false, reason: '已经抢光了' }
  if (gift.mineUsed) return { ok: false, reason: '你已经兑过了，等下次活动' }
  if (gift.owned) return { ok: false, reason: '你已经拥有这件了' }

  if (!gift.supported) {
    return {
      ok: false,
      reason: gift.gameId === '50001'
        ? '这件要在营地 App 里兑'
        : '这件是别的游戏的，要在营地 App 里兑'
    }
  }

  // 余额读不到时不拦：让服务端去判（本地瞎拦会把「其实能兑」的也挡掉）
  if (coin !== null && coin < gift.price) {
    return { ok: false, reason: `营地币不够，还差 ${gift.price - coin}` }
  }

  return { ok: true, reason: '' }
}

/**
 * 造兑换请求体。
 *
 * ⚠️⚠️ 形态是实测逼出来的（2026-10-11），少一个字段就得到一句骗人的文案：
 *
 * | body | 返回 |
 * |---|---|
 * | 不带 `gameId` | `-105223 系统繁忙` ← 其实是缺参数 |
 * | 商品 50001 配 `gameId:'20001'` | `-10520011 系统繁忙` ← 其实是商品与游戏不匹配 |
 * | **王者商品 + 王者角色 + `gameId:'20001'`** | `-10530338 营地币不足` ← **参数全对** |
 *
 * `gameId` 与 `mGameid` 要**同时**给、都等于**商品的 gameId**；角色那几项来自
 * `/game/rolelist`（⚠️ 用 `roleId` 这个营地侧的，不是 `gameRoleId`）。
 *
 * @param {object} gift normalizeGift 的结果
 * @param {object} role `/game/rolelist` 里选中的角色
 * @param {string|number} [num] 兑换份数（默认 1；补签卡那种限 3 的可以多份）
 */
export function exchangeBody (gift, role, num = 1) {
  return {
    giftType: 'exchange',
    exchangePos: String(gift.pos),
    gameId: String(gift.gameId),
    mGameid: String(gift.gameId),
    // platid 固定 1（安卓）—— 营地只拿它区分客户端平台，跟奖励发放无关
    platid: '1',
    gameOpenid: String(role?.openId ?? ''),
    areaId: String(role?.areaId ?? ''),
    serverId: String(role?.serverId ?? ''),
    campRoleId: String(role?.roleId ?? ''),
    packageNum: String(num)
  }
}

/** 一件商品渲染成一行（文字版用） */
export function describeGift (gift) {
  const parts = [`${gift.no}. ${gift.name}`]
  parts.push(`${gift.price} 币`)

  if (gift.soldOut) parts.push('已抢光')
  else if (gift.mineUsed) parts.push('已兑过')
  else if (gift.owned) parts.push('已拥有')
  else if (!gift.supported) parts.push('需在 App 兑')
  else if (!gift.unlimited && gift.left > 0) parts.push(`剩 ${gift.left} 份`)

  return parts.join(' · ')
}

/** 把业务码前缀（`-10530338:`）去掉，只留人话 */
export function cleanExchangeMsg (msg) {
  return String(msg ?? '').replace(/^-?\d+:/, '').trim()
}

/**
 * 按**限兑周期**分组 —— 营地 App 就是这么分的（「本期·限兑」/「本周·限兑」）。
 *
 * `userLimitType` 实测取值（从兑换页 JS 里挖出来的映射）：
 *   · `0` 本期（活动期内一共能兑几份，通常是 1）
 *   · `1` 本日
 *   · `2` 本周（每周一 00:00 重置）
 *   · `3` 本月
 *
 * 每组配一句说明 —— **周期不同，重置规则就不同**，不写清楚用户会以为
 * 「兑过就没了」（实际本周的周一还会回来）。
 *
 * ⚠️ 分组本身也要**保序**：组按 type 升序（本期在最前，跟 App 一致），
 *    组内保持 `parseExchange` 排好的 priority 顺序 —— 别在这里重排。
 *
 * @param {object[]} gifts parseExchange 的 `gifts`
 * @returns {Array<{type: string, title: string, tip: string, gifts: object[]}>}
 */
export function groupByCycle (gifts = []) {
  const META = {
    0: { title: '本期', tip: '活动周期内限兑' },
    1: { title: '本日', tip: '每天 00:00 重置' },
    2: { title: '本周', tip: '每周一 00:00 重置' },
    3: { title: '本月', tip: '每月 1 号 00:00 重置' }
  }

  const buckets = new Map()

  for (const gift of gifts) {
    const type = String(gift?.cycleType ?? 0)
    if (!buckets.has(type)) {
      const meta = META[type] || { title: '限兑', tip: '' }
      buckets.set(type, { type, ...meta, gifts: [] })
    }
    buckets.get(type).gifts.push(gift)
  }

  return [...buckets.values()].sort((a, b) => Number(a.type) - Number(b.type))
}

/**
 * 给模板准备的展示字段（模板里不做计算，全在这里算好）。
 *
 * 分开写是为了**能单测**：模板里的 `{{if}}` 一旦写复杂了就没法验证。
 */
export function toCard (gift) {
  const limitText = gift.limit > 1 ? `限兑 ${gift.limit} 份` : '限兑 1 份'

  return {
    ...gift,
    limitText,
    /**
     * 左上角角标只在**限量商品**上显示 —— 照营地 App 的做法：
     *   · 限量还剩 → 「剩 N 份」（蓝底）
     *   · 限量抢光 → 「剩 0 份」（蓝底，跟 App 一致；这就是「已抢光」的视觉表达）
     *   · **不限量**（`itemLeft = -1`）→ **什么都不挂** ⚠️
     *     挂个「剩 -1 份」既没意义又难看，这是这个字段最容易写错的地方。
     *
     * 所以判据是「限量」而不是「有货」—— 抢光的也要显示，只是数字是 0。
     */
    showLeft: !gift.unlimited,
    /** 蓝色角标上那句（抢光的写 0，配合卡片压暗一起表达「没了」） */
    leftText: gift.unlimited ? '' : `剩 ${Math.max(0, gift.left)} 份`
  }
}

/** `Number()` 对 null/''/[] 全回 0，这里要能区分「真的是数字」和「字段缺失」 */
function toInt (value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return fallback
}
