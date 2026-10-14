/**
 * 营地**隐私设置**的纯解析与写入规划（`#隐私帮助` / `#隐私公开` / `#隐私隐藏` 用）。
 *
 * ## ⚠️⚠️ 头号事实：**菜单读回的 `status` 是假的，不能当状态源**（2026-10-14 实测）
 *
 * `/user/getprivacymenu` 的 `detailInfo[].status` **不反映真实生效状态**。
 * 实测闭环（主人号 1580886057）：
 *   · form 网关写 `privacyId:9` 五档 `status:1` → 两个不同观察者查战绩都
 *     `invisible=true, list=0`（**真的被挡住了**）
 *   · 同一时刻读菜单 → 五档全是 `status:0`（「全部联系人可查看」）—— **完全对不上**
 * 一直到还原之后菜单都没变过。所以：
 *   · **别拿 `status` 显示「现在藏没藏」** —— 会告诉用户「全部可查看」而实际没人看得到
 *   · **别拿 `status` 做「已经是目标状态就跳过」的优化** —— 会跳错，用户发了指令却什么都没改
 * 菜单里**可信的**只有结构：`id`（编号）、`privacyId`、`name`、档位的 `name` 与 `disableModify`。
 *
 * 唯一能验证的真实状态是**战绩**那一块：拿**别人的** token 查
 * `/game/morebattlelist`，看 `data.invisible`（见 `battleVisibility`）。
 * 其余 12 项没有对应的「他见」接口，查不了。
 *
 * ## 两条通道
 *
 * **读结构** `POST /user/getprivacymenu`（**主网关** `kohcamp.qq.com`，锁自己的账号）
 *   回 4 大类共 **16 项**：战绩 4 / 社交 5 / 物品 4 / 王者星会员 3。
 *   ⚠️⚠️ **必须用主网关**。老的 form 网关同路径也通，但那份是**残缺的**：只有 11 项
 *      （**缺「点赞」和星会员那 3 项**）、`status` 是字符串、而且**没有 `disableModify`**。
 *   ⚠️ 这个接口**只认自己的 token**（自我视角），拿别人的号读不出东西。
 *
 * **写** `POST /user/setprivacy { privacyId, friendTypeId, status }`
 *
 *   ⭐⭐ **两个方向走不同的网关**（2026-10-14 两轮干净隔离实验测出来的，别合并）：
 *
 *   | 方向 | 网关 | 额外参数 | 延迟 |
 *   |---|---|---|---|
 *   | 隐藏 `status:1` | **form**（`ssl.kohsocialapp.qq.com:10001`） | 无 | **30 秒** |
 *   | 公开 `status:0` | **主网关**（`kohcamp.qq.com`） | **`roleId`（王者主角色）** | **30 秒** |
 *
 *   踩过的坑：
 *     · **form 网关只能藏、不能放开** —— 用 form 发 `status:0`，实测**7 分钟都不生效**
 *       （同一轮里 form 发 `status:1` 只用 30 秒就翻了，所以不是账号或时机问题）。
 *       旧记忆把 form 当成双向主通道，并把主网关标成「备用还原通道」——
 *       真相是**那不是备用，公开方向只有它**。
 *     · **主网关必须带 `roleId`**，不带就惰性成功、no-op。`roleId` 取
 *       `/game/rolelist` 里 `gameId=20001` 下 `isMain=true` 那个角色的 `roleId`
 *       （实测主角色就够，不用找别的角色）。
 *     · **写间隔 ≥3 秒**（实测 1.1 秒间隔的 5 连发有一发静默没生效）。
 *     · **回成功 ≠ 生效**：两个网关对改不动的项、对走错方向的请求，一律惰性成功
 *       （form 回裸 `true`、主网关回 `{success:true}`）—— 这就是旧结论跑偏的原因。
 *   ❌ `/game/applybattleprivacy` 是 no-op（30+ 种参数形态全部惰性成功、从不生效），别碰。
 *   ❌ `privacyId:17`（王者日历）两个网关都回 **-20011 参数有误** —— 这一项改不动。
 *
 * ## 字段真相（实测原文）
 *
 *   · `id`         —— ⭐ **全局连续编号 1~16**（战绩 1-4、社交 5-9、物品 10-13、星会员 14-16）。
 *                     给用户看的编号**直接用它**，不要自己按下标编号 —— 自己编的号
 *                     一旦和图上的顺序对不上，用户照图选就改错项（`#营地兑换` 踩过）。
 *   · `privacyId`  —— 写接口要的那个 id，**和 `id` 不是一回事**
 *                     （如「我的比赛」`id=1` 但 `privacyId=9`；「粉丝」`id=6` 而 `privacyId=3`）
 *   · `status`     —— 语义是 `0`=可查看 / `1`=不可查看，但**读回来的值不可信**（见文件头）。
 *                     写的时候照这个语义传没问题。
 *   · `detailInfo` —— 档位数组，`friendTypeId` 的含义**按项而异**，别写死成一张表：
 *                     · 多数项：1=营地好友 3=我关注的人 4=我的粉丝 5=陌生人（「我的比赛」另有 6=QQ好友）
 *                     · 「在线状态、上线提醒」：1=在线状态 2=离线时间 3=游戏上线提醒
 *                     · 「观战」：0=允许观战 1=战绩 3=好友聊天 4=观战中心 5=教学频道 6=首页
 *                     所以档位一律**用服务端给的 `name` 认**，不查表。
 *   · `disableModify` —— 这档服务端锁着、改不动。
 *                     ⚠️ 旧记忆写的「观战 6 档**全**锁」是错的：实测只有
 *                     `friendTypeId=0「允许观战」`那一档锁，其余 5 档可改。
 *
 * 零 import，为了能脱开云崽运行时直接单测。
 */

