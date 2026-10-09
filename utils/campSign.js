/**
 * 营地签到里**跟营地协议绑定**的几段纯逻辑。
 *
 * 单独一个文件、**零 import**，是为了能脱开云崽运行时直接单测
 * （`test/campSign.test.mjs`）—— 签到这块的坑几乎全在「字段怎么解读」上，
 * 而不是在指令编排上，所以判据要能被钉住。
 *
 * 指令层见 `apps/signIn.js`，接口层见 `utils/api.js` 的
 * `getRoleList` / `getCampSignInfo` / `doCampSign`。
 */

/**
 * 周签到图 → 「今天签没签」。
 *
 * ⚠️⚠️ **下标是周一=0**（实测 2026-10-10 周六，主人号 `'0000010'`
 * 第 6 位（下标 5）是 1 ✓）。而 `Date.getDay()` 是**周日=0**，
 * 直接拿它当下标会**整体错一天** —— 周日会去读下标 0 那个「周一」的格子。
 * 所以必须 `(getDay() + 6) % 7` 换算。
 *
 * 图不合法（长度不是 7、或该位不是 `0`/`1`）返回 `null` = **不知道**，
 * 调用方要按「不知道」处理（照发 `newsignin`，让服务端自己判重），
 * **不能**当成「未签」也不能当成「已签」。
 *
 * @param {string} map 接口返回的 `data.weekSignMap`
 * @param {Date} [now] 便于测试注入
 * @returns {boolean|null} true=今天已签 / false=今天未签 / null=判不了
 */
export function isSignedToday (map, now = new Date()) {
  const text = String(map ?? '')
  if (text.length !== 7) return null

  const char = text[(now.getDay() + 6) % 7]
  if (char !== '0' && char !== '1') return null

  return char === '1'
}

/**
 * 本周还差几天满签：数图里还有几个 `'0'`。
 * 图不合法返回 `null`（不是 0！0 表示「已满签」）。
 *
 * @param {string} map `data.weekSignMap`
 * @returns {number|null}
 */
export function weekRemain (map) {
  const text = String(map ?? '')
  if (text.length !== 7) return null

  const zeros = text.split('').filter(char => char === '0').length
  return zeros
}

/**
 * 把一个 `weekSignMap` 摆成「周一到周日」的可读串，给日志/排查用。
 * 例：`'0000010'` → `'一二三四五✓日'` 里只标已签那几天。
 *
 * @param {string} map
 * @returns {string} 形如 `'周⑥'`；判不了时返回空串
 */
export function describeWeekMap (map) {
  const text = String(map ?? '')
  if (text.length !== 7) return ''

  const names = ['一', '二', '三', '四', '五', '六', '日']
  const signed = text.split('')
    .map((char, index) => (char === '1' ? names[index] : ''))
    .filter(Boolean)

  return signed.length ? `周${signed.join('、周')}` : '本周还没签过'
}

/**
 * 从一个账号的角色列表响应里挑「要签的那个角色」。
 *
 * `gameList` 里每个游戏一项，王者是 **`gameId === 20001`**。
 * ⚠️ 接口给的是**数字** 20001，所以必须 `String(...) === '20001'` ——
 * 直接 `=== 20001` 在营地偶尔回字符串时会漏，直接 `=== '20001'` 则永远不成立。
 *
 * 一个营地号在王者里可能有多个角色（不同区服），**只签第一个**：
 * 签到奖励发在「账号」而不是「单个角色」上，签哪个结果一样，
 * 挨个签只会多打请求、更容易撞 -105206 频控。
 *
 * @param {object} roleListResponse `/game/rolelist` 的响应
 * @returns {object|null} 角色对象（含 `roleId` / `roleName` / `areaId` / `serverId`）
 */
export function pickMainRole (roleListResponse) {
  const games = Array.isArray(roleListResponse?.gameList) ? roleListResponse.gameList : []
  const wzry = games.find(game => String(game?.gameId) === '20001')
  const roles = Array.isArray(wzry?.roles) ? wzry.roles : []

  return roles[0] || null
}

