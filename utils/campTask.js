/**
 * 营地**福利中心**任务的纯解析（`#营地任务` / 签到后自动领取都用它）。
 *
 * ## 这块在修什么
 *
 * 用户反馈「签到了但营地币没到账」。实测对照（2026-10-10，号 1536597962）：
 * `/operation/action/newsignin` 只负责**签到动作本身**，福利中心那 25 枚营地币
 * 是另一条链路 —— 任务 `dailySigned` 变成 `finishStatus=1`，但 `packageStatus`
 * 还是 `0`（没领），币**不会自己到账**，必须再打一次 `/operation/action/rewardtask`。
 * 所以营地 App 里会出现截图那种「每日前往游戏专区签到(1/1)」后面还挂着「领取」按钮。
 *
 * ⚠️ **两个状态位缺一不可，别用其中一个推另一个**：
 *   · `finishStatus` 1 = 任务做完了
 *   · `packageStatus` 1 = 奖励**已经领了**
 *   「做完了」≠「领了」，这正是这个 bug 的全部成因。同理 `userScore/taskScore`
 *   只是进度展示（`1/1`），**不能**拿它当「已领取」的判据。
 *
 * 零 import，为了能脱开云崽运行时直接单测（`test/campTask.test.mjs`）。
 * 接口层见 `utils/api.js` 的 `getCampTaskList` / `claimCampTasks`。
 */

/**
 * 福利中心任务的 `gameId`。
 *
 * ⚠️ 是 **50001（营地自己）**，不是王者的 20001 —— 实测营地 App 的福利中心页
 * （`camp.qq.com/h5/webdist/welfare-center`）里五条任务的 `gameId` 全是 `50001`，
 * 连「每日前往游戏专区签到」这种明显跟游戏有关的也是。传 20001 也能查到同一批，
 * 但领取时的参数形态不一样（见 `rewardBody`），所以统一按 50001 走。
 */
export const CAMP_GAME_ID = '50001'

/** 业务码：成功 */
const CODE_OK = 0

/**
 * 资讯流里「资讯卡」的 `type` 值（实测 2026-10-10）。
 *
 * 同一个 `/info/followinfo` 里混着好几种卡：`2` 是普通动态、`3` 是长文帖子、
 * **`14` 才是资讯**。这个数不是猜的 —— 遍历那 10 条，只有 `type:14` 的带
 * `infoContent`，其余 `infoContent` 全是 `null`。
 */
const FEED_TYPE_INFO = 14

/**
 * 从 `/info/followinfo` 的 `list[]` 里挑一条**可用于做任务的资讯 ID**。
 *
 * 为什么不能写死一个：资讯会下架。`/info/detailinfo` 对失效 ID 回
 * `-115407 无效的资讯`（实测传 `iInfoId='1'` 就是这样），所以每轮都得现取。
 *
 * 挑法（按顺序，取第一个满足的）：
 *   ① `type === 14`（资讯卡）
 *   ② `infoContent.infoId` 非空
 *
 * ⚠️ 不做「取热门的」这类排序 —— 任务只要求「浏览 1 篇」，
 *    挑第一条能用的最省事，也最不容易因为字段缺失而挑空。
 *
 * @param {Array} feedList `/info/followinfo` 的 `data.list`
 * @returns {string} 资讯 ID；一条都没有时返回 `''`
 */
export function pickInfoId (feedList) {
  if (!Array.isArray(feedList)) return ''

  for (const item of feedList) {
    if (Number(item?.type) !== FEED_TYPE_INFO) continue
    const id = String(item?.infoContent?.infoId ?? '').trim()
    if (id) return id
  }

  return ''
}

/**
 * 一条任务 → 展示/决策用的统一形状。
 *
 * 字段取自实测响应（2026-10-10 真机原文，五条任务字段完全一致）：
 *   `taskId`（字符串，如 `'2024010800002'`）/ `title` / `desc` /
 *   `taskScore`（目标次数）/ `userScore`（已完成次数）/
 *   `finishStatus`（0|1）/ `packageStatus`（0|1）/ `currency`（营地币数量）/
 *   `func`（任务动作标识，如 `dailySigned`、`todayViewNews`）/ `gifts[]`
 *
 * @param {object} raw 接口里的一条
 * @returns {object|null} 认不出 taskId 的直接丢掉（没 id 就没法领）
 */
export function normalizeTask (raw) {
  const taskId = String(raw?.taskId ?? '').trim()
  if (!taskId) return null

  // ⚠️ 这几个状态位**必须按类型判**，不能直接 Number()：`Number(null)`、
  //    `Number('')`、`Number([])` 全是 0，字段缺失会被当成「未完成未领取」，
  //    于是每轮都去重复领一次（服务端会回错误码，但白吃请求、还可能撞频控）。
  const finished = isOne(raw?.finishStatus)
  const claimed = isOne(raw?.packageStatus)

  const need = toCount(raw?.taskScore)
  const done = toCount(raw?.userScore)

  return {
    taskId,
    func: String(raw?.func ?? '').trim(),
    title: String(raw?.title ?? '').trim() || '未命名任务',
    desc: String(raw?.desc ?? '').trim(),
    // 营地币数量。0 的任务是存在的（实测「关注作者」就是 0），别当成异常
    currency: toCount(raw?.currency),
    need,
    done,
    progressText: need > 0 ? `${done}/${need}` : '',
    finished,
    claimed,
    /**
     * **可领取** = 做完了 + 还没领。这是本插件唯一允许发领取请求的判据，
     * 不看进度文本、也不看 currency 大小。
     */
    claimable: finished && !claimed,
    jumpUrl: String(raw?.jumpUrl ?? '').trim(),
    gifts: normalizeGifts(raw?.gifts)
  }
}

