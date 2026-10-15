/**
 * 跨机器人开黑：`#发起开黑` / `#加入开黑`。
 *
 * ## 它解决什么
 *
 * 一个群里凑不齐五个人是常态。所有接入同一个服务端的机器人共享一个房间池，
 * A 群的人发起，十几个群同时看得到，B 群的人就能补上那个缺的辅助。
 *
 * ## 链路
 *
 *   #发起开黑 → POST /team/create（服务端分配两位编号）→ 当场回复发起人
 *     ↓ 各机器人 30 秒轮询 GET /team/list?since=<rev>
 *   往开着广播的群播一条「有人发起开黑 [12]」
 *     ↓
 *   #加入开黑 12 辅助 → POST /team/join → **私聊**把发起人的联系方式给加入者
 *     ↓ 发起那台机器人在下一轮轮询的 `mine` 段看到新成员
 *   **私聊**告诉发起人「谁来了、他的营地ID 是多少」
 *
 * ## 两条刻意的克制
 *
 * 1. **群里只播两件事**：有人发起、满员了。中间「谁加入了」只私聊当事双方 ——
 *    一个 5 排房要是每次加人都播，群里会刷 5 条，这功能会先刷炸群再被所有人关掉。
 * 2. **群里不出现任何 QQ 号和营地ID**。播报只有昵称和段位，联系方式走私聊
 *    （服务端那边也是这么分的，见 team.mjs 的 `toPublic`）。
 *    满员那条会 @ 参与的人 —— at 段内部带 QQ，但群里显示的是他的群昵称，
 *    而且 @ 的一定是**在本群发过指令的人**（本机记录过），所以号码不会露出来。
 *
 * ## 满员播报只发参与过的群
 *
 * 「有人发起」要广播到所有群（那是招人，人越多越容易凑齐）；
 * 「人齐了」只发**本机参与过这个房的群**（发起群 + 有人加入的群），并 @ 上参与的人
 * （主人 2026-10-16 定）。没发起过、也没人加入过的群不用知道哪个房满了 —— 那是噪音。
 * 依据就是本地那两张表（`origins` 发起群 + `joins` 加入群），本机没参与过就一条都不发。
 *
 * ## 群级开关默认开
 *
 * 接入了服务端的机器人，**所在的每个群默认都收播报**（主人 2026-10-15 定）；
 * 不想收的群由群管理发 `#关闭开黑广播`。默认开的代价是群发量，所以播报做了三层收敛：
 *   · 一轮轮询里的所有新房 / 满员**合并成一条**发，每个群每轮最多收一条
 *   · 群与群之间隔 `BROADCAST_GAP_MS` 再发，别在同一秒往几十个群砸消息（风控）
 *   · 群列表还没就绪（冷启动适配器没连上）时**这轮不播也不记账**，下轮补上 ——
 *     否则这些房会被标成「播过了」而实际一个群都没发出去
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ApiService, shouldQuote, pickGroupSafe, AT_HEAD, stripAtText, getImgType } from '#utils'
import { PluginName } from '#components'
import { getCurrentId } from '../utils/localBind.js'
import { resolveUserData } from '../utils/shareStore.js'
import { summarizeProfile, rankText } from '../utils/profileSummary.js'
import { getHeroNameMap, heroIconUrl } from '../utils/reportStore.js'
import { sendPrivate } from '../utils/privateMsg.js'
import { FAKE_ACCOUNT } from '../utils/masterMsg.js'
// 分路图标只在 teamIcons 里定义一份，列表图和播报图共用（见那边的说明）
import { LANE_ICON_KEY, LANE_ICON_ANY, LANE_ICON_SVG } from '../utils/teamIcons.js'
import {
  teamCreate, teamJoin, teamLeave, teamClose, teamList,
  isTeamReady, TEAM_NOT_READY_HINT
} from '../utils/teamClient.js'
import {
  loadTeamStore, saveTeamStore, setTeamSub, mutedGroups,
  markOrigin, markJoin, roomKey, planBroadcast
} from '../utils/teamStore.js'
import { parseCreate, parseJoin, LANE_ANY } from '../utils/teamParse.js'

/** 轮询间隔。开黑讲的是「现在就想打」，30 秒是实时性和请求量的折中 */
const POLL_MS = 30 * 1000

/** 启动后多久拉第一轮。别和插件加载抢资源 */
const FIRST_POLL_MS = 20 * 1000

/**
 * 没绑营地ID 时的那句话。
 *
 * 按「只说做什么、要用户动手的给一条能直接照抄的指令」写，不解释为什么。
 */
const NO_CAMP_HINT = '开黑要先绑定营地ID，发 #绑定营地 你的营地ID'

/** 连续失败时的退避上限 */
const MAX_BACKOFF_MS = 10 * 60 * 1000

/**
 * 群发时群与群之间隔多久。
 *
 * 播报默认发到机器人所在的每个群，群多的号一轮可能是几十上百条 ——
 * 同一秒里全砸出去是 QQ 风控最典型的触发条件。1.5 秒一群，一百个群两分半发完，
 * 下一轮轮询要等这轮发完才排（`tick` 是 await 完才排下一拍），不会叠起来。
 */
const BROADCAST_GAP_MS = 1500

/**
 * `#开黑列表` 最多画几个房。
 *
 * 编号池有 90 个，真要是全画出来图会长到没法看（也没人会去翻）。
 * 画最近 12 个，头部标注「共 N 个」，想找特定房的人照编号加入即可。
 */
const LIST_MAX = 12

/* ────────────────────────── 轮询状态 ────────────────────────── */

/**
 * ⚠️⚠️ 轮询状态**必须锚在 `globalThis` 上，不能用模块级变量**。
 *
 * JiuLi 热重载会给 `plugins/` 下每个模块追加 `?jiuli_reload=<代数>` 重新求值，
 * 模块级的 `let timer` 每代都是新变量，`if (timer) return` 这道幂等锁形同不存在 ——
 * 营地消息那边真踩过：单进程里最多并存 7 条轮询链，各自都在真推消息、真写盘
 * （见 apps/campIm.js 的 POLL_STATE_KEY 注释和实测数据）。
 */