/** `status`：可查看（开放） */
export const VISIBLE = 0
/** `status`：不可查看（隐藏） */
export const HIDDEN = 1

/**
 * 「战绩」那一类的 `privacyId`，给 `#隐藏我的战绩` / `#公开我的战绩` 用。
 *
 * 9=我的比赛 10=我的比赛详情 11=赛季表现 12=精彩时刻 —— 这四项合起来才是
 * 别人口中的「战绩」。只藏 9 的话，赛季表现和精彩时刻照样露着。
 */
export const BATTLE_PRIVACY_IDS = [9, 10, 11, 12]

/** 改不动的项：营地两个网关都回 -20011（实测 17=王者日历） */
export const UNWRITABLE_PRIVACY_IDS = [17]

/**
 * ⭐ **实测不生效的项**（2026-10-14 逐项藏→放双向验证）。
 *
 * 7「皮肤」：两条通道（form / 主网关+roleId）写隐藏都回 `success`，
 * 但**他见视角照样能读到皮肤**（`skinCountInfo.owned` 恒定 66，50 秒后不变）。
 * 也就是说服务端收下了这个设置、但**不拿它拦任何数据**。
 *
 * ⚠️ 措辞坑：这不是「改不了 / 关了就开不回来」——设置写得进去、也写得回来，
 *    只是**它不拦数据**。跟用户说「改了没用」会被理解成前一种（主人 2026-10-14 就理解偏了），
 *    要说「营地不受这项约束，你藏了别人也查得到」。
 *
 * ⚠️ 和 `UNWRITABLE_PRIVACY_IDS` 不是一回事：那个是「写接口直接拒绝」，
 * 这个是「写得进去但没作用」。两个都要跟用户说实话，别让他以为藏住了。
 *
 * 16「星会员等级标识」也是这一类：form 那条回 `-20011`、主网关回 `{success:true}`，
 * 但**他见照样读得到 `vipLevel`**（恒定 5，两个方向都试过）。
 *
 * 8「铭文」：`/game/profile/allmods` 的 `modsStr` **31 条恒定不变**，藏了也拦不住。
 * 5「访客」：`/user/getbevisitsbygo` 一律回 `-47001 召唤师隐藏了访客列表`，
 *   而且**放开（status=0 全档）之后一字不变** —— 从「用指令能不能控制」这个角度，
 *   答案是**不能**，所以归这一类。
 *   ⚠️ 但别把它当成「访客隐私对所有人都没用」：三个视角（他见/自见/第三方）回的一字不差，
 *   说明**这个端点本身就是这么设计的**（可能访客列表另有入口、或本来就只对特定关系可见）。
 *   这里只敢下「指令改不动它」的结论，不敢推断营地 App 里的访客开关。
 *
 * ⚠️ 这一串共同教训：**「回错误码/回 success」都不能单独当有效性判据**。
 *    唯一可信的是「改完前后，他见读到的数据/错误码**变了没有**」。
 *
 * 15「在线状态、上线提醒」：`/user/getonlinegamefriendsinfo`（他见）里
 *   藏了之后**被查号照样出现在别人的在线列表**、`online=4 开局 8 分钟` 一字不变
 *   （趁账号真在打游戏时验的，前提是满足的）→ 不拦数据。
 * 4「关注」：`/user/getuserprofilecardlist` 的 `attentionCountText` 恒定 `1` 不变。
 *
 * ⚠️ 别被「在线状态」的名字骗了：营地这个开关管的多半是**它自己的社交展示**，
 *    而 `/user/getonlinegamefriendsinfo` 读的是**游戏内实时状态**（走的是游戏数据，
 *    不是营地社交数据），所以拦不住。
 */
