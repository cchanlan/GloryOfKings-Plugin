/**
 * 开黑指令的文本解析：分路别名、几排、约定时间。
 *
 * ## 为什么单独一个文件
 *
 * 这部分是纯函数、没有任何 I/O，也是整个功能里**最容易出错**的一块
 * （用户会写「缺辅助发育」「3排」「晚上8点半」各种花样）。拆出来才能脱机把
 * 几十种输入一次跑完，不用每改一次就去群里发指令试。
 *
 * ## 顺序无关
 *
 * `#发起开黑 打野 缺辅助 3排 20:30` 和 `#发起开黑 3排 20:30 打野 缺辅助`
 * 必须都认。所以不写成「第几个参数是什么」，而是**分词后逐个认类型** ——
 * 用户记不住参数顺序，而这功能的用户是在赶着上线打游戏的人。
 */

/** 五个分路的标准名。和服务端 team.mjs 的 LANES 必须一字不差 */
export const LANES = ['对抗路', '中路', '打野', '发育路', '辅助']
export const LANE_ANY = '都行'

/**
 * 分路别名。
 *
 * ⚠️ 别名表**只在这里**维护：服务端只认标准名，归一在插件端做。
 *    散成两处必然漂移（同锅巴 utils/account.js 那条教训）。
 *
 * 单字别名（上/中/下/野/辅）是刻意留的 —— 群里打字就是这么短。
 * 它们只在**整个词**相等时才匹配，所以不会把备注里的字吃掉。
 */
const LANE_ALIAS = {
  对抗路: ['对抗路', '对抗', '上路', '上单', '边路', '单带', '上'],
  中路: ['中路', '中单', '中间', '法师', '中'],
  打野: ['打野', '野王', '刺客', '野'],
  发育路: ['发育路', '发育', '下路', '射手', 'adc', 'ad', '下'],
  辅助: ['辅助', '游走', '奶妈', '辅', '奶']
}

/** 「都行」的说法。缺人的时候总有人不挑位置 */
const ANY_ALIAS = ['都行', '都可以', '随便', '任意', '随意', '无所谓', '都能']

/**
 * 认一个词是哪个分路。
 * @returns {string} 标准名 / `都行` / 空串（不是分路）
 */
export function matchLane (raw) {
  const text = String(raw || '').trim().toLowerCase()
  if (!text) return ''
  if (ANY_ALIAS.includes(text)) return LANE_ANY

  for (const [lane, alias] of Object.entries(LANE_ALIAS)) {
    if (alias.includes(text)) return lane
  }
  return ''
}

/**
 * 从一段**连写**的文本里扫出所有分路（「缺辅助发育」→ 辅助 + 发育路）。
 *
 * 用户写缺口时极少加分隔符。按别名长度从长到短扫并挖掉命中的部分，
 * 避免「发育路」先被「下」或「发育」切碎。
 *
 * ⚠️ 返回顺序是**用户写的顺序**，不是扫描顺序。扫描必须从长别名开始
 *    （否则「发育路」会被切碎），但那个顺序和用户写的无关 ——
 *    「缺辅助发育」会先命中「发育」，输出成「缺发育路、辅助」，
 *    群里看着就像机器人没听懂。所以记下命中位置，最后按位置排。
 *
 * ⚠️ 挖字必须**等长替换**：换成单个空格会让字符串变短，
 *    后面命中的位置就跟前面的不可比，排序结果是乱的。
 */
export function scanLanes (raw) {
  let text = String(raw || '').trim().toLowerCase()
  if (!text) return []

  const entries = []
  for (const [lane, alias] of Object.entries(LANE_ALIAS)) {
    for (const name of alias) entries.push({ lane, name })
  }
  // 长的先扫 —— 「发育路」必须赢过「发育」和「下」
  entries.sort((a, b) => b.name.length - a.name.length)

  const found = []
  for (const { lane, name } of entries) {
    const at = text.indexOf(name)
    if (at < 0) continue
    if (!found.some(item => item.lane === lane)) found.push({ lane, at })
    // 挖掉已命中的片段（等长，保持后续位置可比），别让它被更短的别名二次命中
    text = text.slice(0, at) + ' '.repeat(name.length) + text.slice(at + name.length)
  }

  if (!found.length && ANY_ALIAS.some(a => String(raw).includes(a))) return [LANE_ANY]

  return found.sort((a, b) => a.at - b.at).map(item => item.lane)
}

/**
 * 认「几排」。
 * @returns {number} 2~5，认不出返回 0
 */
export function matchSize (raw) {
  const text = String(raw || '').trim()
  if (!text) return 0

  const cn = { 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 }
  const m = /^([2-5]|[二两三四五])\s*(排|人|黑)?$/.exec(text)
  if (!m) return 0

  const n = cn[m[1]] ?? Number(m[1])
  return n >= 2 && n <= 5 ? n : 0
}

