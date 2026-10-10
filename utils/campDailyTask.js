/**
 * 福利中心**每日任务**的完成动作编排：浏览资讯 / 点赞。
 *
 * ## 为什么要「替用户做」
 *
 * 福利中心那几条任务里，「每日前往游戏专区签到」是靠 `newsignin` 顺带做掉的，
 * 另外三条各 25 营地币，完成方式**分两种**（都是 2026-10-10 实测）：
 *
 * | 任务 | 做法 | 结果 |
 * |---|---|---|
 * | 浏览资讯 | 真调 `/info/detailinfo {iInfoId}` | `[0/1] → [1/1]` ✓ |
 * | 点赞 | 真调 `/info/addlike {iInfoId}` | `[0/1] → [1/1]` ✓ |
 * | **分享** | 只上报 `/play/gettaskconditiondata {type:1}` | `[0/1] → [1/1]` ✓ |
 * | （对照）浏览 | 上报 `{type:5}` / `{type:11}` | `rc=0` 但**状态不变** |
 *
 * **为什么分享是例外**：浏览和点赞服务端自己能验证（有没有真读过那篇资讯、
 * 有没有真点过赞），所以只认真实行为、上报没用；而**分享在客户端侧
 * （调起微信/QQ）服务端收不到回调**，只能认这个上报 —— 所以分享任务
 * 「按了就算」，不用真分享出去。
 *
 * 做完再由 `campSignTask.claimTaskRewards` 把 25 币领回来。
 *
 * ## 边界（重要，别越界）
 *
 * · **只对未完成的任务做**：靠 `finishStatus` 判，不是每轮无脑点 ——
 *   「同一个 ID 重复点赞会不会变成取消赞」没验证过，幂等只能靠自己保证。
 * · **点赞是写操作**，会在营地留下真实的社交动作，调用方要能关掉它
 *   （`config.campSignAutoTask`）。
 * · **不做「关注作者」**：那条要真去关注 3 个认证作者（也是社交动作），
 *   而且奖励是道具不是营地币，先不碰。
 * · **不抛异常**：做任务失败不该让「签到成功」这件事看起来像失败了。
 *
 * 零云崽依赖（只 import 纯逻辑 + api），能脱开运行时单测。
 */
import apiService from './api.js'
import { pickInfoId } from './campTask.js'

/** 任务动作标识（任务对象的 `func` 字段），实测值 */
const FUNC_VIEW_NEWS = 'todayViewNews'
const FUNC_ADD_LIKES = 'todayAddLikes'
const FUNC_SHARE = 'shareByHelper'

/**
 * 「分享」的上报类型（`/play/gettaskconditiondata` 的 `type`）。
 *
 * ⚠️ **分享跟浏览/点赞不是一回事，别当成同一类处理**：
 *    浏览和点赞服务端能自己验证（有没有真读过那篇资讯、有没有真点过赞），
 *    所以只认真实行为；**分享在客户端侧（调起微信/QQ）服务端收不到回调**，
 *    只能认这个上报 —— 这正是「分享任务不用真分享」的原因。
 *
 * 实测（2026-10-10，分离测试）：`type:1` → 分享任务 `finishStatus` 0→1 ✓；
 * 而 `type:9`（分享给好友）、`5`（点击资讯tab）、`11`（浏览历史）**都不会**改任务状态。
 */
const CONDITION_TYPE_SHARE = 1

/**
 * 把当前账号**还没做的**每日任务做掉（浏览资讯 / 点赞）。
 *
 * 流程：查任务列表 → 挑出还没做的 → 分享（只上报）→ 取一条有效资讯 ID → 浏览 / 点赞。
 *
 * ⚠️ 两条任务都已完成时**一个请求都不发**（除了那次查列表）——
 *    每天重复点同一个赞是不必要的社交动作。
 *
 * @param {string} campId 营地号
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] 传 false 整段跳过（对应 `config.campSignAutoTask`）
 * @returns {Promise<{viewed: boolean, liked: boolean, skipped: boolean, failReason: string}>}
 */
