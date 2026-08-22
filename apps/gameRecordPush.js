/**
 * 王者战绩推送 / 开局提醒。
 *
 * 这个功能的配置项（锅巴面板开关 + cron、config.yaml 的 onlineReminder/battleResultCron、
 * index.js 里注册的 GameRecordPush.yaml）在插件里一直存在，但从来没有实现过——
 * 没有任何定时任务，pushList 也没被读过。本文件就是补上那个缺口。
 *
 * 设计要点：
 * - 个人订阅制。用户在群里 #开启战绩推送，只轮询订阅过的人，推到他订阅时所在的那个群并 @ 他。
 *   不做全群自动推送：UserData.yaml 里有 20+ 个绑定用户，全量轮询按 800ms 串行要 20 秒一轮，
 *   而且大部分人并不想被推送。
 * - 开局提醒和战绩推送共用同一次请求。实测 isGaming 翻转与新场次进 list 是同一时刻发生的，
 *   拆成两个 task 只会让请求量翻倍、频控风险翻倍。详见 utils/pushStore.js 文件头的实测记录。
 *
 * 数据层与全部纯计算逻辑在 utils/pushStore.js，这里只管指令交互和消息发送。
 */
import {
  loadPushList,
  savePushList,
  mergeSubState,
  fetchLatest,
  fetchOnlineState,
  getHeroNameMap,
  calcStreak,
  pickNewBattles,
  diffOnlineState,
  summarizeSession,
  resolveOnlineSince,
  formatBattleText,
  formatGamingText,
  formatOnlineText,
  ONLINE_LABEL,
  FETCH_HIDDEN,
  MAX_DETAIL_BATTLES,
  REQUEST_INTERVAL,
  sleep
} from '../utils/pushStore.js'
import { getCurrentId, getLocalImage, Button, shouldQuote } from '#utils'
import { Config } from '#components'

/**
 * 轮询并发锁。订阅多时一轮要几十秒，cron 设得短就会出现上一轮没跑完下一轮又启动，
 * 同一场战绩被两轮同时读到、各推一次。模块级变量足够——一个进程里只有一个 task 实例。
 */
let running = false

export class GameRecordPush extends plugin {
  constructor () {
    super({
      name: '王者战绩推送',
      dsc: '打完自动推战绩，开局提醒',
      event: 'message',
      // 必须比 queryGameStats（priority 1）更优先。它的 `#?(查询|王者)战绩\s*(.*)$` 是宽匹配，
      // 会把 #王者战绩推送 当成「查战绩 推送」吞掉；两者同为 1 时谁先命中取决于模块加载顺序。
      // 这里三条 reg 都是 ^…$ 完整锚定，抢先匹配不会误吞其它指令。
      priority: 0,
      rule: [
        { reg: '^#(开启|关闭)(王者)?战绩推送$', fnc: 'toggle' },
        { reg: '^#(开启|关闭)(王者)?上下线提醒$', fnc: 'toggleOnline' },
        { reg: '^#(王者)?战绩推送(状态|列表)?$', fnc: 'status' },
        { reg: '^#清空王者战绩推送$', fnc: 'clearAll', permission: 'master' }
      ]
    })

    // 总开关关闭时给空 task，Yunzai 的 loader 只收集 cron 和 fnc 都有值的项
    const cfg = readConfig()
    this.task = cfg.onlineReminder !== false && cfg.battleResultCron
      ? {
          name: '王者战绩推送',
          cron: cfg.battleResultCron,
          fnc: () => this.checkAll(),
          log: false
        }
      : { name: '', fnc: '', cron: '' }
  }

  /**
   * 两个开关的公共校验：必须在群里发（推送要群号）、总开关开着、绑过营地ID。
   * @returns {Promise<string>} 通过时返回营地ID，未通过时已经回复过了，返回空串
   */
  async prepareToggle (e, label) {
    if (!e.isGroup) {
      await e.reply(`${label}需要在群里开启，提醒会发到你开启时所在的群`, shouldQuote())
      return ''
    }

    if (readConfig().onlineReminder === false) {
      await e.reply(`推送总开关当前是关闭状态，请让主人在 #王者设置 里打开`, shouldQuote())
      return ''
    }

    const campId = getCurrentId(e.user_id)
    if (!campId) {
      await e.reply(['你还没有绑定营地ID，先发送 #绑定营地 [营地ID]', Button.bind()], shouldQuote())
      return ''
    }

    return String(campId)
  }