const POLL_STATE_KEY = '__gokTeamUpPollState'
const pollState = (globalThis[POLL_STATE_KEY] ||= {})

// ⚠️ 逐个补默认值，**不能用 `||= { ... }` 一把建**：热重载时 globalThis 上那个对象是
//    上一代留下的（可能没有本轮新加的字段），`||=` 见它存在就整个跳过，
//    于是新字段是 undefined → `undefined + 1` = NaN → 退避永远算不出来。
for (const [k, v] of Object.entries({
  timer: null,
  polling: false,
  failStreak: 0,
  // 当前是哪一代在跑。见 startPolling 的说明
  generation: null
})) {
  if (pollState[k] === undefined) pollState[k] = v
}

/* ────────────────────────── 文案 ────────────────────────── */

/** 「缺辅助、发育路」。一个都没写就说「都缺」—— 空着比写「无」好懂 */
function needText (needLanes, seats) {
  const list = Array.isArray(needLanes) ? needLanes.filter(Boolean) : []
  if (list.length) return list.join('、')
  return seats > 0 ? `${seats} 个位置都行` : ''
}

/** 「荣耀王者 68 星 · 战力 12345」。两项都没有就返回空串，别留个孤零零的「·」 */
function identityText (rank, power) {
  return [rank, power ? `战力 ${power}` : ''].filter(Boolean).join(' · ')
}

/**
 * 一个位置格。`lane` 认不出时退回「都行」那个图标，绝不留空白徽章。
 *
 * `initial` 是**没有头像时垫在底下的昵称首字**：没绑营地ID 的人查不到 roleIcon，
 * 营地头像的链接也可能加载失败 —— 两种情况下格子里都会是个空灰圈，
 * 五个人并排时根本分不出谁是谁。首字垫底之后至少还认得出人。
 */
function makeSeat (kind, lane, who, icon, hero = null) {
  return {
    kind,
    lane,
    who,
    icon: icon || '',
    iconKey: LANE_ICON_KEY[lane] || LANE_ICON_ANY,
    initial: kind === 'empty' ? '' : firstChar(who),
    // 最高战力英雄。缺了模板就不渲染那一行（老版本加入的成员没有这几个字段）
    heroName: hero?.name || '',
    heroPower: hero?.power ? Number(hero.power).toLocaleString('zh-CN') : '',
    heroIcon: hero?.icon || ''
  }
}

/**
 * 取昵称里第一个**认得出人**的字符。
 *
 * ⚠️ 不能直接 `slice(0, 1)`：颜文字昵称满大街都是，主人自己就叫 `(o゜▽゜)o☆` ——
 *    截出来是个光秃秃的括号，顶在头像位上既认不出人也难看。
 *    跳过标点符号找第一个字母/数字/汉字；整串都是符号就退回 `?`。
 */
function firstChar (name) {
  const matched = String(name || '').match(/[\p{L}\p{N}]/u)
  return matched ? matched[0] : '?'
}

/**
 * 把一个房摊成**位置格**：发起人一格、已补位的各一格、剩下的空格。
 *
 * 出图用这个而不是「缺辅助、发育路」那串文字 —— 按王者匹配界面的样子一字排开，
 * 每格一个头像 + 分路徽章，还差几个、差哪个位置一眼就看出来。
 *
 * 空格的分路标注优先用发起人写的缺口；缺口写得比空位少（或没写）就标「都行」，
 * **绝不留一个没有标注的空格** —— 那种格子用户不知道该报哪个分路。
 */
function buildSeats (room) {
  const seats = [makeSeat('owner', room.ownerLane, room.ownerName, room.ownerIcon, {
    name: room.ownerHeroName,
    power: room.ownerHeroPower,
    icon: room.ownerHeroIcon
  })]

  for (const member of room.joined || []) {
    seats.push(makeSeat('taken', member.lane, member.name, member.icon, {
      name: member.heroName,
      power: member.heroPower,
      icon: member.heroIcon
    }))
  }

  const taken = new Set(seats.map(seat => seat.lane))
  const needs = (room.needLanes || []).filter(lane => !taken.has(lane))
  const left = Math.max(0, room.size - seats.length)

  for (let i = 0; i < left; i += 1) {
    seats.push(makeSeat('empty', needs[i] || LANE_ANY, '空缺', ''))
  }

  return seats
}

/** 群播报：有人发起开黑 */
/**
 * 加入提示里该写哪个分路。
 *
 * 空位是「都行」时写成 `[分路]`，不要写「都行」—— 那是**命令示例**，
 * 写「都行」用户会真去敲这两个字，而它只是个占位。
 */
function joinHintOf (lane) {
  return lane && lane !== LANE_ANY ? lane : '[分路]'
}

/**
 * 把一个房整理成播报图里的一张卡。
 *
 * 和列表图用的是同一套位置格，所以这里只是在它外面补两个视图字段：
 *  · `joinHint`  卡片底部那行「发 #加入开黑 XX ___」的空缺示例（缺什么就写什么）
 *  · `seatsText` 右上角的「还差 N 人」
 */
function broadcastRoom (room) {
  const seatList = buildSeats(room)
  const empty = seatList.find(seat => seat.kind === 'empty')
  return {
    ...room,
    seatList,
    urgent: room.seats === 1,
    seatsText: room.seats > 0 ? `还差 ${room.seats} 人` : '人齐了',
    powerText: room.ownerPower ? room.ownerPower.toLocaleString('zh-CN') : '',
    joinHint: joinHintOf(empty?.lane)
  }
}

