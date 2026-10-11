/**
 * 「自动签到的报告往哪儿发」的记录表。
 *
 * ## 为什么需要它
 *
 * 定时签到原先**一律私聊号主**。但用户是在群里发的 `#开启王者自动签到`，
 * 第二天报告却从私聊冒出来 —— 对方可能压根没加机器人好友，于是
 * 「开了但好像没反应」。按**他在哪儿开的就往哪儿回**最符合预期
 * （2026-10-11 主人要求）。
 *
 * ## 存什么
 *
 * `data/SignReportTarget.yaml`：
 * ```yaml
 * '2606138772':            # 号主 QQ
 *   groupId: '575663150'   # 空 = 私聊
 *   botId: '3851152744'    # 当时是哪个 bot 收到的（多 bot 时别发错号）
 *   at: '2026-10-11T...'
 * ```
 *
 * ⚠️ **没有记录 ≠ 出错**：2026-10-11 之前开的人都没有记录，
 *    那时的行为就是私聊 —— 所以读不到时**回落私聊**，不要报错、也不要跳过。
 */
import path from 'path'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'
import { PluginData } from '#components'

const TARGET_FILE = path.join(PluginData, 'SignReportTarget.yaml')

/** 整张表（读不出来就当空表，不抛异常——报告发不出去比表坏了更糟） */
function loadAll () {
  try {
    const data = readYamlFile(TARGET_FILE)
    return data && typeof data === 'object' ? data : {}
  } catch (error) {
    // ⚠️ 文件不存在是**全新安装的正常状态**（谁都还没开过自动签到），
    //    不该刷 warn —— 那会让人以为坏了。只有真读坏了才吭声。
    if (error?.code !== 'ENOENT') {
      globalThis.logger?.warn?.(`[签到回报] 读取 ${TARGET_FILE} 失败：${error?.message || error}`)
    }
    return {}
  }
}

/**
 * 记下「这个人在哪儿开的自动签到」。
 *
 * @param {object} e 消息事件
 * @returns {boolean} 存成功与否（失败只记日志，不影响开启本身）
 */
export function rememberTarget (e) {
  const userId = String(e?.user_id ?? '').trim()
  if (!userId) return false

  try {
    const all = loadAll()
    all[userId] = {
      // ⚠️ 私聊时 `e.group_id` 是 undefined，统一存成空串 ——
      //    yaml 里 undefined 会被写成 null，读回来判断起来更绕
      groupId: String(e?.group_id ?? '').trim(),
      botId: String(e?.self_id ?? e?.bot?.uin ?? '').trim(),
      at: new Date().toISOString()
    }
    writeYamlFile(TARGET_FILE, all)
    return true
  } catch (error) {
    globalThis.logger?.warn?.(`[签到回报] 记录 ${userId} 的回报位置失败：${error?.message || error}`)
    return false
  }
}

/**
 * 查「这个人的报告该发哪儿」。
 *
 * @param {string} userId 号主 QQ
 * @returns {{groupId: string, botId: string}|null} `null` = 没记录，调用方按私聊处理
 */
export function getTarget (userId) {
  const id = String(userId ?? '').trim()
  if (!id) return null

  const row = loadAll()[id]
  if (!row || typeof row !== 'object') return null

  return {
    groupId: String(row.groupId ?? '').trim(),
    botId: String(row.botId ?? '').trim()
  }
}

/** 关掉自动签到时把记录清掉（下次开启会重新记，留着没意义） */
export function forgetTarget (userId) {
  const id = String(userId ?? '').trim()
  if (!id) return

  try {
    const all = loadAll()
    if (!(id in all)) return
    delete all[id]
    writeYamlFile(TARGET_FILE, all)
  } catch (error) {
    globalThis.logger?.warn?.(`[签到回报] 清除 ${id} 的回报位置失败：${error?.message || error}`)
  }
}