  /**
   * 关掉一个开关。两个开关都关了就把整条订阅删掉，别留个空壳还占着轮询名额。
   * @returns {boolean} 之前是否真的开着
   */
  disableFlag (qq, key) {
    const list = loadPushList()
    const sub = list[String(qq)]
    if (!sub) return false

    // 老订阅没有 battle 字段，按开着算（向后兼容）
    const wasOn = key === 'battle' ? sub.battle !== false : sub.online === true
    if (!wasOn) return false

    sub[key] = false
    const battleOn = sub.battle !== false
    const onlineOn = sub.online === true

    if (!battleOn && !onlineOn) delete list[String(qq)]
    else list[String(qq)] = sub

    savePushList(list)
    return true
  }

  /** #开启战绩推送 / #关闭战绩推送 */
  async toggle (e) {
    const enable = e.msg.includes('开启')
    const qq = String(e.user_id)

    if (!enable) {
      const wasOn = this.disableFlag(qq, 'battle')
      await e.reply(
        wasOn
          ? ['已关闭战绩推送', Button.push(false)]
          : '你还没有开启战绩推送',
        shouldQuote()
      )
      return
    }

    const campId = await this.prepareToggle(e, '战绩推送')
    if (!campId) return

    // 立刻拉一次把游标初始化到当前最新一场。
    // 不做这一步，第一轮轮询会把最近打的那局当成新战绩推出来。
    const data = await fetchLatest(campId, qq)

    if (data === FETCH_HIDDEN) {
      await e.reply('你的营地隐藏了战绩，推送拿不到数据，请先在营地里关闭战绩隐藏', shouldQuote())
      return
    }

    if (!data) {
      await e.reply('拉取战绩失败，可能是营地接口频控或登录态失效，请稍后再试', shouldQuote())
      return
    }

    const latest = (data.list || [])[0] || {}
    const list = loadPushList()
    list[qq] = {
      ...(list[qq] || {}),
      battle: true,
      group: String(e.group_id),
      campId: String(campId),
      lastGameSeq: String(latest.gameSeq || ''),
      lastGameTime: String(latest.dtEventTime || ''),
      // 订阅时正在打的那局不提醒，否则一开启就收到一条「开打了」
      lastGamingStart: String(data.gaming?.dtEventTime || ''),
      enabledAt: Date.now()
    }
    savePushList(list)

    const cron = readConfig().battleResultCron || ''
    await e.reply([
      [
        `✅ 已开启战绩推送（营地ID ${campId}）`,
        '打完一局会在本群 @你 并发送战绩，开局也会提醒一次',
        cron ? `检查间隔：${cron}` : '',
        '想连上下线一起提醒发送 #开启上下线提醒'
      ].filter(Boolean).join('\n'),
      Button.push(true)
    ], shouldQuote())
  }

  /** #开启上下线提醒 / #关闭上下线提醒 */
  async toggleOnline (e) {
    const enable = e.msg.includes('开启')
    const qq = String(e.user_id)

    if (!enable) {
      const wasOn = this.disableFlag(qq, 'online')
      await e.reply(wasOn ? '已关闭上下线提醒' : '你还没有开启上下线提醒', shouldQuote())
      return
    }

    const campId = await this.prepareToggle(e, '上下线提醒')
    if (!campId) return

    // 立刻拉一次当前状态做基准。没有基准的话第一轮会把「当前在线」当成刚上线推一条
    const state = await fetchOnlineState(campId, qq)

    if (state === FETCH_HIDDEN) {
      await e.reply('你的营地隐藏了主页，拿不到在线状态，请先在营地里关闭主页隐藏', shouldQuote())
      return
    }

    if (!state) {
      await e.reply('拉取在线状态失败，可能是营地接口频控或登录态失效，请稍后再试', shouldQuote())
      return
    }

    const nowSec = Math.floor(Date.now() / 1000)
    const list = loadPushList()
    const existed = list[qq] || {}
    list[qq] = {
      ...existed,
      online: true,
      // 只开上下线提醒时也要有 group/campId，且不能顺手把战绩推送打开
      battle: existed.battle === true,
      group: String(e.group_id),
      campId: String(campId),
      lastOnlineState: String(state.gameOnline),
      // 订阅时已经在线：没观察到上线瞬间，只能回退到营地的 onlineTime（会做陈旧值检查）
      onlineSince: state.gameOnline !== 0 ? String(resolveOnlineSince(state.onlineTime, nowSec)) : '',
      enabledAt: existed.enabledAt || Date.now()
    }
    savePushList(list)

    const cron = readConfig().battleResultCron || ''
    await e.reply([
      `✅ 已开启上下线提醒（营地ID ${campId}）`,
      `当前状态：${ONLINE_LABEL[state.gameOnline] || '未知'}`,
      '上线和下线时会在本群 @你，下线时附带本次战绩总结',
      cron ? `检查间隔：${cron}（这项会多占一次接口请求）` : '',
      '关闭发送 #关闭上下线提醒'
    ].filter(Boolean).join('\n'), shouldQuote())
  }