/** 满员的房在播报图里压成一行：编号 + 阵容 + 约定时间 */
function broadcastFullRoom (room) {
  const roster = [
    `${room.ownerLane} ${room.ownerName}`,
    ...(room.joined || []).map(m => `${m.lane} ${m.name}`)
  ].join(' · ')

  return { code: room.code, size: room.size, roster, meetText: room.meetText }
}

function buildNewBroadcast (room) {
  const who = [room.ownerName, identityText(room.ownerRank, room.ownerPower)]
    .filter(Boolean).join(' · ')

  const lines = [
    `🎮 有人发起开黑 [${room.code}]`,
    who,
    `${room.size} 排 · 他玩${room.ownerLane}`,
    `缺：${needText(room.needLanes, room.seats)}`
  ]

  if (room.meetText) lines.push(`约定：${room.meetText}`)
  if (room.note) lines.push(`备注：${room.note}`)
  if (room.ownerGroupName) lines.push(`来自：${room.ownerGroupName}`)

  lines.push('', `想去发 #加入开黑 ${room.code} [你的分路]`)

  return lines.filter(line => line !== undefined).join('\n')
}

/** 群播报：满员了 */
function buildFullBroadcast (room) {
  const roster = [
    `${room.ownerLane}：${room.ownerName}`,
    ...(room.joined || []).map(m => `${m.lane}：${m.name}`)
  ]

  const lines = [
    `🎮 ${room.code} 号房满了（${room.size} 排）`,
    ...roster
  ]
  if (room.meetText) lines.push(`约定：${room.meetText}`)

  return lines.join('\n')
}

/**
 * at 段。个别框架没把 `segment` 挂到全局时退回纯文本 —— 少一个红点提醒，
 * 总好过整个播报抛掉（同插件别处对宿主 API 一律能力探测 + 兜底）。
 */
function atSegment (qq) {
  try {
    if (typeof segment !== 'undefined' && segment?.at) return segment.at(qq)
  } catch {}
  return `@${qq}`
}

/**
 * 一条播报消息：图 + 满员那句 at + 图下面那行说明。
 *
 * @param {{fresh: Array, full: Array, ats: string[]}} item
 *   `full` 是**这个群**参与过的满员房（不是全部）；`ats` 是这些房里本机在这个群的参与者
 * @param {Buffer|null} image 出图为 null 时补文字版，不能只发一句 at
 */
function buildBroadcastMessage ({ fresh, full, ats }, image) {
  const message = []
  if (image) message.push(image)

  if (full.length) {
    // 一轮里一个群可能同时收到好几个房满员，合成一行
    const codes = full.map(room => `${room.code} 号房`).join('、')
    // at 段要平铺进数组，别塞成嵌套数组（框架发不出去）
    const atSegs = ats.length ? [...ats.map(atSegment), ' '] : []
    message.push('\n', ...atSegs, `${codes}人齐了，去游戏里组队吧`)
  }

  // 出图失败时把内容补成文字版（图里本来就写着同样的东西，别发一条只剩 @ 的空消息）
  if (!image) message.push(...(message.length ? ['\n'] : []), buildBroadcastText(fresh, full))

  message.push('\n', BROADCAST_CAPTION)
  return message
}

/* ────────────────────────── 轮询 ────────────────────────── */

/**
 * 该不该拉这一轮。
 *
 * 只看接没接入：群级开关默认开，接入了的机器人几乎总有群要播。
 * 没接入的机器一次请求都不发 —— 不该每 30 秒去敲一次空门
 * （营地消息那边踩过：没接入的机器把日志刷满 fetch failed）。
 */
function shouldPoll () {
  return isTeamReady()
}

/**
 * 这一轮要播的群：机器人所在的全部群，减掉发过 `#关闭开黑广播` 的。
 *
 * 跳过两类：
 *  · 频道 / 公会（有 `guild` 字段）—— 不是群，同 groupIndex 的处理
 *  · 框架假账号（JiuLi 的 mock、TRSS 的 stdin、官bot 沙盒）的群 —— 发过去只会报错。
 *    判据用 masterMsg 的 `FAKE_ACCOUNT`，不另写一份。Miao 单账号的 `gl` 没有 `bot_id`，
 *    那种情况也不存在假账号，直接放行
 *
 * @returns {string[]} 冷启动适配器还没连上时是空数组，调用方据此判断「这轮先别播」
 */