/**
 * 从 `newsignin` 的 `data.giftList` 拼一行「今日奖励」。
 *
 * 字段是 `giftText`（名字）+ `giftNum`（数量，**字符串**）。数量为 `'1'`
 * 时不显示 `x1`（实测奖励表里营地币是 `'25'`、体验卡是 `'1'`）。
 *
 * @param {object} data `newsignin` 响应的 `data`
 * @returns {string} 形如 `'东皇太一-东海龙王(1天) + 营地币x25'`；没有奖励时返回空串
 */
export function describeGifts (data) {
  const list = Array.isArray(data?.giftList) ? data.giftList : []
  if (!list.length) return ''

  return list
    .map(item => {
      const name = String(item?.giftText ?? item?.name ?? '').trim()
      if (!name) return ''
      const num = String(item?.giftNum ?? item?.packageNum ?? '').trim()
      return num && num !== '1' ? `${name}x${num}` : name
    })
    .filter(Boolean)
    .join(' + ')
}

/**
 * `newsignin` 的业务码 → 该怎么向用户交代。
 *
 * 这三个码都**不是**「猜的」——2026-10-10 逐组对照实测：
 *   · `0`        签到成功
 *   · `-105203`  今天已签过（**正常结果，不是失败**）
 *   · `-105206`  操作太频繁
 *   · `-105204`  看着像「未授权营地」，**实际是没传 `roleId`**
 *
 * ⚠️ 判据是「`roleId` 这个**键**不存在」，不是「值为空」：
 *    body=`{}` 回 `-105204`，而 body=`{"roleId":""}` 回的是
 *    `1:服务繁忙，请稍后再试`（完全另一个码）。所以上层传空值时
 *    必须**整个字段都不发**，见 `utils/api.js` 的 `doCampSign`。
 *
 * @param {number} code `returnCode`
 * @returns {'ok'|'already'|'too-fast'|'missing-role'|'error'}
 */
export function classifySignCode (code) {
  // ⚠️⚠️ 必须先做类型与空值守卫，**不能**直接 Number()。有两个坑：
  //    · `Number(null)` / `Number('')` 都是 **0**
  //    · `Number([])` **也是 0**（空数组走 toString → ''）
  //    于是「响应里压根没有 returnCode」或「字段被换了包法」这类异常，
  //    会一路被当成**签到成功**报给用户，还附带一个空的奖励行。
  //    这是单测当场抓到的（test/campSign.test.mjs 的 null / 空数组用例）。
  //    只认 number 和非空字符串，别的形状一律 error。
  if (typeof code === 'number') {
    return Number.isFinite(code) ? matchCode(code) : 'error'
  }
  if (typeof code !== 'string' || !code.trim()) return 'error'

  const numeric = Number(code)
  if (!Number.isFinite(numeric)) return 'error'

  return matchCode(numeric)
}

/** 数值码 → 分流结论。只给上面那个已校验过类型的地方用 */
function matchCode (numeric) {
  if (numeric === 0) return 'ok'
  if (numeric === -105203) return 'already'
  if (numeric === -105206) return 'too-fast'
  if (numeric === -105204) return 'missing-role'

  return 'error'
}

/* ============================================================ 出图装配 */

/** 周一..周日的中文（下标 0 = 周一，跟 weekSignMap 对齐） */
const WEEK_NAMES = ['一', '二', '三', '四', '五', '六', '日']

/**
 * 把一周的奖励表（`weekList`）摊成「按周几索引」的 Map。
 *
 * `weekList` 每条形如 `{ date: 1, gift: [...] }`，`date` 是**周几**（1=周一 … 7=周日）。
 * 实测 2026-10-10 拿到的 7 条正是 `date` 1~7 各一条。
 *
 * ⚠️ 别用数组下标当周几 —— `date` 才是权威；服务端换顺序/缺某天时下标会错位。
 *
 * @param {object} info signinfo 的 `data`
 * @returns {Map<number, object[]>} date(1~7) → gift 数组
 */
