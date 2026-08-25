/**
 * 王者战绩日报 / 周报。
 *
 * 数据不是现拉的，读的是 battleArchive 的归档库 —— 实测 `getMoreBattleList`
 * **第一页 30 场、第二页起只给 10 场**，而测试账号一天能打 28 场，
 * 「本周」现拉要翻十几页。战绩推送的轮询在玩家在线时每 2 分钟就拉一次第一页，
 * 顺手落库（挂在 pushStore.fetchLatest 里），日报周报读库就够，零请求。
 * 库不够时才补页，有上限，盖不住的区间在图上如实标注。
 *
 * 分层：
 * - utils/battleArchive.js  归档与补页
 * - utils/reportStore.js    汇总与模板数据（纯计算，可脱机测）
 * - 本文件                   只管指令交互、定时推送、出图
 *
 * 段位星数与巅峰分变化复用 pushStore 的 formatStarChange / formatScoreDelta，
 * 和收工总结同一套判据 —— 那里面的坑（小编号回绕、赛季切换、0 星是真实值）已经踩平了。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import path from 'path'
import { collectBattles } from '../utils/battleArchive.js'
import {
  summarizeReport,
  buildReportView,
  getHeroNameMap,
  todayStart,
  weekStart
} from '../utils/reportStore.js'
import { loadPushList, savePushList, mergeSubState, disableSubFlag, sleep, REQUEST_INTERVAL } from '../utils/pushStore.js'
import {
  getCurrentId, getUserAvatar, Button, shouldQuote, readYamlFile, parsePerfArgs,
  AT_HEAD, stripAtText, resolveTargetUserId
} from '#utils'
import { Config, PluginData } from '#components'

/**
 * 补页上限。日报只要盖住今天（实测单日最多 28 场，30+10+10=50 场足够）；
 * 周报最多 7 天，重度玩家能打 200 场，12 页只有 140 场——盖不住的部分靠 truncated 标注，
 * 不为了凑全而翻二十几页，那样一次日报就把频控预算烧光了。
 */
const MAX_PAGES = { daily: 3, weekly: 12 }

/** 定时推送时每个订阅之间的间隔。出图本身就要一秒多，这里只防接口补页扎堆 */
const PUSH_GAP = REQUEST_INTERVAL

/** 轮询并发锁，两个 task 共用一把：都要出图，撞在一起会把 puppeteer 拖垮 */
let pushing = false

export class BattleReport extends plugin {
  constructor () {
    super({
      name: '王者战绩日报',
      dsc: '按天 / 按周汇总战绩',
      event: 'message',
      // 和 gameRecordPush 一样用 0：queryGameStats 的 `#?(查询|王者)战绩\s*(.*)$` 是宽匹配，
      // 虽然验证过「日报」「周报」不会被它吞掉，但抢先匹配更稳，也符合插件里新指令的惯例
      priority: 0,
      rule: [
        { reg: `${AT_HEAD}#(王者|战绩)日报\\s*(.*)$`, fnc: 'daily' },
        { reg: `${AT_HEAD}#(王者|战绩)周报\\s*(.*)$`, fnc: 'weekly' },
        { reg: '^#(开启|关闭)(王者|战绩)?日报推送$', fnc: 'toggleDaily' },
        { reg: '^#(开启|关闭)(王者|战绩)?周报推送$', fnc: 'toggleWeekly' }
      ]
    })

    const cfg = readConfig()
    // collectTask 支持数组（lib/plugins/loader.js:492），且只收集 cron 和 fnc 都有值的项，
    // 所以配置里把 cron 留空就等于关掉这一路推送
    this.task = [
      { name: '王者战绩日报', cron: cfg.dailyReportCron, fnc: () => this.pushAll('daily'), log: false },
      { name: '王者战绩周报', cron: cfg.weeklyReportCron, fnc: () => this.pushAll('weekly'), log: false }
    ]
  }

  daily (e) {
    return this.render(e, 'daily')
  }

  weekly (e) {
    return this.render(e, 'weekly')
  }

  /** 指令查询 */
  async render (e, kind) {
    const label = kind === 'weekly' ? '周报' : '日报'

    // 支持 @某人 / 序号 / 直接给营地ID，和 #排位表现 那套一致
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint, shouldQuote())