  /** #战绩推送状态 */
  async status (e) {
    const qq = String(e.user_id)
    const sub = loadPushList()[qq]
    const cfg = readConfig()

    if (!sub) {
      await e.reply([
        [
          '你还没有开启任何推送',
          '在群里发送 #开启战绩推送 推每局战绩',
          '发送 #开启上下线提醒 推上下线',
          cfg.onlineReminder === false ? '（注意：插件的推送总开关当前是关闭的）' : ''
        ].filter(Boolean).join('\n'),
        Button.push(false)
      ], shouldQuote())
      return
    }

    const battleOn = sub.battle !== false
    const onlineOn = sub.online === true

    await e.reply([
      [
        '📢 推送订阅',
        `战绩推送：${battleOn ? '已开启' : '未开启'}`,
        `上下线提醒：${onlineOn ? '已开启' : '未开启'}`,
        `营地ID：${sub.campId || '—'}`,
        `推送群：${sub.group || '—'}`,
        `检查间隔：${cfg.battleResultCron || '—'}`,
        cfg.onlineReminder === false ? '⚠️ 插件推送总开关已关闭，暂时不会推送' : '',
        battleOn ? '关闭战绩推送发送 #关闭战绩推送' : '开启战绩推送发送 #开启战绩推送',
        onlineOn ? '关闭上下线提醒发送 #关闭上下线提醒' : '开启上下线提醒发送 #开启上下线提醒'
      ].filter(Boolean).join('\n'),
      Button.push(battleOn)
    ], shouldQuote())
  }

  /** #清空王者战绩推送（主人） */
  async clearAll (e) {
    const count = Object.keys(loadPushList()).length
    savePushList({})
    await e.reply(`已清空全部战绩推送订阅（${count} 个）`, shouldQuote())
  }

  /**
   * 定时轮询。一次请求同时判两件事：正在打的局（开局提醒）和新结算的局（战绩推送）。
   */
  async checkAll () {
    if (readConfig().onlineReminder === false) return

    const subs = loadPushList()
    const entries = Object.entries(subs)
    if (!entries.length) return

    if (running) {
      logger.warn(`[王者推送] 上一轮还在跑，本轮跳过（${entries.length} 个订阅，间隔可能设得太短）`)
      return
    }

    running = true
    const heroMap = await getHeroNameMap()

    try {
      for (const [qq, sub] of entries) {
        try {
          await this.checkOne(qq, sub, heroMap)
        } catch (error) {
          logger.error(`[王者推送] 检查 ${qq} 出错: ${error.message}`)
        }
        await sleep(REQUEST_INTERVAL)
      }
    } finally {
      running = false
    }
  }

  /**
   * 检查单个订阅。两个开关各自独立：
   * battle 走战绩列表（1 次请求），online 走主页接口（再 1 次请求），都开就是 2 次。
   * 所以只开战绩推送的人不会因为别人开了上下线提醒而多花请求。
   * @param {string} qq 订阅者
   * @param {object} sub 订阅项
   * @param {Record<string,string>} heroMap heroId -> 英雄名
   */
  async checkOne (qq, sub, heroMap) {
    if (!sub?.group) return

    // 营地ID 动态取，不锁死在订阅时那个：用户 #切换营地 后应该跟着换。
    const campId = getCurrentId(qq)
    if (!campId) {
      logger.debug(`[王者推送] ${qq} 已解绑营地ID，跳过`)
      return
    }

    // 老订阅没有 battle 字段，按开着算（向后兼容首个版本写下的订阅）
    const battleOn = sub.battle !== false
    const onlineOn = sub.online === true

    // 战绩列表：battle 要用来推战绩，online 要用它做下线时的战绩总结，任一开着就得拉
    let data = null
    if (battleOn || onlineOn) {
      data = await fetchLatest(campId, qq)
      if (data === FETCH_HIDDEN) data = null
    }

    if (battleOn && data) {
      const handled = await this.checkBattle(qq, sub, campId, data, heroMap)
      // 换号时 checkBattle 已经重置过游标，本轮不再往下做上下线判断，等下一轮拿新号的基准
      if (handled === 'switched') return
    }

    if (onlineOn) {
      // 两个开关都开时中间隔一下，别把两个端点的请求贴在一起打
      if (battleOn) await sleep(REQUEST_INTERVAL)
      await this.checkOnline(qq, sub, campId, data)
    }
  }