export function indexWeekGifts (info) {
  const map = new Map()
  const list = Array.isArray(info?.weekList) ? info.weekList : []

  for (const day of list) {
    const date = Number(day?.date)
    if (!Number.isFinite(date) || date < 1 || date > 7) continue
    map.set(date, Array.isArray(day?.gift) ? day.gift : [])
  }

  return map
}

/**
 * 一个奖励对象 → 显示用的 `{ name, num, icon, desc }`。
 *
 * `gift` 里的字段名：`name`（「营地币」）/ `packageNum`（25）/ `iconUrl` / `desc`。
 * ⚠️ 注意和 `newsignin` 的 `giftList` **不是同一套字段** ——
 * 那边是 `giftText` / `giftNum`（**字符串**）。两套都写在 `describeGifts` 与这里，
 * 别指望统一。
 */
function normalizeGift (gift) {
  const name = String(gift?.name ?? gift?.giftText ?? '').trim()
  const num = String(gift?.packageNum ?? gift?.giftNum ?? '').trim()
  const icon = String(gift?.iconUrl ?? gift?.giftIconUrl ?? '').trim()
  // ⚠️ 营地的 desc 里自带 `##` 分隔符，形如
  //    「墨子-金属风暴3天体验卡*1##打开必得墨子-金属风暴3天体验卡*1」
  //    前半是简写、后半是完整说明。直接把整串画进图上就是一行带 `##` 的怪东西，
  //    所以**只取第一段**（短，适合当小字）。
  const rawDesc = String(gift?.desc ?? gift?.giftDesc ?? '').trim()
  const desc = rawDesc.split('##')[0].trim()

  return { name, num, icon, desc }
}

/**
 * 格子里的奖励摘要。
 *
 * 格子的宽度只够放几个字，所以：
 *   · 去掉括号里的天数（「东皇太一-东海龙王(1天)」→「东皇太一-东海龙王」）——
 *     不然会在「(1 / 天)」中间断行，看着像乱码
 *   · 多个奖励用「|」连，再按总长截断
 */
function giftSummary (gifts, maxLength = 22) {
  const names = (gifts || [])
    .map(gift => normalizeGift(gift).name.replace(/[（(][^）)]*[）)]/g, '').trim())
    .filter(Boolean)
  if (!names.length) return ''

  const text = names.join('|')
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

/**
 * 组装出图要的全部数据 + 出图失败时的文字兜底。
 *
 * 单独抽出来是因为这里全是**取舍**（哪个号算成功、格子怎么标、进度条多长），
 * 放在 app 里就只能靠肉眼验收；抽出来就能被 `test/campSign.test.mjs` 钉住。
 *
 * @param {object} opts
 * @param {Array<object>} opts.views 每个账号一条，见 apps/signIn.js 里的构造
 * @param {'sign'|'status'} opts.mode
 * @param {number} [opts.okCount] 本次真签成功的号数
 * @param {number} [opts.alreadyCount] 本来就已签的号数
 * @param {number} [opts.failCount] 失败的号数
 * @param {string} [opts.avatar]
 * @param {string} [opts.username]
 * @param {Date} [opts.now]
 * @returns {object} 直接喂给模板
 */
