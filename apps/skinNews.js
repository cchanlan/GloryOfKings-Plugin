/**
 * #皮肤上新 —— 官网资料库里的皮肤日历（今日上线 / 即将上线 / 最近上线），
 * 以及按群订阅的「上新提醒」定时推送。
 *
 * 数据源与判据见 utils/skinNews.js：官网皮肤总表每条都带上线日期，所以
 * **不需要靠 diff 快照就能知道谁是新的**，也不占营地请求配额 —— 没绑营地ID也能用。
 *
 * 推送时间是配置项 `skinNewsCron`（锅巴面板「皮肤上新检查时间」），
 * 留空 = 不自动推送，只保留指令。改完需重启（cron 在 constructor 注册）。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { Button, shouldQuote, pickGroupSafe } from '#utils'
import { Config } from '#components'
import {
  getSkinCalendar, splitCalendar, formatDate, today, QUALITY_COLOR,
  loadSkinNewsStore, setSkinNewsSub, collectSkinNews, markSkinNewsPushed
} from '../utils/skinNews.js'

const readConfig = () => {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/** YYYYMMDD 相差多少天（正数=未来） */
function dayDiff (target, base = today()) {
  const parse = t => new Date(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T00:00:00`)
  return Math.round((parse(target) - parse(base)) / 86400000)
}

/** 给模板补展示字段：日期文案、倒计时/几天前、品质配色 */
function decorate (skin) {
  const diff = dayDiff(skin.online)
  let countdown = ''
  if (diff > 0) countdown = diff === 1 ? '明天' : `${diff} 天后`
  else if (diff < 0) countdown = diff === -1 ? '昨天' : `${-diff} 天前`

  return {
    ...skin,
    dateText: formatDate(skin.online),
    countdown,
    color: QUALITY_COLOR[skin.quality] || '#c8d0dd'
  }
}

export class SkinNews extends plugin {
  constructor () {
    super({
      name: '王者皮肤上新',
      dsc: '皮肤上新日历与上新提醒推送（官网资料库）',
      event: 'message',
      // 同 whoIsPlaying / heroGuide：完整锚定的短指令要抢在 queryGameStats 的宽匹配前面
      priority: 0,
      rule: [
        { reg: '^#(王者)?(皮肤上新|新皮肤|皮肤日历)$', fnc: 'calendar' },
        {
          reg: '^#(开启|关闭)(王者)?皮肤上新推送$',
          fnc: 'toggle',
          // admin 会自动放行主人（同群报），群里则要求管理员
          permission: 'admin'
        }
      ]
    })

    const cfg = readConfig()
    this.task = cfg.skinNewsCron
      ? { name: '王者皮肤上新', cron: cfg.skinNewsCron, fnc: () => this.pushAll(), log: false }
      : { name: '', fnc: '', cron: '' }
  }

  /* ------------------------------------------------------------ 指令查询 */

  async calendar (e) {
    let list
    try {
      list = await getSkinCalendar()
    } catch (error) {
      logger.error(`[皮肤上新] 获取失败: ${error.message}`)
      return e.reply(`获取皮肤上新数据失败：${error.message}`, shouldQuote())
    }

    const { upcoming, todayList, recent } = splitCalendar(list, 8)

    const img = await puppeteer.screenshot('SkinNews', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/SkinNews.html',
      dateText: formatDate(today()),
      pushMode: false,
      todayList: todayList.map(decorate),
      upcoming: upcoming.map(decorate),
      recent: recent.map(decorate)
    })

    await e.reply([img, Button.skinNews(Boolean(loadSkinNewsStore().pushList[String(e.group_id || '')]))], shouldQuote())
  }

  async toggle (e) {
    if (!e.isGroup) {
      return e.reply('皮肤上新推送要在群里开关（推送发到本群）', shouldQuote())
    }

    const enable = e.msg.includes('开启')
    const cfg = readConfig()

    if (enable && !cfg.skinNewsCron) {
      return e.reply('主人把「皮肤上新检查时间」留空了，自动推送是关着的，只能用 #皮肤上新 查', shouldQuote())
    }

    const { changed } = setSkinNewsSub(e.group_id, enable, {
      operator: String(e.user_id),
      groupName: e.group_name || ''
    })

    if (!changed) {
      return e.reply(`本群的皮肤上新推送本来就是${enable ? '开着' : '关着'}的`, shouldQuote())
    }

    await e.reply([
      enable
        ? `已开启本群皮肤上新推送，检查时间：${cfg.skinNewsCron}\n有新皮肤进清单或今天上线时会在本群播报`
        : '已关闭本群皮肤上新推送',
      Button.skinNews(enable)
    ], shouldQuote())
  }

  /* ------------------------------------------------------------ 定时推送 */

  /**
   * 每天一轮：把「今天上线」和「新进清单还没上线」的皮肤推给订阅群。
   * 已推过的按皮肤 ID 去重，所以同一张皮肤只会播报一次（进清单时那次）。
   */
  async pushAll () {
    const groups = Object.keys(loadSkinNewsStore().pushList)
    if (!groups.length) return

    let items
    let store
    try {
      ({ items, store } = await collectSkinNews())
    } catch (error) {
      logger.error(`[皮肤上新] 定时检查失败: ${error.message}`)
      return
    }

    if (!items.length) return

    const todayList = items.filter(s => s.isToday).map(decorate)
    const upcoming = items.filter(s => !s.isToday).map(decorate)

    let img
    try {
      img = await puppeteer.screenshot('SkinNews', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/SkinNews.html',
        dateText: formatDate(today()),
        pushMode: true,
        todayList,
        upcoming,
        recent: []
      })
    } catch (error) {
      logger.error(`[皮肤上新] 出图失败: ${error.message}`)
      return
    }

    const summary = [
      todayList.length ? `今日上线 ${todayList.length} 款` : '',
      upcoming.length ? `新增预告 ${upcoming.length} 款` : ''
    ].filter(Boolean).join(' · ')

    let sent = 0
    for (const groupId of groups) {
      const group = pickGroupSafe(groupId)
      if (!group?.sendMsg) {
        logger.warn(`[皮肤上新] 群 ${groupId} 取不到发送对象，跳过`)
        continue
      }

      try {
        await group.sendMsg([`🎨 皮肤上新 · ${summary}`, img])
        sent += 1
      } catch (error) {
        logger.error(`[皮肤上新] 推送到群 ${groupId} 失败: ${error.message}`)
      }
    }

    // 只要有一个群收到就记下，避免下一轮重复播报；一个群都没发出去时保留，下轮重试
    if (sent > 0) {
      markSkinNewsPushed(store, items)
      logger.mark(`[皮肤上新] 已推送 ${items.length} 款皮肤到 ${sent} 个群`)
    }
  }
}