  /**
   * 战绩推送 + 开局提醒。
   * @returns {Promise<'switched'|void>} 检测到换号时返回 'switched'
   */
  async checkBattle (qq, sub, campId, data, heroMap) {
    const latest = (data.list || [])[0] || {}

    // 换号了：两个号的战绩时间线互不相干，直接把游标挪到新号的最新一场，本轮不推。
    // 不重置的话，新号的历史战绩会因为「时间比旧号游标新」被整批当成新战绩推出来。
    if (String(sub.campId || '') !== String(campId)) {
      logger.mark(`[王者推送] ${qq} 营地ID 变更 ${sub.campId} -> ${campId}，重置推送游标`)
      mergeSubState(qq, {
        campId: String(campId),
        lastGameSeq: String(latest.gameSeq || ''),
        lastGameTime: String(latest.dtEventTime || ''),
        lastGamingStart: String(data.gaming?.dtEventTime || ''),
        // 在线状态也一起重置，新号的在线状态和旧号无关
        lastOnlineState: '',
        onlineSince: ''
      })
      return 'switched'
    }

    // 开局提醒。用 gaming.dtEventTime（开局时间戳，一局之内恒定）做去重键，
    // 比 isGaming 布尔值可靠：连着开两局时布尔值可能一直是 true，时间戳会变。
    const gamingStart = String(data.gaming?.dtEventTime || '')
    const needGaming = data.isGaming && gamingStart && gamingStart !== String(sub.lastGamingStart || '')

    // 新结算的战绩
    const fresh = pickNewBattles(data.list, sub)

    if (!needGaming && !fresh.length) return

    // 两件事凑在同一轮时合并成一条消息发。
    // 连着打排位时「上一局结算」和「下一局开局」几乎总是同一轮被读到，
    // 分两条发就是一轮刷两条，合并后阅读顺序也更顺（先说打完什么，再说又开了一局）。
    const blocks = []
    if (fresh.length) blocks.push(this.buildBattleMessage(fresh, data.list, heroMap))
    if (needGaming) {
      blocks.push(`${fresh.length ? '—— 又开了一局 ——\n' : ''}${formatGamingText(data.gaming, heroMap)}`)
    }

    // 头像优先用正在打的那个英雄（反映当前状态），没有就用最新战绩的英雄
    const newest = fresh[fresh.length - 1]
    const icon = (needGaming && data.gaming?.heroIcon) || newest?.heroIcon

    const sent = await this.send(qq, sub.group, blocks.join('\n'), icon)
    if (!sent) return

    // 发送失败时一个游标都不动，下一轮整条消息重试
    const patch = {}
    if (needGaming) patch.lastGamingStart = gamingStart
    if (newest) {
      patch.lastGameSeq = String(newest.gameSeq || '')
      patch.lastGameTime = String(newest.dtEventTime || '')
    }
    mergeSubState(qq, patch)
  }