    const input = stripAtText(e.msg).replace(/^#(王者|战绩)(日报|周报)\s*/, '').trim()
    // parsePerfArgs 的分法正好够用：5 位以上当营地ID（营地ID都是 8~10 位），4 位以内当序号
    const args = parsePerfArgs(input)
    let campId = args.campId

    if (!campId && args.count) {
      // 指定序号：#王者日报 2 看第 2 个绑定的号。getCurrentId 只认「当前号」，序号得自己查
      const ids = (readYamlFile(path.join(PluginData, 'UserData.yaml')) || {})[userId]?.ids || []
      campId = ids[args.count - 1] || ''
      if (!campId) {
        return e.reply(`你没有第 ${args.count} 个绑定的营地ID，发送 #营地ID 看看列表`, shouldQuote())
      }
    }

    if (!campId) campId = getCurrentId(userId)

    if (!campId) {
      return e.reply(['你还没有绑定营地ID，先发送 #绑定营地 [营地ID]', Button.bind()], shouldQuote())
    }

    const view = await this.buildView(String(campId), String(userId), kind, { qq: userId, e })

    if (!view) {
      return e.reply(
        kind === 'weekly' ? '本周还没有对局记录' : '今天还没有对局记录',
        shouldQuote()
      )
    }

    const image = await this.shot(view)
    if (!image) return e.reply(`${label}出图失败，请稍后再试`, shouldQuote())

    return e.reply(image, shouldQuote())
  }

  /**
   * 组装一份报告的模板数据。
   * @returns {Promise<object|null>} 区间内没有对局时返回 null（不出空图）
   */
  async buildView (campId, qq, kind, { roleName = '', qq: ownerQQ = '', e = null } = {}) {
    const nowMs = Date.now()
    const fromSec = kind === 'weekly' ? weekStart(nowMs) : todayStart(nowMs)

    let collected
    try {
      collected = await collectBattles(campId, qq, fromSec, { maxPages: MAX_PAGES[kind] || 3 })
    } catch (error) {
      logger.error(`[王者${kind === 'weekly' ? '周报' : '日报'}] ${campId} 取战绩失败: ${error.message}`)
      return null
    }

    if (!collected.battles.length) return null

    const heroMap = await getHeroNameMap()
    const report = summarizeReport(collected.battles, { fromSec, heroMap })
    if (!report.count) return null

    return buildReportView(report, {
      kind,
      fromSec,
      nowMs,
      coveredFrom: collected.coveredFrom,
      truncated: collected.truncated,
      roleName: roleName || this.cachedName(ownerQQ || qq),
      // 营地头像要多一次 profile 请求，日报的重点是战绩不是头像，用平台头像就够。
      // 走 getUserAvatar 而不是裸拼 qlogo：官方机器人的 user_id 是 openid，拼出来是张默认图
      roleIcon: await getUserAvatar(e, ownerQQ || qq, 100)
    })
  }

  /** 订阅项里缓存过的营地昵称（推送轮询和出详情图时会更新），没有就退回空串让模板兜底 */
  cachedName (qq) {
    return String(loadPushList()[String(qq)]?.roleName || '')
  }

