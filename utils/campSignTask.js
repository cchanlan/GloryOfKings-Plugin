/**
 * 营地签到的**账号编排层**：探一个号的状态、给一个号签一次、给一批号签一轮。
 *
 * 抽出来是因为有**三个调用方**：
 *   · `apps/signIn.js` 的 `#王者签到` 指令（谁发指令就给谁名下的号签，结果回原会话）
 *   · `apps/signIn.js` 的 `#王者签到状态`（只看不签）
 *   · `apps/signIn.js` 的每日定时任务（给池子里所有号签，结果**私聊各自的号主**）
 *
 * 三边的差异只有「签不签」和「结果送哪」，**「查角色 → 查状态」这套顺序必须只有一份** ——
 * 否则它会在多处漂移，而它恰好是踩过坑的地方（不带 `roleId` 会回骗人的 -105204）。
 *
 * 零云崽依赖（只 import 纯逻辑 + api），可以脱开运行时单测。
 */
import apiService from './api.js'
import { isSignedToday, pickMainRole, classifySignCode } from './campSign.js'
import { parseTaskList, rewardBody, describeClaimed } from './campTask.js'
import { completeDailyTasks, describeActed } from './campDailyTask.js'

/**
 * 领一遍这个号在**福利中心**已完成但还没领的任务奖励。
 *
 * ## 为什么签到之后还要来这一趟
 *
 * `newsignin` 只是把「每日前往游戏专区签到」这个任务**做掉**
 * （`finishStatus` 变 1），那 25 枚营地币**不会自己到账** —— 福利中心页面上
 * 会一直挂着「领取」按钮，这就是用户反馈的「签到了但没领到」。
 * 币要再打一次 `/operation/action/rewardtask` 才进账（实测领完余额 25→50 ✓）。
 *
 * ## 为什么顺手把别的任务也领了
 *
 * 浏览资讯 / 点赞 / 分享这些任务，用户在营地 App 里做过之后同样只是
 * `finishStatus=1`，奖励照样躺着。既然已经拉了一次任务列表，**凡是
 * `claimable`（做完了 + 没领）的一起领**比只领签到那条更符合预期，
 * 也不多花请求（领取接口本身支持一次传多个 taskId）。
 *
 * ⚠️ **只领、不替用户做任务**：没做完的任务这里一律不碰 ——
 *    「浏览」「点赞」「分享」要真的去点别人的内容，那是替用户产生社交行为，
 *    不是签到该干的事。
 *
 * **不抛异常**：领取失败不该让「签到成功」这件事看起来像失败了。
 *
 * @param {string} campId 营地号
 * @returns {Promise<{claimed: object[], coin: number|null, todo: object[], failReason: string}>}
 */
export async function claimTaskRewards (campId) {
  const empty = { claimed: [], coin: null, todo: [], failReason: '' }

  let view
  try {
    view = parseTaskList(await apiService.getCampTaskList(campId))
  } catch (error) {
    globalThis.logger?.warn?.(`[营地任务] ${campId} 拉任务列表失败: ${error?.message || error}`)
    return { ...empty, failReason: apiService.formatUserFacingError(error) }
  }

  if (!view.ok) return { ...empty, failReason: view.failReason }

  const todo = view.tasks.filter(task => !task.finished)
  if (!view.claimable.length) {
    return { claimed: [], coin: view.coin, todo, failReason: '' }
  }

  try {
    const res = await apiService.claimCampTasks(
      campId,
      rewardBody(view.claimable.map(task => task.taskId))
    )

    if (res?.returnCode !== 0 && String(res?.returnCode) !== '0') {
      globalThis.logger?.warn?.(`[营地任务] ${campId} 领取失败: ${res?.returnCode} ${res?.returnMsg || ''}`)
      return { claimed: [], coin: view.coin, todo, failReason: '奖励领取失败' }
    }
  } catch (error) {
    globalThis.logger?.warn?.(`[营地任务] ${campId} 领取异常: ${error?.message || error}`)
    return { claimed: [], coin: view.coin, todo, failReason: apiService.formatUserFacingError(error) }
  }

  const gained = view.claimable.reduce((sum, task) => sum + task.currency, 0)
  globalThis.logger?.info?.(`[营地任务] ${campId} 领取成功：${describeClaimed(view.claimable) || view.claimable.length + ' 个任务'}`)

  return {
    claimed: view.claimable,
    // ⚠️ 余额是**领取前**那一份，加上这次领到的才是现在的数 ——
    //    不为了显示一个数再多打一次请求（而且营地那边也有延迟）
    coin: view.coin === null ? null : view.coin + gained,
    todo,
    failReason: ''
  }
}