/**
 * 认游戏房间号。
 *
 * 两种写法都收：带前缀的（`房间号123456`、`房号 123456`）和**裸的 4~6 位数字** ——
 * 群友打字不会为这个专门加前缀，而 4 位以上的数字在这个指令里没有别的含义
 * （「3排」带排字、时间带点或冒号，都不会走到这里）。
 *
 * ⚠️ 上限定在 6 位：王者的开黑房间号是 6 位数，更长的多半是别人手机号之类的误输入，
 *    收进来会变成图上一串莫名其妙的数字。
 *
 * @returns {string} 认不出返回空串
 */
export function matchRoomNo (raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  const m = /^(?:房间号?|房号)?\s*(\d{4,6})$/.exec(text)
  return m ? m[1] : ''
}

/** 「房间号」这三个字单独出现时，数字在下个词里 */
const ROOM_PREFIX_RE = /^(房间号|房号|房间)$/

/** 两位补零 */
function pad (n) {
  return String(n).padStart(2, '0')
}

/**
 * 认约定时间。
 *
 * 支持三类写法：
 *   · 绝对钟点：`20:30` `20：30` `20.30` `20点30` `20点半` `8点`
 *   · 相对时长：`半小时后` `30分钟后` `1小时后` `20分后`
 *   · 「马上/现在」—— 当成没约时间（走服务端默认的 30 分钟）
 *
 * ## 12 小时制的歧义怎么办
 *
 * 用户说「8点」时，绝大多数情况指的是**晚上**（开黑是晚上的事）。
 * 所以小时数 ≤ 12 时：当天那个钟点已经过了，先试 +12 小时（当天傍晚/晚上），
 * 还过了才排到明天。实测这个启发式对「现在 14:00，约 8 点」给出 20:00 —— 正是用户的意思。
 *
 * ## 为什么要同时返回文本
 *
 * `at` 是绝对毫秒，给服务端判过期；`text` 是给人看的，**由发起人这台机器算一次**，
 * 所有群显示同一个值。各接入方自己格式化的话，时区不一致的机器会显示成不同的钟点，
 * 而群友是照着这个钟点去上线的。
 *
 * @returns {{at: number, text: string}|null} 认不出返回 null
 */
export function parseMeetAt (raw, now = Date.now()) {
  const text = String(raw || '').trim()
  if (!text) return null

  // 「马上」= 不约时间
  if (/^(马上|现在|立刻|即刻|随时)$/.test(text)) return { at: 0, text: '' }

  // ── 相对时长 ──
  const half = /^半\s*(个)?\s*(小时|钟头)后?$/.exec(text)
  if (half) return { at: now + 30 * 60 * 1000, text: '30 分钟后' }

  const rel = /^(\d{1,3})\s*(个)?\s*(分钟|分|小时|钟头|时)\s*(后|之后)?$/.exec(text)
  if (rel) {
    const n = Number(rel[1])
    const isHour = /小时|钟头|^时$/.test(rel[3])
    if (!n) return null
    const ms = isHour ? n * 3600 * 1000 : n * 60 * 1000
    return { at: now + ms, text: isHour ? `${n} 小时后` : `${n} 分钟后` }
  }

  // ── 绝对钟点 ──
  // 「20点半」单独认一下，半 = 30 分
  const halfPast = /^(\d{1,2})\s*点\s*半$/.exec(text)
  const clock = halfPast
    ? { h: Number(halfPast[1]), m: 30 }
    : (() => {
        const m = /^(\d{1,2})\s*(?:[:：.]|点)\s*(\d{1,2})?\s*(?:分)?$/.exec(text)
        if (!m) return null
        return { h: Number(m[1]), m: Number(m[2]) || 0 }
      })()

  if (!clock) return null
  if (clock.h > 23 || clock.m > 59) return null

  const base = new Date(now)
  const target = new Date(base.getFullYear(), base.getMonth(), base.getDate(), clock.h, clock.m, 0, 0)

  let at = target.getTime()
  let label = `${pad(clock.h)}:${pad(clock.m)}`

  if (at <= now && clock.h <= 12) {
    // 「8点」在下午说出来，指的是晚上 8 点
    const evening = at + 12 * 3600 * 1000
    if (evening > now) {
      at = evening
      label = `${pad(clock.h + 12)}:${pad(clock.m)}`
    }
  }

  if (at <= now) {
    // 今天这个点过了 → 明天
    at += 24 * 3600 * 1000
    label = `明天 ${label}`
  }

  return { at, text: label }
}