export const INEFFECTIVE_PRIVACY_IDS = [4, 5, 7, 8, 15, 16]

/**
 * ⭐ **实测有效的项**（他见视角验证，藏得住也放得开）。
 *
 * | pid | 项 | 他见判据 | 藏之后 |
 * |---|---|---|---|
 * | 9  | 我的比赛 | `morebattlelist.data.invisible` | `true`、list 0 场 |
 * | 10 | 我的比赛详情 | `battledetail` 的 rc | **`-10103`**（服务端主动拒） |
 * | 11 | 赛季表现 | `seasonpage` 的 rc | **`-30408`**（服务端主动拒） |
 * | 6  | 英雄、常用英雄 | `profile/herolist.heroList` | **`rc=-110`**、列表读不到 |
 *
 * 这四项是**真在拦人**的（后三项直接回错误码，不是靠字段判断），可以放心推给用户。
 */
export const VERIFIED_PRIVACY_IDS = [6, 9, 10, 11]

/**
 * **拿不到他见判据的项** —— 营地没有「查别人这项」的接口，
 * 或者没挖到。写进去了，但**没法验证**（2026-10-14 挖过一轮端点，
 * 粉丝/访客/点赞那几个 `/user/getXxxList` 一律回 `rpc name ... invalid`，
 * 说明服务端根本没这些路径；精彩时刻的 `/game/highlight*` 一族回 12 服务繁忙）。
 *
 * 这些项**照常发指令**（写接口是真的、App 里的设置应该真会变），
 * 但**不能在图上或回复里承诺效果** —— 诚实说法是「营地查不出来」。
 */
export const UNVERIFIABLE_PRIVACY_IDS = [3, 12, 14, 18, 19]


/** 两次写之间至少等多久（毫秒）。见文件头「写间隔 ≥3 秒」那条实测 */
export const WRITE_GAP_MS = 3000

/** 写完到真正生效大概多久（秒），只用来跟用户说一句「等多久」 */
export const EFFECT_DELAY_SEC = 30

/**
 * 这个方向该用哪条通道发 —— **两个方向的网关不一样**，详见文件头那张表。
 *
 * 不是优化，是正确性：form 发 `status:0` 实测 7 分钟都不生效。
 *
 * @param {number} status 目标状态
 * @returns {'form'|'camp'} `form`=game form 网关 / `camp`=主网关（要带 roleId）
 */
export function gatewayFor (status) {
  return Number(status) === HIDDEN ? 'form' : 'camp'
}

const toText = value => String(value ?? '').trim()
const toInt = (value, fallback = 0) => {
  const n = parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 解析整份隐私菜单（**只取结构，不取 status**，原因见文件头）。
 *
 * 大类顺序、项顺序、编号全部**照服务端原样**，不重排 —— 图上的编号要和
 * 营地 App 里的顺序一致，用户对照着看才不会错位。
 *
 * @param {object|Array} data `/user/getprivacymenu` 的 `data`（也容忍整个响应体传进来）
 * @returns {{classes: object[], items: object[]}} `classes` 给出图分组用，`items` 是拍平的全部项
 */
export function parsePrivacyMenu (data) {
  const raw = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : [])
  const classes = []
  const items = []

  for (const cls of raw) {
    const className = toText(cls?.className) || '其它'
    const list = []

    for (const entry of (cls?.privacyItem || [])) {
      const item = normalizeItem(entry, className)
      if (!item) continue
      list.push(item)
      items.push(item)
    }

    if (list.length) classes.push({ className, items: list })
  }

  return { classes, items }
}