/**
 * 探一个营地号的**当前状态**（不发写请求）：查角色 + 查签到状态。
 *
 * ⚠️⚠️ **「没绑王者角色」的判据只能来自 `/game/rolelist`**（2026-10-10 实测对照）：
 *
 * | 号 | `20001.roles` | `signinfo.weekSignMap` | `seqSignDays` |
 * |---|---|---|---|
 * | 没绑角色的号 | `[]` ← **只有这里能看出来** | `'0000000'` | `0` |
 * | 有角色但**从没签过**的新号 | 有 | `'0000000'` | `0` |
 *
 * 两者在 `signinfo` 上**完全一样** —— 拿 `weekSignMap === '0000000'` 当「没角色」的判据，
 * 会把「刚绑好角色、还没签过」的号误判成没角色、静默跳过，用户永远等不到它开始签。
 * 所以「静默跳过没角色的号」这个需求（2026-10-10 主人要求）**必须多打一次 rolelist**，
 * 这次请求省不掉。
 *
 * @param {string} campId 营地号（账号池里的 userId）
 * @param {object} [opts]
 * @param {string} [opts.name] 显示名（不给就只用 campId）
 * @returns {Promise<object>} view —— `{ name, campId, stateClass, stateText, info?, role?, roleName?, signedToday?, already?, noRole?, failReason? }`
 */
export async function probeAccount (campId, { name } = {}) {
  const label = String(name || campId)

  // ① 角色列表 —— 没角色就到此为止（这是「静默跳过」的唯一判据来源）
  let role
  try {
    role = pickMainRole(await apiService.getRoleList(campId))
  } catch (error) {
    return fail(label, campId, '查询失败', apiService.formatUserFacingError(error), error)
  }

  if (!role?.roleId) {
    // ⚠️ 这一类**不是失败**：号没绑王者角色是结构性事实（主人 5 个号里 3 个如此）。
    //    调用方按 `noRole` **静默跳过**它 —— 不渲染、不告知、也不并进 failCount。
    return {
      name: label,
      campId,
      stateClass: 'fail',
      stateText: '没有王者角色',
      failReason: '这个营地号还没绑定王者角色，先在游戏里登录一次再来签',
      noRole: true
    }
  }

  // ② 签到状态
  let info
  try {
    info = (await apiService.getCampSignInfo(campId))?.data || {}
  } catch (error) {
    return fail(label, campId, '查询失败', apiService.formatUserFacingError(error), error, role)
  }

  const signed = isSignedToday(info.weekSignMap)

  return {
    name: label,
    campId,
    info,
    role,
    roleName: role.roleName,
    signedToday: signed,
    already: signed === true,
    // 判不了就别硬报「未签」
    stateClass: signed === null ? 'fail' : (signed ? 'done' : 'new'),
    stateText: signed === null ? '数据异常' : (signed ? '今天已签' : '今天还没签')
  }
}

/**
 * 给**一个**营地号签一次。
 *
 * 顺序（顺序本身就是踩坑的结论，别调换）：
 *   ① `/game/rolelist` 取 `roleId` —— `newsignin` **必需**，缺了会回那句骗人的
 *      `-105204 未授权营地，请前往游戏修改授权设置后重试`（看着像权限问题，实际是缺参数）
 *   ② `/operation/action/signinfo` 查今天签没签 —— 已签就**不发写请求**
 *      （少一次请求 = 少一分撞 -105206 频控的风险）
 *   ③ 没签才发 `newsignin`
 *
 * ①② 跟 `#王者签到状态` 共用 `probeAccount()` —— 两边各写一份必然漂移。
 *
 * **不抛异常**：任何失败都翻译成 `{ ok: false, stateText, failReason }`，
 * 好让「一个号挂了」不影响「另一个号能签」。
 *
 * @param {string} campId 营地号（账号池里的 userId）
 * @param {object} [opts]
 * @param {string} [opts.name] 显示名（不给就只用 campId）
 * @returns {Promise<object>} view —— 形状跟 apps/signIn.js 里手搓的那份一致：
 *   `{ name, campId, stateClass, stateText, info, roleName?, signGifts?, failReason? }`
 */