export function buildSignView ({
  views = [], mode = 'sign', okCount = 0, alreadyCount = 0, failCount = 0,
  noRoleCount = 0, avatar = '', username = '', now = new Date()
} = {}) {
  const todayIndex = (now.getDay() + 6) % 7   // 周一=0
  const isSign = mode === 'sign'

  const accounts = views.map(view => {
    const info = view.info || {}
    const map = String(info.weekSignMap || '')
    const valid = map.length === 7
    const weekGifts = indexWeekGifts(info)

    const days = WEEK_NAMES.map((weekName, index) => {
      const done = valid && map[index] === '1'
      const isToday = index === todayIndex
      const isFuture = index > todayIndex

      let cls = ''
      if (done) cls = 'done'
      else if (isToday) cls = 'today-pending'
      else if (isFuture) cls = 'future'
      if (isToday && done) cls += ' today-done'

      return {
        week: weekName,
        // 已签打勾、未签打点；今天那格额外带角标
        mark: done ? '✓' : '·',
        gift: giftSummary(weekGifts.get(index + 1)) || (isFuture ? '' : '——'),
        cls: cls.trim(),
        tag: isToday ? '今天' : ''
      }
    })

    // 本次真签拿到的奖励（只有签成功的号才有）
    const gifts = (view.signGifts || []).map(normalizeGift).filter(gift => gift.name)

    // 累计签到档位：totalList 每条的 gift[0] 是奖励，用 userTotalSign 比它的门槛
    const totalList = Array.isArray(info.totalList) ? info.totalList : []
    const totalSign = Number(info.userTotalSign || 0)
    const totals = totalList.map(entry => {
      const first = normalizeGift((entry?.gift || [])[0] || {})
      const need = Number(entry?.date ?? entry?.days ?? 0) || 0
      const percent = need > 0 ? Math.min(100, Math.round(totalSign / need * 100)) : 0

      return {
        days: need,
        name: first.name,
        desc: first.desc,
        percent,
        cls: totalSign >= need && need > 0 ? 'reached' : '',
        statusClass: totalSign >= need && need > 0 ? 'ok' : 'no',
        statusText: totalSign >= need && need > 0 ? '已达成' : `还差 ${Math.max(0, need - totalSign)} 天`
      }
    }).filter(entry => entry.name)

    return {
      name: view.name,
      campId: view.campId,
      stateClass: view.stateClass,
      stateText: view.stateText,
      roleName: view.roleName ? `角色：${view.roleName}` : '',
      // 有没有有效的本周签到图。拿不到状态的号（查询失败 / 没绑角色）不画那排格子 ——
      // 一排空「——」既没信息、又把图撑得很长
      hasWeek: valid && !view.failReason,
      weekSignMap: map,
      days,
      gifts,
      totals,
      // 失败原因 / 频繁提示这类话，放在账号块底部
      note: view.failReason || ''
    }
  })

  // 头部四格
  const signedTodayCount = accounts.filter(a => a.stateText === '今天已签' || a.stateText === '签到成功').length
  const maxSeq = Math.max(0, ...views.map(v => Number(v.info?.seqSignDays || 0)))
  const totalSignMax = Math.max(0, ...views.map(v => Number(v.info?.userTotalSign || 0)))

  /**
   * 第四格：本次真签拿到的奖励条数。
   *
   * ⚠️ 已签的号「今日奖励」必然是 0（没有 `signGifts`），显示一个大大的 `0`
   *    看着像出错了。所以没签成功任何号时改成显示**本周还差几天满签** ——
   *    那才是这时候用户真正关心的数。取所有号里**最少**的那个（最乐观口径）。
   */
  const weekRemains = accounts
    .filter(a => a.hasWeek)
    .map(a => a.weekSignMap.split('').filter(char => char === '0').length)

  const hasReward = okCount > 0
  const quadVal = hasReward
    ? accounts.reduce((sum, a) => sum + a.gifts.length, 0)
    : (weekRemains.length ? Math.min(...weekRemains) : '—')
  const quadKey = hasReward ? '今日奖励' : '本周还差'

  const dateText = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  /**
   * 副标题（右上角那句）。
   *
   * ⚠️⚠️ **「没绑王者角色的号」根本不会传进来**（2026-10-10 主人要求「静默跳过」）：
   *    调用方（`apps/signIn.js`）在 `#render` 之前就 `filter(v => !v.noRole)` 掉了。
   *    所以这里的 `noRoleCount` **恒为 0**，那个分支是**历史遗留**：
   *    早先的做法是「照常列出、标红、说明原因」，主人看过图之后明确要求改成静默。
   *
   *    保留参数与分支而不是删掉，是因为 `buildSignView` 是**纯函数、有单测**，
   *    删参数会让 `test/campSign.test.mjs` 里那批「noRoleCount 不该并进 failCount」
   *    的用例失去意义 —— 而那条判据本身（**没角色 ≠ 失败**）依然成立，
   *    只是现在连计数都不需要了。将来若改回「要显示」也不用重写。
   */
  let subText = ''
  if (!isSign) {
    subText = '只看不签'
  } else if (okCount > 0) {
    subText = `签上 ${okCount} 个`
  } else if (failCount === 0 && alreadyCount > 0) {
    subText = '今天都已签过'
  } else if (failCount === 0 && noRoleCount > 0) {
    subText = '能签的号都签过了'
  } else if (failCount > 0) {
    subText = `${failCount} 个没签上`
  }

  const todayVal = signedTodayCount > 0 ? '已签' : (views.length ? '未签' : '—')

  return {
    title: isSign ? '营地签到' : '签到状态',
    subText,
    dateText,
    avatar,
    username: String(username || ''),
    accountCount: accounts.length,
    todayVal,
    todayClass: signedTodayCount > 0 ? 'gold' : 'bad',
    maxSeq,
    totalSign: totalSignMax,
    giftCount: quadVal,
    giftKey: quadKey,
    accounts,
    emptyText: '名下还没有可用的营地号',
    footText: '奖励发在营地账号上，一个号签一次；数据来自王者营地',
    textFallback: buildSignText({ views, mode, okCount, alreadyCount, failCount, noRoleCount, now })
  }
}

