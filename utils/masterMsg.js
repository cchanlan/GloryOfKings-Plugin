/**
 * 私聊给主人发消息，并**真实判断有没有送达**。
 *
 * ⚠️ `Bot.sendMasterMsg` 全失败也会 resolve 成功：它内部塞进返回值里的
 * `ret[bot_id][user_id]` 是**没 await 的 promise**，外面那层 allSettled 对它无效。
 * 所以必须自己再收一次。不这么做的话，「主人根本没加机器人好友」这种情况会表现为
 * 「状态文件显示已提醒、日志里一行都没有」——最难查的那类问题。
 *
 * ⚠️⚠️ **默认只发给第一个主人，不再群发所有主人**（2026-10-06 修）。
 *    `Bot.sendMasterMsg` 会把消息发给 `cfg.master` 里的**每一个**主人 ——
 *    线上 `config/config/other.yaml` 的 master 可以是好几个人，于是一条「某全局账号
 *    登录态已失效」的运维提醒会同时私聊到每个人（主人实测反馈：好几个人全收到了）。
 *    这类消息是**给运维者看的**（要重新扫码、要看账号池、要看分发服务），
 *    不是给所有主人看的。现在改成：默认取主人列表里的第一个；
 *    主人在锅巴「主人通知收件人」里勾了谁，就只发给谁。
 *
 * 配置项 `config.masterNotify`（锅巴「主人通知收件人」）：
 *   · 空 / 没配 → 只发第一个主人（默认，和主人要求一致）
 *   · 勾了若干人 → 只发给他们（按主人列表顺序）
 *   · 勾了但**一个都不在主人列表里**（人删了）→ 回落到第一个主人，别静默丢消息
 */
import { Config } from '#components'

/** 框架自带的假账号（不是真 QQ，发过去只会报错，还会占掉「第一个主人」这个位置） */
const FAKE_ACCOUNT = /^(stdin|mock|sandbox)/i

/**
 * 所有主人（去重后的 QQ 列表）。
 *
 * 三个框架的结构都是 `globalThis.cfg.master = { [bot_id]: [user_id, ...] }`
 * （JiuLi `lib/core/config/index.js` 的 `get master()`，TRSS / Miao 同源）。
 * 老配置里可能只有 `masterQQ`（扁平数组），也一并兜住。
 *
 * @returns {string[]} 拿不到就回空数组，由调用方决定回退策略
 */
export function listMasterQQ () {
  const out = []
  const push = (id) => {
    const text = String(id ?? '').trim()
    if (!text || FAKE_ACCOUNT.test(text)) return
    if (!out.includes(text)) out.push(text)
  }

  try {
    const master = globalThis.cfg?.master
    if (master && typeof master === 'object') {
      for (const ids of Object.values(master)) {
        for (const id of (Array.isArray(ids) ? ids : [ids])) push(id)
      }
    }
  } catch { /* 配置结构不对就当没有 */ }

  // 兜底：只有 masterQQ、没有 master 的老配置
  if (!out.length) {
    try {
      const qq = globalThis.cfg?.masterQQ
      for (const id of (Array.isArray(qq) ? qq : (qq ? [qq] : []))) push(id)
    } catch { /* 同上 */ }
  }

  return out
}

/** 锅巴里勾选的收件人。没配 / 读不到 → 空数组（表示「用默认」） */
function pickedTargets () {
  try {
    const raw = Config.getDefOrConfig('config')?.masterNotify
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : [])
    return list.map(i => String(i ?? '').trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 这次该发给谁。导出给锅巴面板复用（下拉候选就是它）。
 *
 * @returns {string[]} 至少一个；拿不到主人列表时回空数组
 */
export function resolveMasterTargets () {
  const masters = listMasterQQ()
  if (!masters.length) return []

  const picked = pickedTargets()
  if (picked.length) {
    // 只发勾中的（按主人列表顺序；勾了但已不在列表里的自然被过滤掉）
    const hit = masters.filter(id => picked.includes(id))
    if (hit.length) return hit
    logger?.warn?.(`[王者插件] 主人通知收件人里勾的（${picked.join(',')}）都不在主人列表里，本次改发给第一个主人`)
  }

  return [masters[0]]
}

/**
 * @param {string} message
 * @returns {Promise<boolean>} 至少有一个收件人收到了
 */
export async function sendMaster (message) {
  if (typeof Bot !== 'object') return false

  const targets = resolveMasterTargets()

  // ① 拿不到主人列表（老框架 / 配置结构不同）→ 退回框架原生的广播实现。
  //    宁可多发也不能不发：这是「账号挂了要重新扫码」这类必须送达的提醒。
  if (!targets.length) {
    if (typeof Bot.sendMasterMsg !== 'function') return false
    try {
      const ret = await Bot.sendMasterMsg(message, Bot.uin, 0)
      const results = await Promise.allSettled(
        Object.values(ret || {}).flatMap(perBot => Object.values(perBot || {}))
      )
      return results.some(item => item.status === 'fulfilled')
    } catch (error) {
      logger?.warn?.(`[王者插件] 私聊主人失败：${error?.message || error}`)
      return false
    }
  }

  // ② 定向发给指定的人。
  //    ⚠️ 用 pickFriend().sendMsg() 而不是 Bot.sendMasterMsg —— 后者只能「全发」，
  //    没法指定收件人。pickFriend 在 Miao / TRSS / JiuLi 上都有（同源实现）。
  const results = await Promise.allSettled(targets.map(async (userId) => {
    const friend = Bot.pickFriend?.(userId)
    if (typeof friend?.sendMsg !== 'function') throw new Error(`取不到私聊对象 ${userId}`)
    const ret = await friend.sendMsg(message)
    // 有的适配器不抛异常，而是把失败塞在返回值里（ICQQ 失败时给的是 { error }）
    if (ret && ret.error) throw new Error(String(ret.error))
    return ret
  }))

  const ok = results.filter(item => item.status === 'fulfilled').length
  if (!ok) {
    const first = results.find(item => item.status === 'rejected')
    logger?.warn?.(`[王者插件] 私聊主人失败（${targets.join(',')}）：${first?.reason?.message || first?.reason || '未知原因'}`)
  }
  return ok > 0
}