export async function signOneAccount (campId, { name, autoTask = true } = {}) {
  const probe = await probeAccount(campId, { name })

  // 没角色 / 查询失败 / 状态判不了 —— 都不发写请求，原样返回
  if (probe.noRole || probe.failReason || probe.signedToday === null) {
    return probe
  }

  /**
   * ⚠️ **「今天已签」也要走一趟领取**（这是本次修复的要点之一）：
   *    用户昨天/刚才在 App 里签过、但没点「领取」，那 25 枚币还躺着。
   *    早先这里和上面的分支并在一起直接 return，于是「已签」的号永远领不到奖励 ——
   *    而这恰恰是最常见的那种（定时任务签完，用户再手发一次 `#王者签到`）。
   */
  if (probe.already) {
    return withRewards(probe, autoTask)
  }

  const { name: label, info, role } = probe

  // ③ 真签到（retries=0，写操作不能重试 —— 重试等于连签两次，只会撞 -105206）
  let res
  try {
    res = await apiService.doCampSign(campId, role.roleId)
  } catch (error) {
    return fail(label, campId, '签到失败', apiService.formatUserFacingError(error), error, role, info)
  }

  const verdict = classifySignCode(res?.returnCode)

  if (verdict === 'ok') {
    return withRewards({
      name: label,
      campId,
      stateClass: 'new',
      stateText: '签到成功',
      roleName: role.roleName,
      // 签到成功后服务端回一份新状态，直接用它拼图（比再查一次少一个请求）
      info: {
        ...info,
        weekSignMap: res?.data?.userSign || info.weekSignMap,
        seqSignDays: res?.data?.seqSignDays ?? info.seqSignDays,
        userTotalSign: res?.data?.totalSignDays ?? info.userTotalSign
      },
      signGifts: Array.isArray(res?.data?.giftList) ? res.data.giftList : [],
      signDate: res?.data?.signDate || '',
      signed: true
    }, autoTask)
  }

  if (verdict === 'already') {
    // 服务端说今天签过了 —— 正常结果（可能刚在别处签的），不是失败。
    // 同样要去领一趟奖励：签过 ≠ 领过（见 claimTaskRewards 的说明）
    return withRewards({ name: label, campId, stateClass: 'done', stateText: '今天已签', info, roleName: role.roleName, already: true }, autoTask)
  }

  if (verdict === 'too-fast') {
    return {
      name: label, campId, stateClass: 'fail', stateText: '操作太频繁',
      info, roleName: role.roleName,
      failReason: '这次请求得太快了，过一会儿再试'
    }
  }

  if (verdict === 'missing-role') {
    // roleId 传了还不认 —— 通常是角色和登录态对不上
    return {
      name: label, campId, stateClass: 'fail', stateText: '角色签不了',
      info, roleName: role.roleName,
      failReason: '这个角色签不了，去营地 App 里确认一下角色绑定'
    }
  }

  return fail(label, campId, '签到失败', res?.returnMsg || `错误码 ${res?.returnCode}`, null, role, info)
}

/**
 * 给一个 view 补上「福利中心奖励」那几项。
 *
 * 抽出来是因为**两条路都要走**（刚签上的、本来就已签的），而两边各写一次
 * 必然漂移 —— 漂移的后果恰好是这次要修的 bug 的翻版：某一条路不领，
 * 用户就永远差那 25 枚币。
 *
 * 领取失败**不改 stateClass**：签到成功就是成功了，不能因为领奖没成
 * 让整张图标红（但 `rewardNote` 会把原因带出去）。
 */
async function withRewards (view, autoTask = true) {
  // ⚠️ 顺序**必须先做任务、再领奖励**：反过来的话，这一轮刚做出来的那 25 币
  //    要等下一次签到才收得到 —— 而「下次」往往已经是明天，任务早重置了。
  const acted = await completeDailyTasks(view.campId, { enabled: autoTask })

  const result = await claimTaskRewards(view.campId)

  return {
    ...view,
    actedTasks: acted,
    // 给用户看的那一句（「浏览资讯、点赞」）；什么都没做时是空串，
    // 图/文案那边据此决定要不要多显示一行
    actedText: describeActed(acted),
    claimedTasks: result.claimed,
    claimedText: describeClaimed(result.claimed),
    coin: result.coin,
    todoTasks: result.todo,
    rewardNote: result.failReason
  }
}

/** 造一个「失败」view，省得上面每个分支都写一遍 */
function fail (name, campId, stateText, failReason, error, role, info) {
  if (error) globalThis.logger?.warn?.(`[王者签到] ${campId} ${stateText}: ${error?.message || error}`)
  return {
    name, campId, stateClass: 'fail', stateText, failReason,
    roleName: role?.roleName,
    info
  }
}

/**
 * 一轮签到的**统计口径**（成功/已签/没角色/真失败）。
 *
 * ⚠️ 单独一个函数是因为「没角色」的处理很容易写错：它**必须**跟 `failCount` 分开，
 * 否则主人那种「5 个号里 3 个没角色」的机器会报「3 个没签上」（2026-10-10 真机踩到）。
 *
 * @param {object[]} views signOneAccount 的返回值数组
 * @returns {{okCount:number, alreadyCount:number, noRoleCount:number, failCount:number}}
 */
export function summarizeViews (views = []) {
  const result = { okCount: 0, alreadyCount: 0, noRoleCount: 0, failCount: 0 }

  for (const view of views) {
    if (view?.signed) result.okCount++
    else if (view?.already) result.alreadyCount++
    else if (view?.noRole) result.noRoleCount++
    else result.failCount++
  }

  return result
}

/**
 * 把一批 view **按号主分组** —— 定时任务靠它决定「这条结果该私聊给谁」。
 *
 * ⚠️ 没有 `ownerBotUserId` 的号（2026-09-17 之前扫的那批无主号）归到 `null` 组，
 *    调用方要么送给主人、要么直接不送。**别默认塞给第一个人** ——
 *    那会把别人的账号状态发错人。
 *
 * @param {Array<{account: object, view: object}>} pairs
 * @returns {Map<string|null, object[]>} ownerBotUserId → 该人的 view 数组
 */
export function groupByOwner (pairs = []) {
  const grouped = new Map()

  for (const pair of pairs) {
    const owner = String(pair?.account?.ownerBotUserId || '').trim() || null
    if (!grouped.has(owner)) grouped.set(owner, [])
    grouped.get(owner).push(pair.view)
  }

  return grouped
}