/**
 * 解析 `#发起开黑` 后面那串。
 *
 * ## 第一个分路是自己的，后面几个是缺的
 *
 * `#发起开黑 发育 辅助 打野 3排` = 我玩发育、缺辅助和打野。
 * 群友就是这么写的（顺序写下来，不写「缺」字），所以第二个及以后的分路一律当缺口 ——
 * ⚠️ 早先这里只取第一个分路当自己的位置，**其余的被当成备注丢进 `note`**，
 *    于是「发育 辅助 打野 3排」被解析成「你玩发育路 · 缺 2 个位置都行」，
 *    图上两个空位都标「都行」—— 群里看着就像机器人没听懂（2026-10-16 主人报的）。
 * 「都行」不算缺口（它本来就不是分路），继续留在备注里。
 *
 * @returns {{lane: string, needLanes: string[], size: number, meetAt: number,
 *            meetText: string, roomNo: string, note: string}}
 */
export function parseCreate (raw) {
  const tokens = String(raw || '').trim().split(/[\s,，、]+/).filter(Boolean)

  let lane = ''
  const needLanes = []
  let size = 0
  let meetAt = 0
  let meetText = ''
  let roomNo = ''
  /** 上一个词是光秃秃的「房间号」，下一个数字要当房间号 */
  let wantRoomNo = false
  const rest = []

  for (const token of tokens) {
    // 「缺辅助发育」—— 缺口可以连写好几个
    const need = /^(缺|差|少|招|找)(.*)$/.exec(token)
    if (need && need[2]) {
      for (const found of scanLanes(need[2])) {
        if (found !== LANE_ANY && !needLanes.includes(found)) needLanes.push(found)
      }
      continue
    }

    const n = matchSize(token)
    if (n && !size) {
      size = n
      continue
    }

    const meet = parseMeetAt(token)
    if (meet && !meetAt && meet.at) {
      meetAt = meet.at
      meetText = meet.text
      continue
    }
    // 「马上」这类明确表示「不约时间」的，吃掉但不设值
    if (meet && !meet.at) continue

    // 房间号：「房间号123456」/「房号 123456」/ 裸的 4~6 位数字
    if (wantRoomNo) {
      const pending = matchRoomNo(token)
      if (pending) {
        roomNo = pending
        wantRoomNo = false
        continue
      }
      wantRoomNo = false
      // 落空就把它当普通词继续走下面的判断（「房间号 3排」这种写错了也别整条指令作废）
    }
    if (!roomNo && ROOM_PREFIX_RE.test(token)) {
      wantRoomNo = true
      continue
    }
    const room = matchRoomNo(token)
    if (room && !roomNo) {
      roomNo = room
      continue
    }

    const matched = matchLane(token)
    if (matched) {
      // 第一个分路是发起人自己的位置
      if (!lane) {
        lane = matched
        continue
      }
      // 后面的都是缺的位置（见函数头）。
      // ⚠️ 排除**他自己那个位置**：手滑写两遍「打野 打野 3排」时，
      //    不能把这个重复项当成「缺打野」——那会和「他玩打野」自相矛盾
      if (matched !== LANE_ANY && matched !== lane && !needLanes.includes(matched)) {
        needLanes.push(matched)
        continue
      }
    }

    rest.push(token)
  }

  // 「N 排」最多只要 N-1 个人，缺口列多了按前几个算
  if (size && needLanes.length > size - 1) needLanes.length = size - 1

  return {
    lane: lane || LANE_ANY,
    needLanes,
    size,
    meetAt,
    meetText,
    roomNo,
    note: rest.join(' ').slice(0, 40)
  }
}

/**
 * 解析 `#加入开黑` 后面那串：房号 + 分路。顺序无关。
 *
 * 房号是**两位数字**（服务端编号就是 10~99），所以它和「3排」这类不会撞。
 *
 * @returns {{code: string, lane: string}}
 */
export function parseJoin (raw) {
  const tokens = String(raw || '').trim().split(/[\s,，、]+/).filter(Boolean)

  let code = ''
  let lane = ''

  for (const token of tokens) {
    const m = /^(\d{2})$/.exec(token)
    if (m && !code) {
      code = m[1]
      continue
    }
    const matched = matchLane(token)
    if (matched && !lane) lane = matched
  }

  // 「12打野」连写也要认 —— 群里打字不爱加空格
  if (!code || !lane) {
    const joint = /^(\d{2})\s*(.+)$/.exec(String(raw || '').trim())
    if (joint) {
      if (!code) code = joint[1]
      if (!lane) lane = matchLane(joint[2]) || scanLanes(joint[2])[0] || ''
    }
  }

  return { code, lane: lane || LANE_ANY }
}
