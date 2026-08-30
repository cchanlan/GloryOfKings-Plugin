import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { readYamlFile, Button, getUserAvatar, shouldQuote } from '#utils'
import { collectRankData, buildRankList, getAllBindings, dedupeTargets, readSnapshot, SNAPSHOT_TTL } from '../utils/rankStore.js'
import { MIN_REQUEST_GAP_MS } from '../utils/api.js'
import { PluginData } from '#components'

/** 榜单最多展示多少人，太长图片会非常高 */
const MAX_ROWS_GROUP = 10
const MAX_ROWS_GLOBAL = 30

export class RankList extends plugin {
  constructor() {
    super({
      name: '王者排行榜',
      dsc: '统计已绑定用户的排位星数与巅峰分排名',
      event: 'message',
      priority: 1,
      rule: [
        { reg: '^#(排位|巅峰)总排名\\s*(刷新)?$', fnc: 'globalRank' },
        { reg: '^#(排位|巅峰)排名\\s*(刷新)?$', fnc: 'groupRank' }
      ]
    })
  }

  /** #排位排名 / #巅峰排名：只统计本群成员 */
  async groupRank(e) {
    const type = e.msg.includes('巅峰') ? 'peak' : 'rank'
    const force = e.msg.includes('刷新')

    if (!e.isGroup) {
      await e.reply('本群排名只能在群里使用，私聊请用 #排位总排名 / #巅峰总排名')
      return
    }

    let memberIds = []
    try {
      const memberMap = await e.group.getMemberMap()
      memberIds = [...memberMap.keys()].map(String)
    } catch (error) {
      logger.warn(`[王者排名] 获取群成员失败: ${error.message}`)
      await e.reply('获取群成员列表失败，可改用 #排位总排名 查看全局排名')
      return
    }

    const memberSet = new Set(memberIds)
    const bindings = getAllBindings().filter(item => memberSet.has(item.botUserId))

    if (!bindings.length) {
      await e.reply([
        '本群还没有人绑定营地ID，先发送 #绑定营地 [营地ID] 加入排名吧',
        Button.bind()
      ])
      return
    }

    await this.render(e, {
      type,
      force,
      bindings,
      scope: '本群',
      isGlobal: false,
      title: `本群${type === 'peak' ? '巅峰分' : '排位'}排行榜`
    })
  }

  /** #排位总排名 / #巅峰总排名：统计全部绑定用户 */
  async globalRank(e) {
    const type = e.msg.includes('巅峰') ? 'peak' : 'rank'
    const force = e.msg.includes('刷新')
    const bindings = getAllBindings()

    if (!bindings.length) {
      await e.reply([
        '还没有人绑定营地ID，先发送 #绑定营地 [营地ID] 加入排名吧',
        Button.bind()
      ])
      return
    }

    await this.render(e, {
      type,
      force,
      bindings,
      scope: '全服',
      isGlobal: true,
      title: `${type === 'peak' ? '巅峰分' : '排位'}总排行榜`
    })
  }

  async render(e, { type, force, bindings, scope, title, isGlobal = false }) {
    // 采集要逐个拉接口（营地有频控，只能串行），命中缓存时很快，需要刷新时先给个提示。
    // 预估耗时按「去重后的账号数 × 全局队列间隔」算：同一个营地ID 被多人绑定时只拉一次，
    // 拿 bindings.length 会高估；节奏由 api.js 的 MIN_REQUEST_GAP_MS 决定，不能在这写死
    const needFetch = force || Date.now() - readSnapshot().updatedAt >= SNAPSHOT_TTL
    if (needFetch) {
      const targetCount = dedupeTargets(bindings).size
      const seconds = Math.ceil(targetCount * MIN_REQUEST_GAP_MS / 1000)
      await e.reply(`正在更新 ${targetCount} 个账号的数据，约需 ${seconds} 秒，请稍候...`)
    }

    let snapshot
    try {
      snapshot = await collectRankData({ force })
    } catch (error) {
      logger.error(`[王者排名] 采集失败: ${error.message}`)
      await e.reply('排行榜数据采集失败，请稍后再试')
      return
    }

    // campId -> botUserId，同一个ID被多人绑定时取第一个，用于回显归属
    const ownerMap = {}
    for (const item of bindings) {
      if (!ownerMap[item.campId]) ownerMap[item.campId] = item.botUserId
    }

    const full = buildRankList(snapshot.entries, type, {
      campIds: bindings.map(item => item.campId),
      ownerMap
    })

    if (!full.length) {
      await e.reply(type === 'peak'
        ? `${scope}暂无巅峰分数据，可能大家都还没打巅峰赛`
        : `${scope}暂无排位数据，请稍后再试`)
      return
    }

    const maxRows = isGlobal ? MAX_ROWS_GLOBAL : MAX_ROWS_GROUP
    const list = full.slice(0, maxRows)

    // 查询者自己的名次：即使掉出前 N 也单独显示一行
    const selfId = String(e.user_id)
    const selfEntry = full.find(item => item.botUserId === selfId)
    const self = selfEntry && selfEntry.index > maxRows ? selfEntry : null

    // 前三名取 QQ 头像做展示，取不到就回落到营地头像
    await Promise.all(list.slice(0, 3).map(async item => {
      if (!item.botUserId) return
      try {
        item.avatar = await getUserAvatar(e, item.botUserId, 100)
      } catch {
        item.avatar = ''
      }
    }))

    const img = await puppeteer.screenshot('RankList', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/RankList.html',
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      imgType: 'webp',
      title,
      scope,
      type,
      isPeak: type === 'peak',
      valueLabel: type === 'peak' ? '巅峰分' : '段位',
      list,
      top3: list.slice(0, 3),
      rest: list.slice(3),
      hasRest: list.length > 3,
      self,
      total: full.length,
      shown: list.length,
      updatedAt: formatTime(snapshot.updatedAt),
      fromCache: snapshot.fromCache
    })

    await e.reply([img, Button.rank(type, isGlobal)], shouldQuote())
  }
}

function formatTime(timestamp) {
  if (!timestamp) return '—'
  const d = new Date(timestamp)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
