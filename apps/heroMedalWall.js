/**
 * #称号墙 —— 把「台北第37孙权」这类荣耀称号按排名列出来。
 *
 * 称号只存在于单英雄战绩详情里（一个英雄一次请求，见 utils/heroMedals.js 的说明），
 * 所以这条指令**按战力从高到低只扫前 N 个英雄**，默认 15 个，最多 30 个。
 * 高战英雄才可能上榜（实测战力 2359 的后羿 medalList 直接是空数组），
 * 从战力最高的开始扫，等于用最少的请求把有称号的那批人捞全。
 *
 * 请求成本：1 次 profile + 1 次英雄列表 + N 次详情，走全局串行队列（1.2 秒一次），
 * 15 个英雄约 20 秒，所以先回执再干活。结果缓存 30 分钟，和 #我的英雄 共用，
 * 刚查过 #我的英雄 的话前 10 个英雄是缓存命中，这条几乎瞬间出。
 *
 * 输出是纯文字：称号本来就是一行文本，逐条列出来比塞进图里更好读，也省一次出图。
 */
import path from 'path'
import {
  ApiService, getCurrentId, readYamlFile, Button, shouldQuote,
  AT_HEAD, stripAtText, resolveTargetUserId, resolveMemberName
} from '#utils'
import { fetchHeroMedals, parseMedal, pendingMedalCount } from '../utils/heroMedals.js'
import { loadPushList } from '../utils/pushStore.js'
import { PluginData } from '#components'

/** 默认扫多少个英雄。20 秒左右，再多用户就该以为指令死了 */
const SCAN_COUNT = 15
/** 上限。30 个英雄约 40 秒，够到顶了 */
const MAX_SCAN = 30

export class HeroMedalWall extends plugin {
  constructor () {
    super({
      name: '王者称号墙',
      dsc: '按排名列出荣耀称号',
      event: 'message',
      priority: 0,
      rule: [
        { reg: `${AT_HEAD}#(称号墙|荣耀称号|我的称号|称号列表)\\s*(.*)$`, fnc: 'wall' }
      ]
    })
  }

  async wall (e) {
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint, shouldQuote())

    const input = stripAtText(e.msg).replace(/^#(称号墙|荣耀称号|我的称号|称号列表)\s*/, '').trim()
    const args = parseArgs(input)

    let campId = args.campId
    if (!campId && args.index) {
      const ids = (readYamlFile(path.join(PluginData, 'UserData.yaml')) || {})[userId]?.ids || []
      campId = ids[args.index - 1] || ''
      if (!campId) {
        return e.reply(`你没有第 ${args.index} 个绑定的营地ID，发送 #营地ID 看看列表`, shouldQuote())
      }
    }
    if (!campId) campId = getCurrentId(userId)

    if (!campId) {
      return e.reply(['你还没有绑定营地ID，先发送 #绑定营地 [营地ID]', Button.bind()], shouldQuote())
    }

    const scan = Math.min(Math.max(args.count || SCAN_COUNT, 1), MAX_SCAN)

    let role = {}
    let roleId = ''
    let played = []
    try {
      const profile = await ApiService.getProfile(String(campId), String(userId))
      roleId = String(profile?.data?.targetRoleId || '')
      role = (profile?.data?.roleList || []).find(item => String(item.roleId) === roleId) || {}

      const heroRes = await ApiService.getGameHeroList(String(campId), String(userId))
      played = (heroRes?.data?.heroList || []).filter(hero => Number(hero.playNum) > 0)
    } catch (error) {
      logger.error(`[王者称号墙] ${campId} 取数据失败: ${error.message}`)
      return e.reply(ApiService.formatUserFacingError(error, {
        isMaster: Boolean(e.isMaster),
        scene: '称号墙查询异常'
      }), shouldQuote())
    }

    if (!roleId) {
      return e.reply('取不到角色信息，请前往王者营地开启「陌生人可见」后重试', shouldQuote())
    }
    if (!played.length) {
      return e.reply('未获取到英雄数据，请前往王者营地开启「陌生人可见」后重试', shouldQuote())
    }

    // 战力降序：称号是战力榜，从最高的开始扫才不会漏掉有称号的英雄
    const picked = [...played]
      .sort((a, b) => Number(b.heroFightPower) - Number(a.heroFightPower) || Number(b.playNum) - Number(a.playNum))
      .slice(0, scan)

    // 缓存（30 分钟，与 #我的英雄 共用）没命中的才真发请求，全命中时省掉这句回执
    const pending = pendingMedalCount(roleId, picked)
    if (pending > 3) {
      await e.reply(`正在逐英雄查称号（战力最高的 ${picked.length} 个），大约 ${Math.ceil(pending * 1.3)} 秒...`, shouldQuote())
    }

    const medals = await fetchHeroMedals(roleId, picked, {
      roleName: role.roleName,
      serverId: role.serverId,
      campId: String(campId),
      botUserId: String(userId)
    })

    const name = String(role.roleName || '').trim() || await displayName(e, userId)
    return e.reply([
      renderWall({ name, picked, medals, scanned: picked.length, total: played.length }),
      Button.medalWall(campId)
    ], shouldQuote())
  }
}