function broadcastGroups () {
  let groupMap
  try {
    groupMap = typeof Bot !== 'undefined' ? Bot.gl : null
  } catch (error) {
    logger.debug?.(`[开黑] 取群列表失败：${error?.message || error}`)
    return []
  }
  if (!groupMap?.size) return []

  const muted = mutedGroups()
  const out = []
  for (const [groupId, info] of groupMap) {
    const gid = String(groupId ?? '').trim()
    if (!gid || muted.has(gid)) continue
    if (info?.guild) continue
    if (info?.bot_id && FAKE_ACCOUNT.test(String(info.bot_id))) continue
    out.push(gid)
  }
  return out
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 群发。每个群的内容可以不一样（发起群要扣掉自己发起的那个房、满员要按群 @ 参与的人），
 * 由 `build` 按群生成。
 *
 * 失败**只汇总一条日志**：默认开之后群多，官bot 这类发不了主动消息的号会每群报一次错，
 * 一轮就是几十行 error，正经的报错反而被淹掉。
 *
 * @param {string[]} groups
 * @param {(groupId: string) => string|Array|null} build
 *   返回空串 / 空数组 / null 表示这个群这轮不用发；数组用于「图 + 文字 + at 段」这种消息
 */
async function broadcast (groups, build) {
  let sent = 0
  let failed = 0
  let lastError = ''

  for (const groupId of groups) {
    const message = build(groupId)
    if (!message) continue
    if (Array.isArray(message) && !message.some(Boolean)) continue

    // 发完一个群再等，第一个群不用等
    if (sent + failed > 0) await wait(BROADCAST_GAP_MS)

    const group = pickGroupSafe(groupId)
    if (!group?.sendMsg) {
      failed += 1
      lastError = `群 ${groupId} 取不到发送对象`
      continue
    }
    try {
      await group.sendMsg(message)
      sent += 1
    } catch (error) {
      failed += 1
      lastError = `群 ${groupId}：${error?.message || error}`
    }
  }

  if (failed) logger.warn(`[开黑] 播报发出 ${sent} 个群，失败 ${failed} 个（最后一个：${lastError}）`)
  else if (sent) logger.mark(`[开黑] 播报已发到 ${sent} 个群`)

  return sent
}

/**
 * 替发起人通知「谁加进来了」。
 *
 * 只有**发起那台机器人**能走到这里（服务端的 `mine` 段按令牌过滤），
 * 所以这里拿到的成员联系方式不会外泄给别的实例。
 *
 * 失败不重试、但要记账：否则每轮都私聊一次同一条，发起人会被刷。
 *
 * @param {string[]} [already] 之前已经通知过的成员 QQ
 * @returns {Promise<string[]|null>} 这轮之后的已通知名单；没有新成员返回 null
 */
async function notifyOwner (room, already) {
  const done = Array.isArray(already) ? [...already] : []
  const fresh = (room.members || []).filter(m => !done.includes(String(m.qq)))
  if (!fresh.length) return null

  for (const member of fresh) {
    const lines = [
      `${room.code} 号房来人了：${member.name} 打${member.lane}`,
      member.rank ? `段位：${member.rank}` : '',
      member.campId ? `营地ID：${member.campId}` : '',
      `QQ：${member.qq}`,
      ''
    ].filter(Boolean)

    const left = room.seats
    lines.push(left > 0 ? `还缺 ${left} 个：${needText(room.needLanes, left)}` : '人齐了')

    const result = await sendPrivate(room.ownerQq, lines.join('\n'))
    if (!result.ok) {
      logger.debug?.(`[开黑] 没能私聊 ${room.ownerQq}（${result.reason}）`)
    }
    // 成不成都记账：发不出去说明他不是机器人好友，重试多少轮都一样
    done.push(String(member.qq))
  }

  return done
}

/** 本机记录里，刚建的房这么久之内即使不在列表里也不清（见 pollOnce ④） */
const DROP_GRACE_MS = 2 * 60 * 1000

/** 从 roomKey 里取回建房时间 */
function createdAtOf (key) {
  return Number(String(key).split(':')[1]) || 0
}

/**
 * 状态落盘：**现读、改、写，中间没有 await**。
 *
 * ⚠️ 不能拿轮询开头读的那份整份写回。播报默认发到所有群，一轮可能跑好几分钟，
 *    这期间群管理发的 `#关闭开黑广播`、有人当场 `#发起开黑` 记下的发起群都已经落盘了 ——
 *    拿旧那份覆盖，关了的广播会自己弹回来（skinNews 踩过同一个坑，见那边的注释）。
 *    所以轮询只把**本轮自己的改动**套到最新那份上。
 */
function commitTeamStore (mutate) {
  const latest = loadTeamStore()
  mutate(latest)
  saveTeamStore(latest)
}

/**
 * 播报图下面跟的那一行。
 *
 * 图里每张卡已经写了「发 #加入开黑 XX 分路」，这句只补一个全局视角 ——
 * 文案放图**下面**（见 [[plugin-push-copy-below-image]]）。
 */
const BROADCAST_CAPTION = '发 #开黑列表 看全部在招人的房'

/**
 * 渲染播报图。失败返回 null，由调用方回落到文字版。
 *
 * 一个群一轮只发**一张图**：这轮所有新房 + 满员合在一起画进去。
 * 一有变化就一个房一张图的话，5 排房从建到满会往每个群砸 5 张，
 * 十几台机器人的群全被刷一遍 —— 这功能会先被所有人关掉。
 */
async function renderBroadcast (fresh, full) {
  if (!fresh.length && !full.length) return null

  try {
    return await puppeteer.screenshot('TeamBroadcast', {
      imgType: getImgType(),
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/TeamBroadcast.html',
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      laneIcons: LANE_ICON_SVG,
      title: fresh.length ? '有人发起开黑' : '开黑人齐了',
      subText: fresh.length ? `${fresh.length} 个房在招人` : `${full.length} 个房已经满`,
      rooms: fresh.map(broadcastRoom),
      fullRooms: full.map(broadcastFullRoom)
    })
  } catch (error) {
    logger.error(`[开黑] 播报出图失败（这轮回落文字）：${error.message}`)
    return null
  }
}

/** 出图挂了时的播报文字版，信息与图一致 */
function buildBroadcastText (fresh, full) {
  return [...fresh.map(buildNewBroadcast), ...full.map(buildFullBroadcast)].join('\n\n────────\n\n')
}

/**
 * 拉一轮。
 * @returns {Promise<boolean>} 这轮成不成（决定下一轮用正常间隔还是退避）
 */
async function pollOnce () {
  if (pollState.polling) return true
  pollState.polling = true

  try {
    const sinceRev = loadTeamStore().rev
    const result = await teamList(sinceRev)

    if (!result.ok) {
      // 配置问题（令牌无效、服务端没升级）不该触发退避：它不是「暂时不通」，
      // 重试一万次也一样。只记一条日志，节流由 teamClient 的 warnOnce 管
      if (['not_ready', 'not_supported', 'bad_token', 'token_revoked', 'disabled'].includes(result.error)) {
        return true
      }
      return false
    }

    if (result.unchanged) {
      // 水位没动：服务端只回了几十字节，什么都不用做
      if (Number(result.rev) && Number(result.rev) !== sinceRev) {
        commitTeamStore(latest => { latest.rev = Number(result.rev) })
      }
      return true
    }

    const rooms = Array.isArray(result.rooms) ? result.rooms : []

    // 拉完列表**再**读状态：`#发起开黑` 当场记下的发起群可能刚落盘，
    // 读早了这轮会把那个房再往发起群播一遍
    const store = loadTeamStore()

    // ① 挑出这轮要播的：新房（还没播过「有人发起」）、刚满员的
    const freshRooms = rooms.filter(room => room.status === 'open' && !store.milestones[roomKey(room)])
    const fullRooms = rooms.filter(room => room.status === 'full' && store.milestones[roomKey(room)] !== 'full')

    const groups = broadcastGroups()
    // 群列表还没就绪（冷启动适配器没连上）→ 这轮不播、**也不推进水位**。
    // 推进了的话下一轮服务端回 unchanged，这些房就永远补不上了
    const canBroadcast = groups.length > 0

    if (canBroadcast && (freshRooms.length || fullRooms.length)) {
      // 收件人决策（新房广播哪些群、满员只发哪些群、每个群 @ 谁）在 teamStore 的
      // planBroadcast 里 —— 那是纯数据进出，脱机就能单测
      const plan = planBroadcast(groups, freshRooms, fullRooms, store)

      // 按**内容**给待发群分组：绝大多数群收到的内容一样，一轮只渲染一次，不是每群一次。
      // ⚠️ at 段不参与签名 —— 它按群拼（同一个群只 @ 本群的人），
      //    所以 targets 存的是「群号 -> 要 @ 的 QQ」
      const byContent = new Map()
      for (const [groupId, item] of plan) {
        const sig = `${item.fresh.map(roomKey).join(',')}|${item.full.map(roomKey).join(',')}`
        if (!byContent.has(sig)) {
          byContent.set(sig, { fresh: item.fresh, full: item.full, targets: new Map() })
        }
        byContent.get(sig).targets.set(groupId, item.ats)
      }

      for (const item of byContent.values()) {
        const image = await renderBroadcast(item.fresh, item.full)
        await broadcast([...item.targets.keys()], groupId => buildBroadcastMessage({
          fresh: item.fresh,
          full: item.full,
          ats: item.targets.get(groupId) || []
        }, image))
      }
    }

    // ② 本机发起的房：替发起人私聊通知新成员
    const notifiedNow = {}
    for (const room of (Array.isArray(result.mine) ? result.mine : [])) {
      const key = roomKey(room)
      const done = await notifyOwner(room, store.notified[key])
      if (done) notifiedNow[key] = done
    }

    // ③ 已经结束的房，本地那几张表里的记录要清掉（服务端留 2 分钟尾巴后就彻底删，
    //    不清的话 origins / notified 会一直攒着）。
    //    只清**这份快照里**有的、且建房超过 DROP_GRACE_MS 的：
    //    刚建的房可能是这轮列表生成之后才建的，不在列表里不代表结束了
    const live = new Set(rooms.filter(r => r.status === 'open' || r.status === 'full').map(roomKey))
    const now = Date.now()
    const dropKeys = [...new Set([
      ...Object.keys(store.origins),
      ...Object.keys(store.joins),
      ...Object.keys(store.notified)
    ])].filter(key => !live.has(key) && now - createdAtOf(key) > DROP_GRACE_MS)

    // ④ 落盘：本轮改动套到最新那份上（见 commitTeamStore 的说明）
    commitTeamStore(latest => {
      if (canBroadcast) {
        latest.rev = Number(result.rev) || latest.rev
        for (const room of freshRooms) {
          const key = roomKey(room)
          if (!latest.milestones[key]) latest.milestones[key] = 'new'
        }
        for (const room of fullRooms) latest.milestones[roomKey(room)] = 'full'
      }
      Object.assign(latest.notified, notifiedNow)
      for (const key of dropKeys) {
        delete latest.origins[key]
        delete latest.joins[key]
        delete latest.notified[key]
      }
    })

    return true
  } catch (error) {
    logger.error?.(`[开黑] 轮询出错：${error?.message || error}`)
    return false
  } finally {
    pollState.polling = false
  }
}

/** 失败退避：1 分钟起步翻倍，10 分钟封顶 */
function backoffMs (streak) {
  return Math.min(MAX_BACKOFF_MS, 60 * 1000 * Math.pow(2, Math.max(0, streak - 1)))
}

/**
 * 本模块这一代的身份。JiuLi 每次热重载都会把整张模块图重新求值，这里每次都是新的 Symbol。
 */
const GENERATION = Symbol('teamUp')

/**
 * 启动轮询：**这一代直接接管**，旧一代的链自己退出。
 *
 * ⚠️⚠️ 不能写成「全局上已经有定时器就 return」，也不能指望 `onUnload` 去停旧链（2026-10-15 线上踩到）。
 *    JiuLi 的 `loader.loadPlugin` 用**插件目录名**当 key 存 `initInstances`，47 个 app 挨个 set、
 *    后一个覆盖前一个，热重载时只回调**最后加载的那一个**实例的 `onUnload` —— TeamUp 的基本轮不到。
 *    于是旧链从没被停过，新一代看到全局上有定时器就 return，**线上一直跑着旧代码**：
 *    主人测试时旧代码只往「开着的群」名单里播（那份名单是空的），一个群都没收到，
 *    还把状态文件写回了旧格式。
 *
 *    现在不依赖卸载回调：新一代来了就清掉旧定时器、记下自己的身份；
 *    旧链如果正在跑，醒来对一下身份发现不是自己，就不再续下一拍。
 *    同一代构造两次（loader 会 new 两个实例）时第二次直接返回。
 */
function startPolling () {
  if (pollState.generation === GENERATION && pollState.timer) return

  if (pollState.timer) clearTimeout(pollState.timer)
  pollState.generation = GENERATION

  const tick = async () => {
    // 已经有更新的一代接管了：这条旧链到此为止
    if (pollState.generation !== GENERATION) return

    // ⚠️ 定时器里**绝不能把异常抛出去** —— 会掀掉整个云崽进程（同 gameRecordPush 的规矩）
    let ok = true
    try {
      if (shouldPoll()) {
        ok = await pollOnce()
        pollState.failStreak = ok ? 0 : pollState.failStreak + 1
      } else {
        pollState.failStreak = 0
      }
    } catch (error) {
      logger.error?.(`[开黑] 轮询出错：${error?.message || error}`)
      ok = false
      pollState.failStreak += 1
    }

    // 播报可能跑了好几分钟，这期间新一代可能已经接管了，别把它的定时器顶掉
    if (pollState.generation !== GENERATION) return
    pollState.timer = setTimeout(tick, ok ? POLL_MS : backoffMs(pollState.failStreak))
    pollState.timer.unref?.()
  }

  pollState.timer = setTimeout(tick, FIRST_POLL_MS)
  pollState.timer.unref?.()
}

/** 停掉轮询。只停**自己这一代**的，别把新一代刚接管的链也停了 */
function stopPolling () {
  if (pollState.generation !== GENERATION) return
  if (pollState.timer) clearTimeout(pollState.timer)
  pollState.timer = null
  pollState.generation = null
}

/* ────────────────────────── 查自己的段位 ────────────────────────── */

/**
 * 查发起人/加入人自己的段位、战斗力和**最高战力英雄**，贴到卡片上。
 *
 * 主人定的是「从营地现查」：开黑最关心的就是对方什么水平。
 *
 * ⚠️ 英雄取的是营地主页 mod 601「当前最高战力英雄」—— 它**本来就在这一次请求里**，
 *    不需要另外去拉 `#我的英雄` 的全量列表（`utils/profileSummary.js` 的 `topHero`）。
 *    英雄名要翻译（营地只给 heroId），走 `getHeroNameMap()`，那张表缓存 6 小时、
 *    走官网英雄总表、不吃营地配额。
 *
 * @returns {Promise<{campId, rank, power, roleName, icon, heroName, heroPower, heroIcon}>}
 */
async function selfIdentity (userId) {
  const blank = {
    campId: '', rank: '', power: 0, roleName: '', icon: '',
    heroName: '', heroPower: 0, heroIcon: ''
  }

  try {
    // 本机没绑的话，顺手问一次共享库（他可能在别的机器人上绑过）
    await resolveUserData(userId)
    const campId = getCurrentId(String(userId))
    if (!campId) return blank

    // 第二个参数是**发起人**：自己查自己的号才吃得到自我豁免
    // （别人来查会被隐私开关挡掉，见 utils/api.js 的 requesterBotUserId）
    const res = await ApiService.getProfile(String(campId), String(userId))
    const summary = summarizeProfile(res?.data)
    if (!summary) return { ...blank, campId }

    // 最高战力英雄：名字要翻译，图标由插件拼（模板算不了）
    const top = summary.topHero
    let heroName = ''
    if (top?.heroId) {
      const heroMap = await getHeroNameMap()
      heroName = heroMap?.[String(top.heroId)] || ''
    }

    return {
      campId,
      rank: rankText(summary.rank),
      power: summary.power || 0,
      roleName: summary.roleName || '',
      // ⚠️ 头像只用**营地头像**（roleIcon）。QQ 头像的 URL 里直接带着 QQ 号，
      //    而这个字段会进服务端的公开段、被播到十几个群 —— 等于从侧面凿穿隐私边界
      icon: summary.roleIcon || '',
      heroName,
      heroPower: top?.power || 0,
      heroIcon: heroIconUrl(top?.heroId)
    }
  } catch (error) {
    logger.debug?.(`[开黑] 查 ${userId} 的段位失败（不影响开黑）：${error?.message || error}`)
    return blank
  }
}

/** 群里显示用的名字：群名片 > QQ 昵称 > 游戏昵称 */
function displayName (e, roleName) {
  return String(
    e?.sender?.card || e?.sender?.nickname || roleName || '某位玩家'
  ).trim().slice(0, 24)
}

/* ────────────────────────── 指令 ────────────────────────── */

export class TeamUp extends plugin {
  /**
   * 插件卸载 / 热重载时清掉定时器。
   *
   * 框架支持这个钩子（`lib/core/loader.js` 的 `unloadPlugin` 会 await 它）。
   * 定时器本身已锚在 globalThis，这里再显式停一次，保证「卸载即停」，
   * 不依赖新代次是否恰好也启动了轮询。
   */
  async onUnload () {
    try {
      stopPolling()
      logger.debug?.('[开黑] 已停止轮询定时器（插件卸载）')
    } catch (error) {
      logger.debug?.(`[开黑] 卸载清理失败：${error?.message || error}`)
    }
  }

  constructor () {
    super({
      name: '王者开黑组队',
      dsc: '跨机器人发起/加入开黑',
      event: 'message',
      // 同 gameNews / whoIsPlaying：完整锚定的短指令要抢在 queryGameStats 的宽匹配前面
      priority: 0,
      rule: [
        // ⚠️ 六条都用 AT_HEAD 替掉硬 `^`：手打/粘贴出来的「@昵称」到 Bot 这边
        //    **只是纯文本**（真 at 段不会进 e.msg），它顶在指令前面时硬 `^#` 匹配不上，
        //    规则直接 continue —— 用户发出去**一句回应都没有**（同插件 gameNews /
        //    heroList / skinWall 都已踩过这条）。参数解析那头用 stripAtText 把它摘掉。
        { reg: `${AT_HEAD}#(发起开黑|开黑招人)\\s*(.*)$`, fnc: 'create' },
        { reg: `${AT_HEAD}#(加入开黑|加开黑)\\s*(.*)$`, fnc: 'join' },
        { reg: `${AT_HEAD}#退出开黑\\s*(\\d{2})?$`, fnc: 'leave' },
        { reg: `${AT_HEAD}#取消开黑\\s*(\\d{2})?$`, fnc: 'close' },
        { reg: `${AT_HEAD}#(开黑列表|开黑房间)$`, fnc: 'list' },
        {
          reg: `${AT_HEAD}#(开启|关闭)开黑广播$`,
          fnc: 'toggle',
          // admin 会自动放行主人，群里则要求管理员
          permission: 'admin'
        }
      ]
    })

    startPolling()
  }

  /** `#发起开黑 打野 缺辅助 3排 20:30` */
  async create (e) {
    if (!isTeamReady()) return e.reply(TEAM_NOT_READY_HINT, shouldQuote())

    const raw = stripAtText(e.msg).replace(/^#(发起开黑|开黑招人)\s*/, '')
    const parsed = parseCreate(raw)

    if (!parsed.size) {
      return e.reply(
        '要说几排，比如 #发起开黑 打野 缺辅助 3排 20:30',
        shouldQuote()
      )
    }

    const self = await selfIdentity(e.user_id)
    // 没绑营地ID 就不让发起（主人 2026-10-16 定）：这种人卡片上没有头像、没有段位、
    // 也没有最高战力英雄，别人看不出他什么水平，来的人多半白跑一趟
    if (!self.campId) return e.reply(NO_CAMP_HINT, shouldQuote())

    const result = await teamCreate({
      ownerQq: String(e.user_id),
      ownerName: displayName(e, self.roleName),
      ownerCampId: self.campId,
      ownerIcon: self.icon,
      ownerHeroName: self.heroName,
      ownerHeroPower: self.heroPower,
      ownerHeroIcon: self.heroIcon,
      ownerRank: self.rank,
      ownerPower: self.power,
      ownerLane: parsed.lane,
      needLanes: parsed.needLanes,
      size: parsed.size,
      note: parsed.note,
      expireAt: parsed.meetAt,
      meetText: parsed.meetText,
      ownerGroupId: String(e.group_id || ''),
      ownerGroupName: String(e.group_name || '').slice(0, 24)
    })

    if (!result.ok) return e.reply(result.message || '发起失败，稍后再试', shouldQuote())

    const room = result.room
    // 记下发起群和发起人：满员时这个群要收到播报、并 @ 发起人
    if (e.group_id) markOrigin(room, e.group_id, e.user_id)

    const lines = [
      `✅ 开黑已发起，编号 ${room.code}`,
      '',
      `${room.size} 排 · 你玩${room.ownerLane} · 缺${needText(room.needLanes, room.seats)}`
    ]
    if (room.meetText) lines.push(`约定时间：${room.meetText}（到点自动结束）`)
    const me = identityText(room.ownerRank, room.ownerPower)
    if (me) lines.push(me)
    lines.push('', `别人发 #加入开黑 ${room.code} [分路] 就能进来`, '有人来了会私聊告诉你')

    return e.reply(lines.join('\n'), shouldQuote())
  }

  /** `#加入开黑 12 辅助` */
  async join (e) {
    if (!isTeamReady()) return e.reply(TEAM_NOT_READY_HINT, shouldQuote())

    const raw = stripAtText(e.msg).replace(/^#(加入开黑|加开黑)\s*/, '')
    const { code, lane } = parseJoin(raw)

    if (!code) {
      return e.reply(
        '要带房号，比如 #加入开黑 12 辅助。发 #开黑列表 看现在有哪些房',
        shouldQuote()
      )
    }

    const self = await selfIdentity(e.user_id)
    // 同上：没绑营地ID 的不让加入，免得房里挂着一个没有头像和段位、联系上去也说不出水平的人
    if (!self.campId) return e.reply(NO_CAMP_HINT, shouldQuote())

    const result = await teamJoin({
      code,
      qq: String(e.user_id),
      name: displayName(e, self.roleName),
      campId: self.campId,
      icon: self.icon,
      heroName: self.heroName,
      heroPower: self.heroPower,
      heroIcon: self.heroIcon,
      rank: self.rank,
      lane
    })

    if (!result.ok) return e.reply(result.message || '加入失败，稍后再试', shouldQuote())

    // 记下「本机这个群里的谁进了这个房」：满员时只往这些群播、并 @ 这些人。
    // ⚠️ `createdAt` 是 roomKey 的一半（房号会循环复用），服务端没给就宁可不记 ——
    //    记成 `12:0` 的话满员时对不上，那个群会一条播报都收不到
    if (e.group_id && result.room?.createdAt) markJoin(result.room, e.group_id, e.user_id)

    const contact = result.contact || {}

    // 联系方式**只走私聊**：群里不出现任何 QQ 号和营地ID
    const privateLines = [
      `你加入了 ${code} 号房，打${lane}`,
      '',
      `发起人：${contact.name || '对方'}`,
      contact.rank ? `段位：${contact.rank}` : '',
      contact.campId ? `营地ID：${contact.campId}` : '',
      `QQ：${contact.qq || '未知'}`,
      contact.groupName ? `来自：${contact.groupName}` : ''
    ].filter(Boolean)

    const delivered = await sendPrivate(e.user_id, privateLines.join('\n'), {
      bot: e.bot,
      groupId: e.group_id
    })

    if (!delivered.ok) {
      /**
       * 私聊发不出去（他不是机器人好友）→ **把占位退掉**。
       *
       * 留着占位是最坏的结果：房里挂着一个联系不上的人，发起人以为凑齐了、
       * 其他人也挤不进那个分路，到点谁也没开上。退掉之后状态是干净的，
       * 他加完好友重发一次就行 —— 所以这里要把那条指令原样给他。
       */
      await teamLeave({ code, qq: String(e.user_id) })
      return e.reply(
        [
          '联系方式要私聊发给你，但现在发不出去。',
          '先加机器人好友，然后重发一次：',
          `#加入开黑 ${code} ${lane}`
        ].join('\n'),
        shouldQuote()
      )
    }

    const tip = result.full ? '人齐了，去游戏里组队吧' : '联系方式已私聊发你'
    return e.reply(`✅ 已加入 ${code} 号房，你玩${lane}\n${tip}`, shouldQuote())
  }

  /** `#退出开黑` / `#退出开黑 12` */
  async leave (e) {
    if (!isTeamReady()) return e.reply(TEAM_NOT_READY_HINT, shouldQuote())

    const code = (/^#退出开黑\s*(\d{2})?$/.exec(stripAtText(e.msg)) || [])[1] || ''
    const result = await teamLeave({ code, qq: String(e.user_id) })

    if (!result.ok) return e.reply(result.message || '退出失败，稍后再试', shouldQuote())

    return e.reply(
      result.cancelled ? '已取消你发起的开黑' : '已退出，位置让给别人了',
      shouldQuote()
    )
  }

  /** `#取消开黑` —— 只有发起人能取消 */
  async close (e) {
    if (!isTeamReady()) return e.reply(TEAM_NOT_READY_HINT, shouldQuote())

    const code = (/^#取消开黑\s*(\d{2})?$/.exec(stripAtText(e.msg)) || [])[1] || ''
    const result = await teamClose({ code, qq: String(e.user_id) })

    if (!result.ok) return e.reply(result.message || '取消失败，稍后再试', shouldQuote())

    return e.reply(`已取消 ${result.room?.code || ''} 号房`, shouldQuote())
  }

  /** `#开黑列表` —— 出图；出图失败退化成文字列表 */
  async list (e) {
    if (!isTeamReady()) return e.reply(TEAM_NOT_READY_HINT, shouldQuote())

    // since=0 强制拿全量：这是用户当场在问，不能受轮询水位影响
    const result = await teamList(0)
    if (!result.ok) return e.reply(result.message || '查不到，稍后再试', shouldQuote())

    // 最新发起的排前面 —— 刚开的房更可能还在等人
    const open = (result.rooms || [])
      .filter(room => room.status === 'open')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, LIST_MAX)

    const rooms = open.map(room => ({
      ...room,
      // ⚠️ 位置格**必须另起字段名，不能叫 `seats`** —— 服务端返回的 `room.seats` 是
      //    「还剩几个空位」的**数字**，覆盖掉之后下面 textList 里
      //    `needText(needLanes, room.seats)` 拿到的就是数组，`seats > 0` 恒为 false，
      //    「N 个位置都行」那句兜底文案永远出不来（降级路径静默少一行）
      seatList: buildSeats(room),
      // 只差一个人的房给一条金边，扫一眼就知道这个最该去补
      urgent: room.seats === 1,
      seatsText: room.seats > 0 ? `还差 ${room.seats} 人` : '人齐了',
      powerText: room.ownerPower ? room.ownerPower.toLocaleString('zh-CN') : ''
    }))

    const sample = rooms[0]
    const image = await this.shot(rooms, {
      total: (result.rooms || []).filter(room => room.status === 'open').length,
      sampleCode: sample?.code || '12',
      // 用例里的分路取第一个房真实的空缺，照着抄就能用
      sampleLane: joinHintOf(sample?.seatList.find(seat => seat.kind === 'empty')?.lane)
    })

    if (image) return e.reply(image, shouldQuote())

    return e.reply(this.textList(rooms), shouldQuote())
  }

  /** 出图。失败返回 null，由调用方回落到文字列表 */
  async shot (rooms, { total, sampleCode, sampleLane }) {
    try {
      return await puppeteer.screenshot('TeamList', {
        imgType: getImgType(),
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/TeamList.html',
        // 模板的 CSS / 字体都靠 {{_res_path}} 拼相对路径，漏了这项样式表 404，出的是纯文字图
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        // 分路图标的雪碧图，模板里 {{@laneIcons}} 原样注入
        laneIcons: LANE_ICON_SVG,
        title: '正在招人的开黑',
        subText: total > rooms.length
          ? `共 ${total} 个 · 只显示最近 ${rooms.length} 个`
          : `${total} 个房在等人`,
        rooms,
        sampleCode,
        sampleLane
      })
    } catch (error) {
      logger.error(`[开黑] 列表出图失败：${error.message}`)
      return null
    }
  }

  /** 出图挂了时的文字版 —— 信息要和图上一致，别少掉编号和缺口 */
  textList (rooms) {
    if (!rooms.length) {
      return '现在没人开黑，发 #发起开黑 打野 缺辅助 3排 来开一个'
    }

    const lines = [`🎮 正在招人的开黑（${rooms.length} 个）`, '']

    for (const room of rooms) {
      const head = [`[${room.code}] ${room.ownerName}`, room.ownerRank, `${room.size}排`]
        .filter(Boolean).join(' · ')

      lines.push(head)
      lines.push(`  他玩${room.ownerLane} · 缺${needText(room.needLanes, room.seats)}`)
      if (room.meetText) lines.push(`  约定 ${room.meetText}`)
      if ((room.joined || []).length) {
        lines.push(`  已来：${room.joined.map(m => `${m.name}(${m.lane})`).join('、')}`)
      }
      lines.push('')
    }

    lines.push('发 #加入开黑 [编号] [分路] 加入')

    return lines.join('\n')
  }

  /** `#开启开黑广播` / `#关闭开黑广播` —— 群管理或主人（permission: 'admin' 已拦） */
  async toggle (e) {
    if (!e.isGroup) {
      return e.reply('开黑广播要在群里开关（播报发到本群）', shouldQuote())
    }

    const enable = e.msg.includes('开启')
    const { changed } = setTeamSub(e.group_id, enable, {
      groupName: e.group_name || ''
    })

    if (!changed) {
      return e.reply(`本群的开黑广播本来就是${enable ? '开着' : '关着'}的`, shouldQuote())
    }

    return e.reply(
      enable
        ? '已开启本群开黑广播\n别的群有人发起开黑时会在本群播报；人齐了只播给参与过这个房的群\n发 #加入开黑 [编号] [分路] 就能跨群组队'
        : '已关闭本群开黑广播',
      shouldQuote()
    )
  }
}
