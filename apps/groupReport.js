/**
 * 群战绩日报 / 周报 / 月报。
 *
 * 和个人日报（apps/battleReport.js）的关系：汇总层完全共用 utils/reportStore.js，
 * 本文件只多做两件事——「这个群统计谁」和「群级别的订阅开关」，都在
 * utils/groupReportStore.js 里。
 *
 * 统计范围和 #排位排名 一个口径：群成员列表 ∩ 已绑定营地ID 的用户，
 * 每人只算他当前在用的那个营地ID。**每个成员至少要发 1 次营地请求**
 * （collectBattles 必须实拉第一页才敢信本地库是新的，原因见 battleArchive 的注释），
 * 所以成员数有上限（MAX_MEMBERS=25），补页上限也比个人报告小一档。
 *
 * 开关限群主 / 管理员 / 主人：这是全群可见的定时推送，不该让任何人随手开。
 * 手动查（#群日报）不限权限。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { todayStart, weekStart, monthStart, buildGroupView, isMonthlyPushDay } from '../utils/reportStore.js'
import {
  collectGroupReport,
  setGroupFlag,
  listGroupSubs,
  loadGroupSubs,
  isGroupFlagOn,
  resolveGroupTargets,
  GROUP_SUB_FLAGS,
  MAX_MEMBERS
} from '../utils/groupReportStore.js'
import { loadPushList, sleep, REQUEST_INTERVAL } from '../utils/pushStore.js'
import { MIN_REQUEST_GAP_MS } from '../utils/api.js'
import { shouldQuote, Button, getGroupAvatar } from '#utils'
import { Config } from '#components'

/** 三路的中文名 */
const LABEL = { daily: '日报', weekly: '周报', monthly: '月报' }

/** 指令里的「日/周/月」到 kind */
const KIND_BY_CHAR = { 日: 'daily', 周: 'weekly', 月: 'monthly' }

/** 区间起点 */
const RANGE_START = { daily: todayStart, weekly: weekStart, monthly: monthStart }

/** 配置字段名 */
const CRON_KEY = {
  daily: 'groupDailyReportCron',
  weekly: 'groupWeeklyReportCron',
  monthly: 'groupMonthlyReportCron'
}

/** 榜单最多列几个人。和 #排位排名 的群榜一样是 10 上下，太长图会非常高 */
const MAX_ROWS = 15

/** 出图并发锁，三路 task 共用一把：群报要扫几十个号，撞在一起会把频控和 puppeteer 一起拖垮 */
let pushing = false

export class GroupReport extends plugin {
  constructor () {
    super({
      name: '王者群战绩报告',
      dsc: '本群成员的战绩日报 / 周报 / 月报',
      event: 'message',
      // 和 battleReport 一致用 0：queryGameStats 的 `#?(查询|王者)战绩\s*(.*)$` 是宽匹配，
      // 抢在它前面更稳
      priority: 0,
      rule: [
        { reg: '^#(王者|战绩)?群(日|周|月)报$', fnc: 'report' },
        {
          reg: '^#(开启|关闭)(王者|战绩)?群(日|周|月)报推送$',
          fnc: 'toggle',
          // admin 会自动放行主人（loader.js:308 先看 e.isMaster），群里则要求管理员
          permission: 'admin'
        },
        { reg: '^#(王者|战绩)?群报(状态|推送状态)$', fnc: 'status' }
      ]
    })

    const cfg = readConfig()
    this.task = [
      { name: '王者群日报', cron: cfg.groupDailyReportCron, fnc: () => this.pushAll('daily'), log: false },
      { name: '王者群周报', cron: cfg.groupWeeklyReportCron, fnc: () => this.pushAll('weekly'), log: false },
      { name: '王者群月报', cron: cfg.groupMonthlyReportCron, fnc: () => this.pushAll('monthly'), log: false }
    ]
  }

  /* ------------------------------------------------------------ 指令查询 */