/**
 * 出图失败时的纯文字兜底。
 *
 * ⚠️ 这条路径**必须完整**：签到是写操作，图挂了也不能让用户不知道签上没有。
 * 所以每个号的状态、连续天数、本次拿到的奖励都要写全。
 */
export function buildSignText ({ views = [], mode = 'sign', okCount = 0, alreadyCount = 0, failCount = 0, noRoleCount = 0, now = new Date() } = {}) {
  const isSign = mode === 'sign'
  const lines = [isSign ? '王者营地签到' : '王者营地签到状态']

  for (const view of views) {
    const info = view.info || {}
    const parts = [`${view.name}（${view.campId}）`]

    if (view.failReason) {
      parts.push(`${view.stateText}：${view.failReason}`)
    } else {
      parts.push(view.stateText)
      if (info.seqSignDays !== undefined) parts.push(`连续 ${info.seqSignDays} 天`)
      if (info.userTotalSign !== undefined) parts.push(`累计 ${info.userTotalSign} 天`)
    }

    lines.push(parts.join('，'))

    const gifts = (view.signGifts || []).map(normalizeGift).filter(g => g.name)
    if (gifts.length) {
      lines.push(`　今日奖励：${gifts.map(g => (g.num && g.num !== '1' ? `${g.name}x${g.num}` : g.name)).join(' + ')}`)
    }
  }

  if (isSign) {
    const summary = []
    if (okCount) summary.push(`${okCount} 个签到成功`)
    if (alreadyCount) summary.push(`${alreadyCount} 个本来已签`)
    // 没绑角色的号单独说 —— 并进「失败」会吓人（见 buildSignView 的注释）
    if (noRoleCount) summary.push(`${noRoleCount} 个没绑王者角色（签不了，正常）`)
    if (failCount) summary.push(`${failCount} 个失败`)
    if (summary.length) lines.push('', summary.join('，'))
  }

  lines.push('', `（${now.getMonth() + 1}月${now.getDate()}日，出图失败，先用文字版）`)
  return lines.join('\n')
}

