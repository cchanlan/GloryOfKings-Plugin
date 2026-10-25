/**
 * 群名片装饰：报表 / 推送里要把「游戏名」显示成「游戏名（群名片）」时走这里。
 *
 * 为什么单独一个模块：需要这个能力的入口有十来个（群报、个人日报、排行榜、谁在玩、
 * 对比、趋势、称号墙……），各写一份 `getMemberMap` 的话，字段名和兜底顺序迟早漂移。
 *
 * 群名片是**按群**的：同一个人在不同群有不同名片，私聊里没有名片。所以调用方必须先判断
 * 这条消息是不是发到群里，再传群号进来。
 */
import { cleanName } from './rankStore.js'

/** 成员表缓存时间。群里成员变动不会很频繁，30 秒足够挡住一次指令里的重复查询 */
const CACHE_TTL_MS = 30 * 1000

/** groupId -> { at, nicks: Map<qq, nick> } */
const cache = new Map()

/**
 * 群成员表，三路兜底，覆盖不同协议端：
 * 1. `group.getMemberMap()` —— icqq（Miao-Yunzai 默认协议库）、TRSS、OneBot 适配器都实现了，
 *    返回 Map<user_id, Member>，Member 的昵称字段是 `card` / `nickname`
 * 2. `group.getMemberList()` —— 部分适配器只给数组
 * 3. `Bot.gml` —— Yunzai 系的群成员缓存，前两路被频控/抽风打回来时还能救命
 *
 * @param {string|number} groupId
 * @param {object} [group] 群对象；取不到时只靠 Bot.gml
 * @returns {Promise<Map<string, object>|null>}
 */
export async function getMemberMap (groupId, group) {
  try {
    const map = await group?.getMemberMap?.()
    if (map?.size) return map
  } catch (error) {
    globalThis.logger?.debug?.(`[群名片] getMemberMap 失败: ${error.message}`)
  }

  try {
    const list = await group?.getMemberList?.()
    if (Array.isArray(list) && list.length) {
      const map = new Map()
      for (const item of list) {
        const id = String(item?.user_id ?? item?.userId ?? '')
        if (id) map.set(id, item)
      }
      if (map.size) return map
    }
  } catch (error) {
    globalThis.logger?.debug?.(`[群名片] getMemberList 失败: ${error.message}`)
  }

  const cached = globalThis.Bot?.gml?.get?.(groupId)
  return cached?.size ? cached : null
}

/**
 * QQ -> 群名片。名片为空时用 QQ 昵称；再空就没有这个名字。
 * @returns {Promise<Map<string,string>|null>} 取不到成员表时返回 null
 */
export async function getNickMap (groupId, group) {
  const key = String(groupId || '')
  if (!key) return null

  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.nicks

  const map = await getMemberMap(key, group)
  if (!map) return null

  const nicks = new Map()
  for (const [userId, member] of map) {
    // 群名片优先、没设名片用 QQ 昵称，都过一遍清洗：
    // icqq / NapCat 的名片里常带私有区图标和不可见字符，直接进图会显示成豆腐块
    const nick = cleanName(member?.card) || cleanName(member?.nickname) || cleanName(member?.name)
    if (nick) nicks.set(String(userId), nick)
  }
  cache.set(key, { at: Date.now(), nicks })
  return nicks
}

/** 取某个 QQ 的群名片，没有返回空串 */
export function nickOf (nickMap, qq) {
  return nickMap?.get?.(String(qq)) || ''
}

/**
 * 拼成「游戏名（群名片）」。
 *
 * 名片限 6 个字：称号格和排行榜行都是单行 nowrap，遇到「AAA.龙哥智商批发（全网进货中）」
 * 这种长名片，会把后面的「· 巅峰分 +116」直接挤成省略号。
 * 名片和游戏名相同、或没有名片时原样返回。
 *
 * @param {string} name 游戏名
 * @param {string} nick 群名片
 * @param {number} [max=6] 名片最多保留几个字符
 */
export function withGroupNick (name, nick, max = 6) {
  const base = String(name || '').trim()
  const label = String(nick || '').trim()
  if (!base || !label || label === base) return base
  const chars = [...label]
  return `${base}（${chars.length > max ? `${chars.slice(0, max).join('')}…` : label}）`
}

/** 清空缓存。群成员变动后想立刻生效时用（目前只有测试脚本会调） */
export function clearNickCache () {
  cache.clear()
}