  async report (e) {
    const kind = KIND_BY_CHAR[e.msg.match(/群(日|周|月)报/)?.[1]] || 'daily'
    const label = LABEL[kind]

    if (!e.isGroup) {
      return e.reply(`群${label}只能在群里使用，私聊请发送 #王者${label} 看自己的`, shouldQuote())
    }

    const { memberIds, degraded } = await this.resolveMembers(e.group_id, e.group)
    const { targets, bound } = resolveGroupTargets(memberIds)

    if (!targets.length) {
      return e.reply([
        '本群还没有人绑定营地ID，先发送 #绑定营地 [营地ID] 加入群榜吧',
        Button.bind()
      ], shouldQuote())
    }

    // 每个号至少一次请求、全局队列 1.2 秒一发，人多就是几十秒，先给个回执
    const seconds = Math.ceil(targets.length * MIN_REQUEST_GAP_MS / 1000)
    await e.reply(
      `正在汇总本群 ${targets.length} 个账号的${label}数据，约需 ${seconds} 秒，请稍候...`,
      shouldQuote()
    )

    const view = await this.buildView(kind, {
      memberIds,
      groupName: e.group_name || String(e.group_id),
      groupAvatar: await getGroupAvatar(e.group_id, e.group, 640),
      degraded,
      bound
    })

    if (!view) {
      const scope = { daily: '今天', weekly: '本周', monthly: '本月' }[kind]
      return e.reply(`本群${scope}还没有人打过对局`, shouldQuote())
    }

    const image = await this.shot(view)
    if (!image) return e.reply(`群${label}出图失败，请稍后再试`, shouldQuote())

    return e.reply(image, shouldQuote())
  }

  /**
   * 群成员列表。
   *
   * 官方机器人（user_id 是 appid:openid 形态）常拿不到群成员列表，这时降级成
   * 「订阅表里记着 group 是本群的那些人」——不能退回「全部绑定用户」，
   * 那会把别的群的人算进本群榜里。
   *
   * @returns {Promise<{memberIds:Array<string>, degraded:boolean}>}
   */
  async resolveMembers (groupId, group) {
    try {
      const map = await group.getMemberMap()
      const ids = [...map.keys()].map(String)
      if (ids.length) return { memberIds: ids, degraded: false }
    } catch (error) {
      logger.warn(`[王者群报] 取群 ${groupId} 成员失败: ${error.message}`)
    }

    const ids = Object.entries(loadPushList())
      .filter(([, sub]) => String(sub?.group || '') === String(groupId))
      .map(([qq]) => String(qq))

    return { memberIds: ids, degraded: true }
  }

  /**
   * 组装群报的模板数据。
   * @returns {Promise<object|null>} 区间内全群零对局时返回 null（不出空图）
   */
  async buildView (kind, { memberIds = [], groupName = '', groupAvatar = '', degraded = false, bound = 0 } = {}) {
    const nowMs = Date.now()
    const fromSec = (RANGE_START[kind] || todayStart)(nowMs)

    let collected
    try {
      collected = await collectGroupReport({ kind, fromSec, memberIds })
    } catch (error) {
      logger.error(`[王者群${LABEL[kind]}] 采集失败: ${error.message}`)
      return null
    }

    if (!collected.group) return null

    const view = buildGroupView(collected.group, {
      kind,
      fromSec,
      nowMs,
      groupName,
      coveredFrom: collected.coveredFrom,
      truncated: collected.truncated,
      rowLimit: MAX_ROWS,
      scanned: collected.scanned
    })

    // 两种「统计得不全」都要如实说，别让群里以为榜就是全部
    const notes = []
    if (bound > collected.scanned) {
      notes.push(`本群绑定 ${bound} 个账号，只统计了最近活跃的前 ${collected.scanned} 个`)
    }
    if (degraded) notes.push('取不到群成员列表，只统计了开过推送的成员')

    return { ...view, groupAvatar, noteText: notes.join(' · ') }
  }