/** `1` / `'1'` 才算真，其余（含缺字段、空串、空数组）一律假 */
function isOne (value) {
  if (typeof value === 'number') return value === 1
  if (typeof value === 'string') return value.trim() === '1'
  return false
}

/** 计数字段 → 非负整数，认不出按 0 */
function toCount (value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.max(0, n)
  }
  return 0
}

/**
 * 奖励列表 → `{ name, num }[]`。
 *
 * ⚠️ 字段是 `name` + `packageNum`（**数字**），跟签到那边 `giftList` 的
 * `giftText` + `giftNum`（**字符串**）不是一套，别指望统一
 * （见 `utils/campSign.js` 的 `describeGifts`）。
 */
function normalizeGifts (gifts) {
  const list = Array.isArray(gifts) ? gifts : []

  return list
    .map(gift => ({
      name: String(gift?.name ?? gift?.desc ?? '').trim(),
      num: toCount(gift?.packageNum)
    }))
    .filter(gift => gift.name)
}

/**
 * 解析 `/operation/action/tasklist` 的响应。
 *
 * 实测 `data` 的四个键：`taskList` / `extra` / `myCurrency` / `exchangeList`。
 * ⚠️ `myCurrency` 是**余额**，和 `/play/h5lotteryquery` 的 `userCurrencyCnt`
 *    同源（领取后两边同步变化，实测 25 → 50 ✓），所以查过任务就不用再查一次余额。
 *
 * @param {object} response 接口返回（整包，带 returnCode）
 * @returns {{ok: boolean, coin: number|null, tasks: object[], claimable: object[], failReason: string}}
 */
export function parseTaskList (response) {
  const code = response?.returnCode
  if (code !== CODE_OK && String(code) !== String(CODE_OK)) {
    return {
      ok: false,
      coin: null,
      tasks: [],
      claimable: [],
      failReason: cleanMsg(response?.returnMsg) || '任务列表读取失败'
    }
  }

  const data = response?.data || {}
  const tasks = (Array.isArray(data.taskList) ? data.taskList : [])
    .map(normalizeTask)
    .filter(Boolean)

  return {
    ok: true,
    // ⚠️ 读不到余额返回 null（= 不知道），不要兜成 0 —— 那会显示「0 枚」吓人
    coin: readCoin(data.myCurrency),
    tasks,
    claimable: tasks.filter(task => task.claimable),
    failReason: ''
  }
}

/** 余额字段 → 数字；认不出返回 null（表示「不知道」，不是 0） */
function readCoin (value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * 营地的错误文案前面常带一截码（`-105201:任务未找到`），直接甩给用户很难看。
 * 去掉前缀只留人话；去完是空就返回空串，让调用方用自己的兜底。
 */
export function cleanMsg (msg) {
  return String(msg ?? '').replace(/^-?\d+\s*[:：]\s*/, '').trim()
}

/**
 * 领取请求的 body。
 *
 * ⚠️ 形态由 `gameId` 决定（抄自营地福利中心页自己的 `getRewardReqParams`）：
 *   · `50001`（营地自己的任务）→ `mRoleIds` 必须是**空数组**，不带角色
 *   · 其它游戏 → 要带 `[{ roleId, gameId }]`
 * 福利中心这五条任务全是 50001，所以正常走的是空数组那一支。
 *
 * @param {string[]} taskIds
 * @param {string} [gameId]
 * @param {object} [role] 非 50001 时才用得到
 */
export function rewardBody (taskIds, gameId = CAMP_GAME_ID, role = null) {
  const ids = (Array.isArray(taskIds) ? taskIds : [])
    .map(id => String(id ?? '').trim())
    .filter(Boolean)

  if (String(gameId) === CAMP_GAME_ID) {
    return { taskIds: ids, mRoleIds: [] }
  }

  return {
    taskIds: ids,
    mRoleIds: [{ roleId: String(role?.roleId ?? ''), gameId: String(gameId) }]
  }
}

/**
 * 把一次领取的结果说成人话（私聊/图上都用这一份口径）。
 *
 * @param {object[]} claimed 这次真领到的任务
 * @returns {string} 形如 `每日前往游戏专区签到 +25`；没有就空串
 */
export function describeClaimed (claimed = []) {
  return claimed
    .filter(task => task?.title)
    .map(task => (task.currency > 0 ? `${task.title} +${task.currency}` : task.title))
    .join('、')
}

/**
 * 还没做完的任务 → 一行提示（告诉用户「还能再赚多少」）。
 *
 * ⚠️ 只列**还能拿到营地币**的（`currency > 0`）：实测「关注作者」给的是亲密玫瑰、
 *    `currency` 为 0，混在「还能赚 X 营地币」里会让数字对不上。
 */
export function describeTodo (tasks = []) {
  const todo = tasks.filter(task => !task.finished && task.currency > 0)
  if (!todo.length) return ''

  const total = todo.reduce((sum, task) => sum + task.currency, 0)
  return `还有 ${todo.length} 个任务没做（${todo.map(t => t.title).join('、')}），做完再得 ${total} 营地币`
}