/** 一条隐私项 → 展示/决策用的统一形状 */
function normalizeItem (raw, className = '') {
  const no = toInt(raw?.id, 0)
  const privacyId = toInt(raw?.privacyId, -1)
  // 没编号或没 privacyId 的项既没法展示也没法改，直接丢（服务端加字段时不至于崩）
  if (!no || privacyId < 0) return null

  const details = (raw?.detailInfo || []).map(detail => ({
    friendTypeId: toInt(detail?.friendTypeId, -1),
    name: toText(detail?.name) || '未命名',
    /** 服务端锁着、改不动（观战的「允许观战」那档就是） */
    locked: detail?.disableModify === true,
    hint: toText(detail?.hintText)
    // ⚠️ 故意**不读 status** —— 读回来的值不反映真实状态（见文件头）。
    //    留着它只会诱使以后有人拿它去显示或做跳过优化。
  })).filter(detail => detail.friendTypeId >= 0)

  return {
    no,
    privacyId,
    className,
    name: toText(raw?.name) || `第 ${no} 项`,
    /** 这一项营地根本不让改（见 UNWRITABLE_PRIVACY_IDS） */
    unwritable: UNWRITABLE_PRIVACY_IDS.includes(privacyId),
    /** 写得进去但服务端不拿它拦数据（见 INEFFECTIVE_PRIVACY_IDS） */
    ineffective: INEFFECTIVE_PRIVACY_IDS.includes(privacyId),
    /** 实测真有效（见 VERIFIED_PRIVACY_IDS） */
    verified: VERIFIED_PRIVACY_IDS.includes(privacyId),
    /** 「关闭后会怎样」的说明，主网关叫 buttonText、form 网关叫 bottomText */
    note: toText(raw?.buttonText || raw?.bottomText),
    details
  }
}

/** 按编号找项 */
export function pickItem (items, no) {
  const wanted = toInt(no, 0)
  return (items || []).find(item => item.no === wanted) || null
}

/**
 * 按名字找档位（用户输入「陌生人」「在线状态」这种）。
 *
 * 一律拿服务端返回的 `name` 做匹配，不查表 —— `friendTypeId` 的含义按项而异
 * （见文件头），查表必然在「观战」和「在线状态」这两项上错位。
 *
 * 先全等、再双向包含，让「QQ好友」能匹配「QQ好友」、「好友」能匹配「营地好友」。
 *
 * @returns {object|null} 命中多个时返回 `null`（宁可让用户说清楚，也不要猜着改）
 */
export function matchDetail (item, text) {
  const wanted = toText(text)
  if (!wanted || !item?.details?.length) return null

  const exact = item.details.filter(detail => detail.name === wanted)
  if (exact.length === 1) return exact[0]

  const loose = item.details.filter(detail =>
    detail.name.includes(wanted) || wanted.includes(detail.name)
  )
  return loose.length === 1 ? loose[0] : null
}

/**
 * 这次要发哪几发写请求。
 *
 * ⚠️⚠️ **只跳过 `locked`，绝不跳过「看起来已经是目标状态」的档**。
 *    第一版做过那个优化，是**错的**：菜单读回的 `status` 不反映真实状态
 *    （见文件头），于是「别人其实看不到、菜单却说全部可查看」的号发
 *    `#隐私公开` 会被判成「已经是公开，没改动」—— 指令白发、问题还在。
 *    宁可每次把该项所有可改档位都发一遍（最多 6 发、18 秒），也不能跳错。
 *
 * @param {object} item 隐私项
 * @param {number} status 目标状态（`VISIBLE` / `HIDDEN`）
 * @param {object} [onlyDetail] 只改这一档（不传 = 该项所有可改档位）
 * @returns {{writes: object[], locked: object[]}}
 */