  async shot (view) {
    try {
      return await puppeteer.screenshot('BattleReport', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/BattleReport.html',
        // 模板里 CSS / 字体都靠 {{_res_path}} 拼相对路径，漏了这项样式表 404，
        // 出来的是一张没有任何样式的纯文字图（插件里其它 app 也都传这一串）
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        ...view
      })
    } catch (error) {
      logger.error(`[王者战报] 渲染失败: ${error.message}`)
      return null
    }
  }

  /* ---------------------------------------------------------- 订阅开关 */

  toggleDaily (e) {
    return this.toggle(e, 'daily')
  }

  toggleWeekly (e) {
    return this.toggle(e, 'weekly')
  }

  /**
   * 开关一路推送。订阅表复用 GameRecordPush.yaml 的 pushList——
   * group / campId / roleName 都是现成的，没必要再存一份。
   */
  async toggle (e, kind) {
    const label = kind === 'weekly' ? '周报' : '日报'
    const enable = e.msg.includes('开启')
    const qq = String(e.user_id)

    if (!enable) {
      // 走 disableSubFlag 而不是 mergeSubState：四路开关全关了要把整条订阅删掉，
      // 否则留个空壳一直占着 pushList 的名额
      const { wasOn } = disableSubFlag(qq, kind)
      return e.reply(wasOn ? `已关闭战绩${label}推送` : `你还没有开启战绩${label}推送`, shouldQuote())
    }

    if (!e.isGroup) {
      return e.reply(`${label}推送需要在群里开启，报告会发到你开启时所在的群`, shouldQuote())
    }

    const campId = getCurrentId(qq)
    if (!campId) {
      return e.reply(['你还没有绑定营地ID，先发送 #绑定营地 [营地ID]', Button.bind()], shouldQuote())
    }

    // 订阅项可能还不存在（没开过战绩推送），mergeSubState 只改已有项，所以这里要兜底建一条
    const list = loadPushList()
    if (!list[qq]) {
      list[qq] = {
        // 不能顺手把战绩推送/上下线提醒打开，那是两个独立的开关
        battle: false,
        online: false,
        group: String(e.group_id),
        campId: String(campId),
        enabledAt: Date.now()
      }
      savePushList(list)
    }

    mergeSubState(qq, { [kind]: true, group: String(e.group_id), campId: String(campId) })

    const cron = readConfig()[kind === 'weekly' ? 'weeklyReportCron' : 'dailyReportCron'] || ''
    return e.reply([
      [
        `✅ 已开启战绩${label}推送（营地ID ${campId}）`,
        kind === 'weekly' ? '每周会在本群发一张本周战绩总结' : '每天会在本群发一张当日战绩总结',
        cron ? `推送时间：${cron}` : '（主人还没配推送时间，暂时不会自动发）',
        `没有对局的${kind === 'weekly' ? '周' : '天'}不会推送。想立刻看发送 #王者${label}`
      ].join('\n'),
      Button.push(true)
    ], shouldQuote())
  }

  /* ---------------------------------------------------------- 定时推送 */

  /**
   * 遍历订阅推送报告。
   * @param {'daily'|'weekly'} kind
   */
  async pushAll (kind) {
    const label = kind === 'weekly' ? '周报' : '日报'
    const subs = Object.entries(loadPushList()).filter(([, sub]) => sub?.[kind] === true && sub?.group)
    if (!subs.length) return

    if (pushing) {
      logger.warn(`[王者${label}] 上一轮推送还在跑，本轮跳过`)
      return
    }

    pushing = true
    try {
      for (const [qq, sub] of subs) {
        try {
          await this.pushOne(qq, sub, kind)
        } catch (error) {
          logger.error(`[王者${label}] 推送 ${qq} 失败: ${error.message}`)
        }
        await sleep(PUSH_GAP)
      }
    } finally {
      pushing = false
    }
  }

  async pushOne (qq, sub, kind) {
    const label = kind === 'weekly' ? '周报' : '日报'

    // 营地ID 动态取，用户 #切换营地 后跟着换
    const campId = getCurrentId(qq) || sub.campId
    if (!campId) return

    // 群提前取：发消息要用，取头像也要用（getUserAvatar 靠 group.pickMember 认 openid）。
    // 顺带把「群都取不到」挡在补页和出图之前，省掉注定发不出去的那几次请求
    const group = Bot.pickGroup(Number(sub.group))
    if (!group?.sendMsg) {
      logger.warn(`[王者${label}] 取不到群 ${sub.group}，跳过 ${qq}`)
      return
    }

    const view = await this.buildView(String(campId), String(qq), kind, {
      roleName: sub.roleName || '',
      qq,
      // 推送没有真实消息事件，拿群拼个最小壳子够 getUserAvatar 用
      e: { group }
    })

    // 这段时间没打就不发。推一张「0 场」的图纯属刷屏
    if (!view) {
      logger.debug(`[王者${label}] ${qq} 本${kind === 'weekly' ? '周' : '日'}无对局，跳过`)
      return
    }

    const image = await this.shot(view)
    if (!image) return

    try {
      // 这里 @ 本人，和战绩/上下线播报的「不 @」是故意不一致的：那几条是打完那一刻的即时播报，
      // 本人最清楚，@ 只是多刷个红点；日报周报是定时发的总结，本人未必在看群，得叫一下。
      // 名字仍然留在文案和图上，群里其他人不点 @ 也认得出是谁
      await group.sendMsg([
        // 直接给字符串：各适配器内部都会 String(qq)（如 OneBotv11.js 的 makeMsg），
        // 而官bot 的 user_id 是 `appid:openid` 形态，Number() 出来是 NaN，转数字反而会坏
        segment.at(qq),
        ` 📊 ${view.roleName} 的${label}（${view.rangeText}）`,
        image
      ])
      logger.mark(`[王者${label}] 已推送给 ${qq}@群${sub.group}`)
    } catch (error) {
      logger.error(`[王者${label}] 发送失败 ${qq}@群${sub.group}: ${error.message}`)
    }
  }
}

/** 读配置，读不到时返回空对象，和 gameRecordPush 的兜底思路一致 */
function readConfig () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}