  /**
   * 上下线提醒。
   *
   * 只在「离线 <-> 非离线」跨越时发，1(在线) <-> 2(游戏中) 的抖动不发 —— 实测账号
   * 1832804263 就在两轮之间从 1 跳到 2（打开了游戏但还没开局），这种每次都提醒就是刷屏。
   *
   * @param {string} qq 订阅者
   * @param {object} sub 订阅项
   * @param {string} campId 当前营地ID
   * @param {object|null} data 战绩列表数据，有的话用来做下线时的战绩总结（不额外请求）
   */
  async checkOnline (qq, sub, campId, data) {
    const state = await fetchOnlineState(campId, qq)
    if (!state || state === FETCH_HIDDEN) return

    const kind = diffOnlineState(state.gameOnline, sub.lastOnlineState)
    const nowSec = Math.floor(Date.now() / 1000)

    if (!kind) {
      // 状态没跨越，只把当前值记下来。
      // 首轮（lastOnlineState 为空）也走这里，等于「只登记不提醒」。
      const patch = { lastOnlineState: String(state.gameOnline) }
      // 已经在线但没有上线时刻（比如订阅时就在线、或换号后重置过），补一个基准
      if (state.gameOnline !== 0 && !sub.onlineSince) {
        patch.onlineSince = String(resolveOnlineSince(state.onlineTime, nowSec))
      }
      mergeSubState(qq, patch)
      return
    }

    let text
    if (kind === 'online') {
      text = formatOnlineText('online', { gameOnline: state.gameOnline })
    } else {
      // 本次在线时长用自己记的上线时刻算：营地的 offlineTime 刚下线时不会立刻更新，
      // 拿它相减会得负数（实测 1557825900：gameOnline 已是 0，offlineTime 仍早于 onlineTime）
      const since = Number(sub.onlineSince) || 0
      text = formatOnlineText('offline', {
        durationSec: since > 0 ? nowSec - since : 0,
        // 收工总结复用本轮已经拉到的战绩列表，没拉到（只开了上下线提醒且列表请求失败）就不带
        session: since > 0 && data ? summarizeSession(data.list, since) : null
      })
    }

    const sent = await this.send(qq, sub.group, text)
    if (!sent) return

    mergeSubState(qq, {
      lastOnlineState: String(state.gameOnline),
      // 上线时记下时刻供下次下线算时长；下线时清空。
      // observed=true：这是我们亲眼看到的 0 -> 非0 跨越，此刻就是上线时刻，
      // 比营地的 onlineTime 可靠（那个字段实测会是几个月前的陈旧值）
      onlineSince: kind === 'online' ? String(resolveOnlineSince(state.onlineTime, nowSec, true)) : ''
    })
  }

  /**
   * 拼多场战绩的消息体。
   * @param {Array<object>} fresh 新场次，从旧到新
   * @param {Array<object>} fullList 完整列表（倒序），用来取「更早一场」比段位星数、算连胜
   * @param {Record<string,string>} heroMap
   */
  buildBattleMessage (fresh, fullList, heroMap) {
    // 只详细展示最近几场，更早的漏推场次折叠成一行，避免刷屏
    const shown = fresh.slice(-MAX_DETAIL_BATTLES)
    const omitted = fresh.length - shown.length

    const blocks = shown.map(item => {
      // 段位星数要和时间上更早的那场比，列表是倒序的，所以是 index + 1
      const index = fullList.findIndex(x => String(x.gameSeq || '') === String(item.gameSeq || ''))
      const prev = index >= 0 ? fullList[index + 1] : undefined
      return formatBattleText(item, prev, heroMap)
    })

    const head = fresh.length > 1
      ? `打完 ${fresh.length} 局${omitted > 0 ? `（较早 ${omitted} 局略过）` : ''}`
      : `打完一局${shown[0]?.mapName ? ` · ${shown[0].mapName}` : ''}`

    const lines = [head, ...blocks]

    const streak = calcStreak(fullList)
    if (streak.count >= 2) {
      lines.push(`${streak.type === 'win' ? '🔥' : '🧊'} 当前 ${streak.count} 连${streak.type === 'win' ? '胜' : '败'}`)
    }

    return lines.join('\n')
  }

  /**
   * 往群里发一条推送。
   * @param {string} qq 要 @ 的人
   * @param {string} groupId 群号
   * @param {string} text 文案
   * @param {string} [iconUrl] 英雄头像 URL，取不到就只发文字
   * @returns {Promise<boolean>} 是否发送成功。失败时不推进游标，下一轮会重试
   */
  async send (qq, groupId, text, iconUrl) {
    try {
      const group = Bot.pickGroup(Number(groupId))
      if (!group?.sendMsg) {
        logger.warn(`[王者推送] 取不到群 ${groupId}，跳过 ${qq}`)
        return false
      }

      const message = [segment.at(Number(qq)), ` ${text}`]

      if (iconUrl) {
        // getLocalImage 带 md5 缓存与占位图识别，同一个英雄头像只会真正下载一次
        const image = await getLocalImage(iconUrl)
        if (image) message.push(segment.image(image))
      }

      await group.sendMsg(message)
      logger.mark(`[王者推送] 已推送给 ${qq}@群${groupId}`)
      return true
    } catch (error) {
      logger.error(`[王者推送] 发送失败 ${qq}@群${groupId}: ${error.message}`)
      return false
    }
  }
}

/** 读配置，读不到时按「开启」处理，和 shouldQuote 的兜底思路一致 */
function readConfig () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}