/** `#称号墙 25 1580886057`：5 位以上是营地ID，1-2 位是扫描个数，3-4 位当绑定序号 */
function parseArgs (input = '') {
  const out = { campId: '', index: null, count: null }
  for (const tok of String(input).split(/[\s,，、]+/).filter(Boolean)) {
    if (!/^\d+$/.test(tok)) continue
    if (tok.length >= 5) out.campId = tok
    else if (Number(tok) <= MAX_SCAN && out.count === null) out.count = Number(tok)
    else if (out.index === null) out.index = Number(tok)
  }
  return out
}

/** 展示名兜底：推送轮询缓存的营地昵称 → 群名片 → QQ 号，都不额外发请求 */
async function displayName (e, userId) {
  const cached = String(loadPushList()[String(userId)]?.roleName || '').trim()
  if (cached) return cached
  try {
    return await resolveMemberName(e, userId) || String(userId)
  } catch {
    return String(userId)
  }
}

/* ---------------------------------------------------------- 文案 */

function renderWall ({ name, picked, medals, scanned, total }) {
  // 两条 medalList 分别是带地名的市级榜(TitleType 2)和不带地名的小范围榜(TitleType 1)，
  // 按 TitleType 分组展示：混在一起会出现「第9孙权」「台北第37孙权」挨着，看着像重复
  const groups = new Map()
  const none = []

  for (const hero of picked) {
    const list = medals.get(String(hero.heroId))
    // 没进 Map 的是请求失败（不是「没上榜」），两者都归到未上榜里但不细分——用户不关心
    if (!list?.length) {
      none.push(hero.name || `英雄${hero.heroId}`)
      continue
    }
    for (const item of list) {
      const parsed = parseMedal(item?.UserMedalInfo)
      if (!parsed.text) continue
      const key = String(item?.TitleType ?? '')
      if (!groups.has(key)) groups.set(key, { area: parsed.area, rows: [] })
      const group = groups.get(key)
      if (!group.area && parsed.area) group.area = parsed.area
      group.rows.push({
        rank: parsed.rank,
        hero: parsed.hero || hero.name || '',
        power: Number(hero.heroFightPower) || 0,
        text: parsed.text
      })
    }
  }

  const lines = [`🏅 ${name} 的荣耀称号`]

  if (!groups.size) {
    lines.push('', `战力最高的 ${scanned} 个英雄都还没上榜`)
    lines.push('称号是英雄战力排行榜的名次，把某个英雄的战力练上去就有了')
    return lines.join('\n')
  }

  // 地名榜（TitleType 2）先展示：数字更大但范围更广，是营地默认显示的那条
  const ordered = [...groups.entries()].sort((a, b) => Number(b[0]) - Number(a[0]))
  for (const [, group] of ordered) {
    const rows = group.rows.sort((a, b) => a.rank - b.rank || b.power - a.power)
    lines.push('', `📍 ${group.area || '本区'}榜（${rows.length}）`)
    for (const row of rows) {
      lines.push(`· 第 ${row.rank} ${row.hero}${row.power ? `　战力 ${row.power}` : ''}`)
    }
  }

  if (none.length) {
    lines.push('', `未上榜（${none.length}）：${none.join('、')}`)
  }

  lines.push('', `扫了战力最高的 ${scanned} / ${total} 个英雄，指令后跟数字可以多扫（最多 ${MAX_SCAN}，每个英雄要单独请求）`)
  lines.push('这里是当前排名；营地「历史赛季」页显示的是历史最高时的称号，可能不一样')
  return lines.join('\n')
}