export function planWrites (item, status, onlyDetail = null) {
  const target = toInt(status, VISIBLE)
  const pool = onlyDetail ? [onlyDetail] : (item?.details || [])

  const writes = []
  const locked = []

  for (const detail of pool) {
    if (detail.locked) {
      locked.push(detail)
      continue
    }
    writes.push({
      privacyId: item.privacyId,
      friendTypeId: detail.friendTypeId,
      status: target,
      name: detail.name
    })
  }

  return { writes, locked }
}

/**
 * **图上不显示的项**（`unwritable` + `ineffective` 的合集）。
 *
 * 主人 2026-10-14 拍板：「无效的直接去掉就行了」—— 既然营地要么不让改、
 * 要么改了不拦数据，摆在图上只会误导（看着像个能用的开关）。
 *
 * ⚠️⚠️ **编号绝对不能重编**：这些项的编号是**服务端给的 `id`**（皮肤 11、日历 15），
 * 重编会让用户按图上的号去发指令时**改到别的项**。所以图上就是**跳号的**
 * （1-10、12-14、16），缺的那两个号用户发指令时会收到一句明确的说明。
 */
export const HIDDEN_FROM_HELP_IDS = [...UNWRITABLE_PRIVACY_IDS, ...INEFFECTIVE_PRIVACY_IDS]

/** 这一项要不要在帮助图上显示 */
export function isVisibleItem (item) {
  return !HIDDEN_FROM_HELP_IDS.includes(item?.privacyId)
}

/**
 * 战绩**实际**是不是被挡住了 —— 全插件唯一能验证的真实隐私状态。
 *
 * 判据是别人视角的 `/game/morebattlelist` 的 `data.invisible`：
 *   · `invisible === true` + `list` 空 = 真的被挡（文案「召唤师隐藏了个人战绩，无法查看」）
 *   · 其余 = 看得到
 *
 * ⚠️ **必须拿别人的 token 查**：营地有「自我豁免」，自己查自己永远看得到
 *    （隐藏态下自见仍是 30 场，实测），用自己的号查会恒定得到「没藏」。
 * ⚠️ `-10107` / `-30032` **不是**隐私判据（空号、未绑角色、纯虚构号都给这两个码），
 *    所以这里只认 `invisible`，拿不到就当「查不了」而不是「没藏」。
 *
 * @param {object} res `/game/morebattlelist` 的响应
 * @returns {{known: boolean, hidden: boolean, count: number}}
 */
export function battleVisibility (res) {
  const data = res?.data
  if (!data || typeof data !== 'object') return { known: false, hidden: false, count: 0 }

  const hidden = data.invisible === true
  const count = Array.isArray(data.list) ? data.list.length : 0
  return { known: true, hidden, count }
}

/** 战绩实际效果的一句话（图和文字兜底共用，免得两处说法漂移） */
export function battleVisibilityText (view) {
  if (!view?.known) return '别人能不能看到你的战绩：这次没查出来'
  return view.hidden
    ? '别人现在看不到你的战绩'
    : `别人现在能看到你的战绩（最近 ${view.count} 场）`
}

/** 一项的文字描述（出图挂了的兜底） */
export function describeItem (item) {
  const names = (item.details || [])
    .map(detail => `${detail.name}${detail.locked ? '(锁)' : ''}`)
    .join(' / ')
  const flags = []
  if (item.unwritable) flags.push('营地不让改')
  if (item.ineffective) flags.push('营地不受这项约束、藏了别人也能查')
  if (item.verified) flags.push('已实测有效')
  const suffix = flags.length ? `（${flags.join('；')}）` : ''
  return `${item.no}. ${item.name}${suffix}\n    可设置：${names}`
}

/** 喂模板的一项（模板不做计算，算好再传，这样能脱机断言） */
export function toCard (item) {
  return {
    no: item.no,
    name: item.name,
    unwritable: item.unwritable,
    ineffective: item.ineffective,
    verified: item.verified,
    details: (item.details || []).map(detail => ({
      name: detail.name,
      locked: detail.locked
    }))
  }
}