  async shot (view) {
    try {
      return await puppeteer.screenshot('GroupReport', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/GroupReport.html',
        // 模板里 CSS / 字体都靠 {{_res_path}} 拼相对路径，漏了这项样式表 404，
        // 出来的是一张没有任何样式的纯文字图
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        ...view
      })
    } catch (error) {
      logger.error(`[王者群报] 渲染失败: ${error.message}`)
      return null
    }
  }

  /* ------------------------------------------------------------ 订阅开关 */

  async toggle (e) {
    const kind = KIND_BY_CHAR[e.msg.match(/群(日|周|月)报/)?.[1]] || 'daily'
    const label = LABEL[kind]
    const enable = e.msg.includes('开启')

    if (!e.isGroup) {
      return e.reply(`群${label}推送是群维度的，请在要推送的群里开启`, shouldQuote())
    }

    const groupId = String(e.group_id)

    if (!enable) {
      const { changed } = setGroupFlag(groupId, kind, false)
      return e.reply(changed ? `已关闭本群的群${label}推送` : `本群还没有开启群${label}推送`, shouldQuote())
    }

    const { changed } = setGroupFlag(groupId, kind, true, {
      groupName: e.group_name || '',
      operator: String(e.user_id),
      enabledAt: Date.now()
    })

    if (!changed) return e.reply(`本群已经开着群${label}推送了`, shouldQuote())

    const cron = readConfig()[CRON_KEY[kind]] || ''
    const period = { daily: '每天', weekly: '每周', monthly: '每月' }[kind]
    const unit = { daily: '天', weekly: '周', monthly: '月' }[kind]

    return e.reply([
      `✅ 已开启本群的群${label}推送`,
      `${period}会在本群发一张全员战绩排行榜（最多统计 ${MAX_MEMBERS} 个活跃账号）`,
      cron ? `推送时间：${cron}` : '（主人还没配推送时间，暂时不会自动发）',
      `全群没人打的${unit}不会推送。想立刻看发送 #群${label}`
    ].join('\n'), shouldQuote())
  }

  async status (e) {
    if (!e.isGroup) return e.reply('请在群里发送，查看本群的群报推送状态', shouldQuote())

    const sub = loadGroupSubs()[String(e.group_id)]
    const cfg = readConfig()

    const lines = GROUP_SUB_FLAGS.map(kind => {
      const on = isGroupFlagOn(sub, kind)
      const cron = cfg[CRON_KEY[kind]] || ''
      return `群${LABEL[kind]}：${on ? '已开启' : '未开启'}${on && cron ? `（${cron}）` : ''}${on && !cron ? '（主人未配推送时间）' : ''}`
    })

    let bound = 0
    try {
      const { memberIds } = await this.resolveMembers(e.group_id, e.group)
      bound = resolveGroupTargets(memberIds).bound
    } catch {
      bound = 0
    }

    return e.reply([
      `📊 本群群报推送状态`,
      ...lines,
      `本群参与统计的账号：${bound} 个（上限 ${MAX_MEMBERS}）`,
      '开关指令：#开启群日报推送 / #关闭群周报推送（限群管理）',
      '手动查看：#群日报 / #群周报 / #群月报'
    ].join('\n'), shouldQuote())
  }

  /* ------------------------------------------------------------ 定时推送 */

  async pushAll (kind) {
    const label = LABEL[kind]

    // 月报的 cron 是 28-31 号每晚触发，只有真正的月末才推完整的一个月
    if (kind === 'monthly' && !isMonthlyPushDay()) {
      logger.debug(`[王者群${label}] 今天不是本月最后一天，跳过`)
      return
    }

    const subs = listGroupSubs(kind)
    if (!subs.length) return

    if (pushing) {
      logger.warn(`[王者群${label}] 上一轮推送还在跑，本轮跳过`)
      return
    }

    pushing = true
    try {
      for (const { groupId, sub } of subs) {
        try {
          await this.pushOne(groupId, sub, kind)
        } catch (error) {
          logger.error(`[王者群${label}] 推送群 ${groupId} 失败: ${error.message}`)
        }
        await sleep(REQUEST_INTERVAL)
      }
    } finally {
      pushing = false
    }
  }

  async pushOne (groupId, sub, kind) {
    const label = LABEL[kind]

    const group = Bot.pickGroup(Number(groupId))
    if (!group?.sendMsg) {
      logger.warn(`[王者群${label}] 取不到群 ${groupId}，跳过`)
      return
    }

    const { memberIds, degraded } = await this.resolveMembers(groupId, group)
    const { targets, bound } = resolveGroupTargets(memberIds)
    if (!targets.length) {
      logger.debug(`[王者群${label}] 群 ${groupId} 没有绑定账号，跳过`)
      return
    }

    const view = await this.buildView(kind, {
      memberIds,
      groupName: sub.groupName || String(groupId),
      groupAvatar: await getGroupAvatar(groupId, group, 640),
      degraded,
      bound
    })

    // 全群零对局就不发，推一张空图纯属刷屏
    if (!view) {
      logger.debug(`[王者群${label}] 群 ${groupId} 本区间无对局，跳过`)
      return
    }

    const image = await this.shot(view)
    if (!image) return

    try {
      // 群报是给全群看的，不 @ 任何人；图在前、一行图注在后，和个人日报的排版一致
      await group.sendMsg([image, `📊 本群${label}（${view.rangeText}）· ${view.scannedText}`])
      logger.mark(`[王者群${label}] 已推送到群 ${groupId}`)
    } catch (error) {
      logger.error(`[王者群${label}] 发送失败 群${groupId}: ${error.message}`)
    }
  }
}

/** 读配置，读不到时返回空对象，和 battleReport 的兜底思路一致 */
function readConfig () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}
