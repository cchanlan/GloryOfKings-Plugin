/**
 * 营地签到的**账号编排层**：给一个账号签一次、给一批账号签一轮。
 *
 * 抽出来是因为有**两个调用方**：
 *   · `apps/signIn.js` 的 `#王者签到` 指令（谁发指令就给谁名下的号签，结果回原会话）
 *   · `apps/signIn.js` 的每日定时任务（给池子里所有号签，结果**私聊各自的号主**）
 *
 * 两边的差异只有「签谁」和「结果送哪」，**签的动作本身必须只有一份** ——
 * 否则「角色列表 → 查状态 → 没签才签」这套顺序会在两处漂移，
 * 而它恰好是踩过坑的地方（不带 `roleId` 会回骗人的 -105204）。
 *
 * 零云崽依赖（只 import 纯逻辑 + api），可以脱开运行时单测。
 */
import apiService from './api.js'
import { isSignedToday, pickMainRole, classifySignCode } from './campSign.js'

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
 * **不抛异常**：任何失败都翻译成 `{ ok: false, stateText, failReason }`，
 * 好让「一个号挂了」不影响「另一个号能签」。
 *
 * @param {string} campId 营地号（账号池里的 userId）
 * @param {object} [opts]
 * @param {string} [opts.name] 显示名（不给就只用 campId）
 * @returns {Promise<object>} view —— 形状跟 apps/signIn.js 里手搓的那份一致：
 *   `{ name, campId, stateClass, stateText, info, roleName?, signGifts?, failReason? }`
 */
export async function signOneAccount (campId, { name } = {}) {
  const label = String(name || campId)

  // ① 角色列表
  let role
  try {
    role = pickMainRole(await apiService.getRoleList(campId))
  } catch (error) {
    return fail(label, campId, '查询失败', apiService.formatUserFacingError(error), error)
  }

  if (!role?.roleId) {
    // ⚠️ 这一类**不是失败**：号没绑王者角色是结构性事实（主人 5 个号里 3 个如此）。
    //    调用方要把它单独计数（noRoleCount），不能并进 failCount ——
    //    否则会报「3 个没签上」，看着像插件坏了。
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

  if (isSignedToday(info.weekSignMap) === true) {
    return {
      name: label, campId, stateClass: 'done', stateText: '今天已签',
      info, roleName: role.roleName, already: true
    }
  }

  // ③ 真签到（retries=0，写操作不能重试 —— 重试等于连签两次，只会撞 -105206）
  let res
  try {
    res = await apiService.doCampSign(campId, role.roleId)
  } catch (error) {
    return fail(label, campId, '签到失败', apiService.formatUserFacingError(error), error, role, info)
  }

  const verdict = classifySignCode(res?.returnCode)

  if (verdict === 'ok') {
    return {
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
    }
  }

  if (verdict === 'already') {
    // 服务端说今天签过了 —— 正常结果（可能刚在别处签的），不是失败
    return { name: label, campId, stateClass: 'done', stateText: '今天已签', info, roleName: role.roleName, already: true }
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