export async function completeDailyTasks (campId, { enabled = true } = {}) {
  const empty = { viewed: false, liked: false, shared: false, skipped: false, failReason: '' }

  if (!enabled) return { ...empty, skipped: true }

  // ① 先看这两条做没做 —— 做过了就别动它，也省掉后面的资讯流请求
  let taskList
  try {
    taskList = (await apiService.getCampTaskList(campId))?.data?.taskList
  } catch (error) {
    globalThis.logger?.warn?.(`[营地任务] ${campId} 拉任务列表失败(做任务前): ${error?.message || error}`)
    return { ...empty, failReason: apiService.formatUserFacingError(error) }
  }

  const tasks = Array.isArray(taskList) ? taskList : []
  const needView = hasUndone(tasks, FUNC_VIEW_NEWS)
  const needLike = hasUndone(tasks, FUNC_ADD_LIKES)
  const needShare = hasUndone(tasks, FUNC_SHARE)

  // 都做完了 —— 什么都没干，正常返回（不是错误）
  if (!needView && !needLike && !needShare) return empty

  const result = { ...empty }

  // ② 分享：只上报一个 type，**不需要资讯 ID**，所以放在取资讯流之前 ——
  //    只剩分享没做时能整段省掉那次资讯流请求
  if (needShare) {
    try {
      await apiService.reportTaskCondition(campId, CONDITION_TYPE_SHARE)
      result.shared = true
      globalThis.logger?.info?.(`[营地任务] ${campId} 已上报分享`)
    } catch (error) {
      globalThis.logger?.warn?.(`[营地任务] ${campId} 上报分享失败: ${error?.message || error}`)
      result.failReason = apiService.formatUserFacingError(error)
    }
  }

  // ③ 浏览 / 点赞要**真的读一篇资讯**，先取一条有效 ID（两个动作共用同一条）
  if (!needView && !needLike) return result

  let infoId = ''
  try {
    infoId = pickInfoId((await apiService.getInfoFeed(campId))?.data?.list)
  } catch (error) {
    globalThis.logger?.warn?.(`[营地任务] ${campId} 取资讯流失败: ${error?.message || error}`)
    return { ...result, failReason: result.failReason || apiService.formatUserFacingError(error) }
  }

  if (!infoId) {
    // 资讯流里没有可用的资讯卡（比如这个号没关注任何内容）——
    // 不是错误，但确实做不了，如实记一笔就退出
    // ⚠️ 回 result 而不是 empty：分享那边可能已经做成功了
    globalThis.logger?.warn?.(`[营地任务] ${campId} 资讯流里没有可用资讯，跳过浏览/点赞`)
    return result
  }

  // ③ 浏览（读操作；它失败不该拦住下面的点赞）
  if (needView) {
    try {
      await apiService.viewCampInfo(campId, infoId)
      result.viewed = true
      globalThis.logger?.info?.(`[营地任务] ${campId} 已浏览资讯 ${infoId}`)
    } catch (error) {
      globalThis.logger?.warn?.(`[营地任务] ${campId} 浏览资讯失败: ${error?.message || error}`)
      result.failReason = apiService.formatUserFacingError(error)
    }
  }

  // ④ 点赞（写操作，api 那边 retries=0）
  if (needLike) {
    try {
      await apiService.likeCampInfo(campId, infoId)
      result.liked = true
      globalThis.logger?.info?.(`[营地任务] ${campId} 已点赞资讯 ${infoId}`)
    } catch (error) {
      globalThis.logger?.warn?.(`[营地任务] ${campId} 点赞失败: ${error?.message || error}`)
      // 浏览那边已经写过原因就别覆盖（先发生的更值得报）
      result.failReason = result.failReason || apiService.formatUserFacingError(error)
    }
  }

  return result
}

/**
 * 把 `completeDailyTasks` 的结果转成一句给用户看的文案。
 *
 * **什么都没做就回空串** —— 调用方据此决定要不要多显示那一行
 * （每张签到图上都挂一句「自动完成：」但后面是空的，比不显示更糟）。
 *
 * @param {object} result completeDailyTasks 的返回值
 * @returns {string} 如「浏览资讯、点赞」；没做事时 `''`
 */
export function describeActed (result) {
  const parts = []
  if (result?.viewed) parts.push('浏览资讯')
  if (result?.liked) parts.push('点赞')
  if (result?.shared) parts.push('分享')
  return parts.join('、')
}

/**
 * 这个 `func` 的任务是不是**还没做完**。
 *
 * ⚠️ 判据按类型来，别 `Number()` 一把梭：`Number(null)` 和 `Number([])` 都是 0，
 *    字段缺失会被当成「没做完」，于是每轮都去点一次赞（最坏的后果是社交动作刷屏）。
 *    只有**明确的数字 1** 才算做完，其余一律当没做完 —— 宁可少点一次，不要多点。
 */
function hasUndone (tasks, func) {
  return tasks.some(task => String(task?.func || '') === func && !(Number(task?.finishStatus) === 1))
}
