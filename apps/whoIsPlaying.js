/**
 * #谁在打游戏 —— 列出本群谁正在对局、谁在线。
 *
 * **这条指令一次营地请求都不发。** 数据全部来自战绩推送轮询顺手留下的观测快照
 * （apps/gameRecordPush.js 的 observeSnapshot 写进 GameRecordPush.yaml）：
 *   lastGaming      本轮观测到在不在对局中（'1' / ''）
 *   lastGamingHero  在对局时用的英雄 heroId
 *   lastOnlineState 营地的 gameOnline 三态（0 离线 / 1 在线 / 2 游戏中）
 *   lastSeenAt      这份快照的观测时刻，用来判数据够不够新
 *
 * 所以它只覆盖「开过战绩推送或上下线提醒的人」——这正是想被看到的那批人，
 * 而且不给营地增加任何负载。反过来说，快照的新鲜度受推送的自适应退避影响：
 * 长时间离线的号会退到十分钟一轮，所以离线那组的时间戳可能偏旧，文案里标出来。
 *
 * 英雄名走官网 herolist.json（getHeroNameMap，6 小时内存缓存），也不碰营地接口。
 */
import { loadPushList, subGroups, getHeroNameMap, normalizeName, ONLINE_LABEL } from '../utils/pushStore.js'
import { Button, shouldQuote } from '#utils'

/** 快照超过这个时长就在文案里标「数据较旧」，单位毫秒 */
const STALE_MS = 15 * 60 * 1000

export class WhoIsPlaying extends plugin {
  constructor () {
    super({
      name: '王者谁在打游戏',
      dsc: '看本群谁在对局、谁在线，零营地请求',
      event: 'message',
      // 同 gameRecordPush：完整锚定的短指令要抢在 queryGameStats 的宽匹配前面
      priority: 0,
      rule: [
        {
          reg: '^#(谁在(打游戏|玩王者|上号|排位)|王者在线(列表|状态)?|在线列表)$',
          fnc: 'list'
        }
      ]
    })
  }

  async list (e) {
    // 私聊时没有群号，退化成「只看自己」——本群成员表都取不到，列别人没有意义
    const here = String(e.group_id || '')
    const self = String(e.user_id)

    const subs = Object.entries(loadPushList()).filter(([qq, sub]) => (
      here ? subGroups(sub).includes(here) : qq === self
    ))

    if (!subs.length) {
      await e.reply([
        here
          ? '本群还没有人开推送，所以看不到在线状态\n发送 #开启战绩推送 或 #开启上下线提醒 就会被统计进来'
          : '你还没有开启任何推送，发送 #开启上下线提醒 后才有在线状态',
        Button.push(false)
      ], shouldQuote())
      return
    }

    const heroMap = await getHeroNameMap()
    const now = Date.now()

    const playing = []
    const online = []
    const offline = []
    // 只开了战绩推送、还没攒到过快照的订阅：既不算在线也不算离线，单独说一句
    const unknown = []

    for (const [qq, sub] of subs) {
      const row = buildRow(qq, sub, heroMap, now)
      if (!row.seenAt) unknown.push(row)
      else if (row.gaming) playing.push(row)
      else if (row.state !== 0) online.push(row)
      else offline.push(row)
    }

    await e.reply([
      renderText({ playing, online, offline, unknown, now }),
      Button.online()
    ], shouldQuote())
  }
}

/** 把一条订阅整成展示用的行 */
function buildRow (qq, sub, heroMap, now) {
  const seenAt = Number(sub?.lastSeenAt) || 0
  const heroId = String(sub?.lastGamingHero || '')

  return {
    qq: String(qq),
    // 营地昵称优先（推送轮询顺手缓存的），一次都没拿到过就退回 QQ 号
    name: sub?.roleName ? normalizeName(sub.roleName) : String(qq),
    gaming: String(sub?.lastGaming || '') === '1',
    hero: heroId ? (heroMap[heroId] || `英雄${heroId}`) : '',
    state: Number(sub?.lastOnlineState) || 0,
    seenAt,
    stale: seenAt > 0 && now - seenAt > STALE_MS
  }
}

/** 相对时间，「3 分钟前」这种 */
function agoText (seenAt, now) {
  const sec = Math.max(0, Math.floor((now - seenAt) / 1000))
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/** 拼最终文案 */
function renderText ({ playing, online, offline, unknown, now }) {
  const lines = ['🎮 谁在打游戏']

  if (playing.length) {
    lines.push('', `⚔️ 正在对局（${playing.length}）`)
    for (const row of playing) {
      lines.push(`· ${row.name}${row.hero ? ` —— ${row.hero}` : ''}${row.stale ? `（${agoText(row.seenAt, now)}的数据）` : ''}`)
    }
  }

  if (online.length) {
    lines.push('', `🟢 在线（${online.length}）`)
    for (const row of online) {
      lines.push(`· ${row.name} —— ${ONLINE_LABEL[row.state] || '在线'}${row.stale ? `（${agoText(row.seenAt, now)}）` : ''}`)
    }
  }

  if (!playing.length && !online.length) {
    lines.push('', '暂时没人在线，都在摸鱼呢')
  }

  if (offline.length) {
    // 离线的人不逐个列状态：他们的快照因为自适应退避普遍偏旧，逐行写时间戳只是噪音
    lines.push('', `⚫ 离线（${offline.length}）：${offline.map(row => row.name).join('、')}`)
  }

  if (unknown.length) {
    lines.push('', `❔ 还没采集到状态（${unknown.length}）：${unknown.map(row => row.name).join('、')}`)
    lines.push('（只开了战绩推送、还没轮询到，或者开启后一次都没上线）')
  }

  lines.push('', '数据来自战绩推送的轮询快照，不会额外请求营地；离线时检查间隔会自动拉长')

  return lines.join('\n')
}
