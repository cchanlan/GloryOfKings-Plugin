/**
 * 战绩查询：`#战绩` / `#排位战绩` / `#巅峰战绩` / `#查询N战绩` / `#查战绩 <英雄>`。
 *
 * ## 五种指令怎么分流
 *
 * 五条 rule 都收敛到 `handleQuery`（英雄那条除外），区别只在「查谁」和「查什么」：
 *
 * | 指令 | 目标账号 | 模式 | 用途 |
 * |---|---|---|---|
 * | `#战绩` | 自己（或 @ 的人） | 全部 | 最近 30 场列表 |
 * | `#排位战绩` / `#巅峰战绩` | 同上 | 排位 / 巅峰 | 服务端 option 精确筛 |
 * | `#查询2战绩` | 绑定列表里第 2 个 | 全部 | 多账号切换 |
 * | `#查询2排位战绩3` | 第 2 个 | 排位 | 再看第 3 场详情 |
 * | `#查战绩 妲己` | 同上 | 全部 | 按英雄筛（边翻边筛） |
 *
 * 「纯数字」这个位置是**双关**的：≤ 9999 当绑定列表序号，> 9999 当营地 ID 直传。
 * 营地 ID 是 9～10 位数，序号不会有人绑到 9999 个，这个界不会误判。
 *
 * ## 为什么英雄查询要「边翻边筛」
 *
 * 服务端一页固定 30 场，没有按英雄筛的接口。早先的做法是「先翻满 100 场再筛」，
 * 冷门英雄（实测孙权近 100 场只有 10 场）就只出 10 条，看着像被截断。
 * 现在把判据传给翻页循环：**命中满 30 场就收手**，热门英雄两三页就够，
 * 只有真冷门的才翻到 300 场上限。
 */
import fs from 'node:fs'
import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginData, PluginPath } from '#components'
import { getImgType, ApiService, readYamlFile, getUserAvatar, isQQNumber, Button, AT_HEAD, stripAtText, resolveTargetUserId, resolveUserData, shouldQuote, resolveMemberName } from '#utils'
import { estimateRequestSeconds } from '../utils/api.js'
// 详情图与评价图标解析被战绩推送共用，抽到了 utils/battleDetailImage.js
import { fetchBattleDetail, renderBattleDetail, resolveMvp, resolveEvaluate, buildKillTags } from '../utils/battleDetailImage.js'
import { resolveHero } from '../utils/heroName.js'

/**
 * 战绩模式 → 服务端 `option` 参数。
 *
 * 取值来自 `morebattlelist` 响应里的 `options` 字段，实测：
 *   排位 gametype=4（mapName「排位赛 双排/五排」）
 *   巅峰 gametype=14 battleType=32（mapName「巅峰赛」）
 */
const MODE_MAP = [
  { key: '排位', option: 1 },
  { key: '巅峰', option: 4 }
]

/** 按中文名取模式，认不出返回 null（当「全部」处理） */
const findMode = key => MODE_MAP.find(m => m.key === key) || null

/**
 * 一场战绩是不是这个英雄打的。四路匹配兼容不同 API 版本的字段格式。
 *
 * 抽成模块级函数是为了让 `collectBattles` 能边翻边筛（见那边的 match 参数）——
 * 两边用同一份判据，免得筛出来的和展示的对不上。
 */
const matchHero = (item, heroId, matchedName) => {
  // 方式1：直接比对 heroId 字段（数值或字符串）
  if (item.heroId != null && String(item.heroId) === String(heroId)) return true
  // 方式2：heroId 数值比对
  if (item.heroId != null && Number(item.heroId) === Number(heroId)) return true
  // 方式3：从 heroIcon URL 中提取 heroId00.jpg 模式
  if (item.heroIcon) {
    const m = item.heroIcon.match(/\/(\d+)00\.jpg/)
    if (m && m[1] === String(heroId)) return true
  }
  // 方式4：heroName 直接匹配
  if (item.heroName && item.heroName === matchedName) return true
  return false
}

/** 一页固定 30 场，也是列表图默认展示的场数 */
const TARGET_COUNT = 30

/**
 * 英雄战绩要翻到多少场为止。
 *
 * 早先写的是 100：翻满 100 场再按英雄筛，冷门英雄（实测孙权近 100 场里只有 10 场）
 * 就只出 10 条，看着像被截断。改成 300 之后同一账号能凑到 30 场满页
 * （实测 300 场 ≈ 25 天，孙权 30 场）。
 *
 * **但 300 场不是每次都要翻满**：配合下面的 match 回调「筛到够就停」，
 * 热门英雄通常第一页 30 场里就有十几场，翻两三页就够；
 * 只有真正冷门的英雄才会一路翻到上限，那时才付满 28 页的代价。
 */
const HERO_TARGET = 300
const MAX_PAGES = 30

/**
 * 模式筛选（排位/巅峰）的翻页上限。比 MAX_PAGES 小得多是故意的：
 * 服务端 option 已经筛过，第一页通常就有 30 场，只有打得少的号才需要往前翻，
 * 为这种号翻满 10 页不值得（每页一次营地请求、全局队列 1.2 秒一发）。
 */
const MODE_MAX_PAGES = 4

export class QueryGameStats extends plugin {
  constructor () {
    super({
      name: '查询王者战绩',
      dsc: '查询战绩',
      event: 'message',
      priority: 1,
      rule: [
        {
          reg: `${AT_HEAD}#?(排位|巅峰)战绩\\s*(.*)$`,
          fnc: 'queryModeStats'
        },
        {
          reg: `${AT_HEAD}#?(查询|王者)(\\d+)(排位|巅峰)?战绩\\s*(.*)$`,
          fnc: 'queryGameStatsBySlot'
        },
        {
          reg: `${AT_HEAD}#?查战绩\\s*(.+)$`,
          fnc: 'queryHeroStats'
        },
        {
          // `(?!询|王)` 是必要的：否则 `#查询战绩` / `#王者战绩` 会先被这条吃掉，
          // 而它是按英雄查的，会把「战绩」当成英雄名
          reg: `${AT_HEAD}#?查(?!询|王)\\s*(.*?)\\s*战\\s*绩\\s*$`,
          fnc: 'queryHeroStats'
        },
        {
          reg: `${AT_HEAD}#?(查询|王者)战绩\\s*(.*)$`,
          fnc: 'queryGameStats'
        }
      ]
    })
  }

  async queryGameStats (e) {
    return this.handleQuery(e, stripAtText(e.msg).replace(/^#?(查询|王者)战绩\s*/, ''), 0)
  }

  // #排位战绩 / #巅峰战绩 —— 后面可接场次序号或营地ID，如 #排位战绩3
  async queryModeStats (e) {
    const [, key, rest = ''] = stripAtText(e.msg).match(/^#?(排位|巅峰)战绩\s*(.*)$/) || []
    return this.handleQuery(e, rest, 0, 0, findMode(key))
  }

  // #查询2战绩 —— 2 为绑定列表中的营地ID序号；数字大于 9999 时视为直接传营地ID
  // 后面仍可接模式与场次序号，如 #查询2排位战绩3
  async queryGameStatsBySlot (e) {
    const [, , num, key = '', rest = ''] = stripAtText(e.msg).match(/^#?(查询|王者)(\d+)(排位|巅峰)?战绩\s*(.*)$/) || []
    const value = Number(num)
    const mode = findMode(key)
    if (value > 9999) {
      return this.handleQuery(e, rest, 0, value, mode)
    }
    return this.handleQuery(e, rest, value, 0, mode)
  }

  async queryHeroStats (e) {
    const msg = stripAtText(e.msg)
    const heroName = (
      msg.match(/^#?查战绩\s*(.+)$/)?.[1] ||
      msg.match(/^#?查\s*(.*?)\s*战\s*绩\s*$/)?.[1] ||
      ''
    ).trim()
    if (!heroName) {
      await e.reply('请输入英雄名称，例如：#查战绩 妲己 或 #查妲己战绩', shouldQuote())
      return
    }

    // 解析英雄名 → heroId
    let heroId, matchedName
    try {
      const result = await resolveHero(heroName)
      heroId = result.heroId
      matchedName = result.matchedName
    } catch (err) {
      await e.reply(err.message)
      return
    }

    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint)
    const { qqAvatar, nickname } = await this.getTargetInfo(e, userId)

    const userData = await resolveUserData(userId)
    const ID = this.getUserID(userData[userId], userId)
    if (!ID) {
      await e.reply([
        segment.image(path.join(PluginPath, 'resources', 'img', '营地ID获取.png')),
        Button.bind()
      ], shouldQuote())
      return
    }

    let battleList
    try {
      // 边翻边筛：命中满 30 场就停，热门英雄通常两三页就够，冷门英雄才翻到上限。
      // 十几秒没动静用户会以为指令没生效，先给个回执（和群报的做法一致）。
      // 秒数按 MAX_PAGES 估最坏情况（这是「最多约 N 秒」，说多不说少）；
      // 单账号部署下 30 页确实要这么久，池里账号多就会明显更快。
      const seconds = estimateRequestSeconds(MAX_PAGES - 1)
      await e.reply(`正在翻找 ${matchedName} 的近期战绩，最多约 ${seconds} 秒，请稍候...`, shouldQuote())
      battleList = await this.collectBattles(ID, String(userId), null, {
        forcePaginate: true,
        match: item => matchHero(item, heroId, matchedName)
      })
    } catch (error) {
      logger.error(`[英雄战绩查询] 查询 ${ID} 失败: ${error.message}`)
      await e.reply(ApiService.formatUserFacingError(error, {
        isMaster: Boolean(e.isMaster),
        scene: '英雄战绩查询异常'
      }))
      return
    }

    const heroBattles = (battleList?.list || []).filter(item => matchHero(item, heroId, matchedName))

    const total = battleList?.list?.length || 0
    logger.debug(`[英雄战绩查询] ${matchedName}(heroId=${heroId})，总战绩 ${total} 场，命中 ${heroBattles.length} 场`)
    if (total) {
      // 这几条是当初排 heroId 字段格式时加的，字段规律已经写进上面的四路匹配，
      // 平时不需要，留在 debug 档：每次查一个英雄要打三条、还把整条战绩的 key 全列出来
      const sample = battleList.list[0]
      const sampleIconId = sample.heroIcon?.match(/\/(\d+)00\.jpg/)?.[1] || 'N/A'
      logger.debug(`[英雄战绩查询] 首条: heroId=${sample.heroId} heroName=${sample.heroName} heroIconId=${sampleIconId} keys=[${Object.keys(sample).join(',')}]`)
      const iconIds = [...new Set(battleList.list.map(i => i.heroIcon?.match(/\/(\d+)00\.jpg/)?.[1]).filter(Boolean))]
      logger.debug(`[英雄战绩查询] 本页 heroIconId 去重: ${iconIds.join(',')}`)
    }

    if (!heroBattles.length) {
      const emptyImg = await puppeteer.screenshot('QueryGameRecordList', {
        imgType: getImgType(),
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html',
        data: [],
        qqAvatar,
        nickname,
        emptyState: true,
        emptyTitle: `${matchedName} 暂无战绩`,
        emptyDescription: `ID: ${ID} 近期战绩中没有使用过 ${matchedName}`,
        heroLabel: matchedName
      })
      // ⚠️ screenshot 失败返回 false 而不抛错，不判空会把 false 当文本发进群（2026-10-06 修）
      if (!emptyImg) return e.reply('战绩列表出图失败，稍后再试', shouldQuote())
      await e.reply([emptyImg, Button.heroStats(matchedName)], shouldQuote())
      return
    }

    // 命中场次通常刚过 30（每页 30 场，命中数跨过阈值就收手），统计和展示都取最近 30 场，
    // 图头「最近 N 场 X% 胜率」才和下面列的 N 条对得上 —— 早先统计用全量命中、展示只截 30 条，
    // 两个数字会打架。真正冷门的英雄凑不满 30 场时，取到的就是全部，也不丢信息。
    const shown = heroBattles.slice(0, TARGET_COUNT)
    const totalGames = shown.length
    const totalWins = shown.filter(item => Number(item.gameresult) === 1).length
    const winRate = Math.round((totalWins / totalGames) * 100)

    const processedData = shown.map(this.toListItem)

    const listImg = await puppeteer.screenshot('QueryGameRecordList', {
      imgType: getImgType(),
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html',
      data: processedData,
      qqAvatar,
      nickname,
      heroLabel: `${matchedName}（最近${totalGames}场 ${winRate}%胜率）`,
      winningStreak: this.calculateWinningStreak(processedData.map(d => d.gameResult))
    })

    // ⚠️ screenshot 失败返回 false 而不抛错，不判空会把 false 当文本发进群（2026-10-06 修）
    if (!listImg) return e.reply('战绩列表出图失败，稍后再试', shouldQuote())
    await e.reply([listImg, Button.heroStats(matchedName, ID)], shouldQuote())
  }

  /**
   * 非英雄那几条指令的统一入口。
   *
   * @param {string} rawInput 指令里剩下的那段（可能是场次序号，也可能是空）
   * @param {number} idSlot 绑定列表序号（1 起），0 表示用当前选中的账号
   * @param {number} directId 直接传的营地 ID，0 表示没有
   * @param {object} [mode] 模式筛选（排位/巅峰），由指令前缀显式解析，null 表示全部
   */
  async handleQuery (e, rawInput, idSlot = 0, directId = 0, mode = null) {
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint)
    logger.debug(`用户 ${userId} 请求查询战绩...`)

    const { qqAvatar, nickname } = await this.getTargetInfo(e, userId)

    const userData = await resolveUserData(userId)
    const input = (rawInput || '').trim()
    const index = Number(input) || false

    let ID
    if (directId) {
      ID = directId
    } else if (idSlot) {
      const ids = userData[userId]?.ids || []
      if (!ids.length) {
        await e.reply([
          segment.image(path.join(PluginPath, 'resources', 'img', '营地ID获取.png')),
          Button.bind()
        ], shouldQuote())
        return
      }
      ID = ids[idSlot - 1]
      if (!ID) {
        await e.reply(`序号无效，你当前只绑定了 ${ids.length} 个营地ID`)
        return
      }
    } else {
      ID = index > 9999 ? index : this.getUserID(userData[userId], userId)
    }

    if (!ID) {
      await e.reply([
        segment.image(path.join(PluginPath, 'resources', 'img', '营地ID获取.png')),
        Button.bind()
      ], shouldQuote())
      return
    }

    let battleList
    try {
      battleList = await this.collectBattles(ID, String(userId), mode)
    } catch (error) {
      logger.error(`[战绩查询] 查询 ${ID} 失败: ${error.message}`)
      await e.reply(ApiService.formatUserFacingError(error, {
        isMaster: Boolean(e.isMaster),
        scene: '战绩查询异常'
      }))
      return
    }

    if (!battleList?.list?.length) {
      logger.debug('[战绩查询] 战绩列表为空，原始响应数据', {
        targetUserId: String(ID),
        battleList
      })

      const emptyImg = await puppeteer.screenshot('QueryGameRecordList', {
        imgType: getImgType(),
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html',
        data: [],
        qqAvatar,
        nickname,
        emptyState: true,
        emptyTitle: '暂无可查询战绩',
        emptyDescription: mode
          ? `ID: ${ID} 最近没有${mode.key}战绩`
          : (battleList?.invisDes || `ID: ${ID} 当前没有可展示的战绩数据`),
        modeLabel: mode ? mode.key : ''
      })
      // ⚠️ screenshot 失败返回 false 而不抛错，不判空会把 false 当文本发进群（2026-10-06 修）
      if (!emptyImg) return e.reply('战绩列表出图失败，稍后再试', shouldQuote())
      await e.reply([emptyImg, Button.gameStats(ID, 0, mode ? mode.key : '')], shouldQuote())
      return
    }

    // 带序号 = 要看那一场的详情图，不是列表
    if (index && index < 9999) {
      const battle = battleList.list[index - 1]
      if (!battle) {
        await e.reply(`索引超出范围，当前最多可查询${battleList.list.length}场战绩`)
        return
      }

      const detail = await fetchBattleDetail(ID, battle, String(userId))
      if (detail) {
        try {
          const img = await renderBattleDetail(detail)
          await e.reply([img, Button.gameStatsDetail(ID, mode ? mode.key : '')], shouldQuote())
        } catch (err) {
          logger.error(`[战绩查询] 生成图片失败: ${err}`)
          await e.reply('生成战绩详情图片失败，请稍后再试')
        }
      } else {
        await e.reply('获取单场战绩详情失败')
      }
      return
    }

    const processedData = battleList.list.map(this.toListItem)

    const listImg = await puppeteer.screenshot('QueryGameRecordList', {
      imgType: getImgType(),
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html',
      data: processedData,
      qqAvatar,
      nickname,
      roleJobName: battleList.list[0].roleJobName,
      modeLabel: mode ? mode.key : '',
      winningStreak: this.calculateWinningStreak(processedData.map(d => d.gameResult))
    })

    // ⚠️ screenshot 失败返回 false 而不抛错，不判空会把 false 当文本发进群（2026-10-06 修）
    if (!listImg) return e.reply('战绩列表出图失败，稍后再试', shouldQuote())
    await e.reply([listImg, Button.gameStats(ID, processedData.length, mode ? mode.key : '')], shouldQuote())
  }

  /**
   * 拉取战绩列表。指定模式时用服务端 option 精确筛选，
   * 过滤后不足 30 场时用 lastTime 游标继续往前翻页补齐。
   *
   * 翻页条件早先写的是 `!mode?.filter` —— 而 MODE_MAP 的元素只有 { key, option }，
   * 从来没有 filter 字段，于是这个判断恒真，排位/巅峰模式永远只取第一页，
   * 注释承诺的「补齐」对打得少的号根本没生效。现在的判据换成「还没凑够 + 服务端说有更多」，
   * 并给模式筛选单独一档页数上限（MODE_MAX_PAGES），别为了凑满 30 场把频控预算烧光。
   *
   * @param {object} [mode] 模式筛选
   * @param {object} [opts]
   * @param {boolean} [opts.forcePaginate=false] 翻到 HERO_TARGET 场为止（英雄战绩查询用）
   * @param {Function} [opts.match] 逐场判据。给了它就按**命中数**而不是总场数判断「凑够了没」：
   *   命中满 TARGET_COUNT 立即收手，冷门英雄也只需要翻到命中够数那一刻。
   *   不给则按总场数判断（模式筛选那种服务端已经筛过的场景）。
   * @returns 与 morebattlelist 的 data 同构的对象，list 已按模式过滤
   */
  async collectBattles (ID, userId, mode, { forcePaginate = false, match = null } = {}) {
    const option = mode?.option ?? 0
    const target = forcePaginate ? HERO_TARGET : TARGET_COUNT
    const pageLimit = forcePaginate ? MAX_PAGES : (mode ? MODE_MAX_PAGES : 1)
    const collected = []
    const seen = new Set()
    let lastTime = 0
    let root = null
    // 命中数：只有给了 match 才有意义，用来判断「筛出来的够不够展示了」
    let hit = 0

    for (let page = 0; page < pageLimit; page += 1) {
      const { data } = await ApiService.getMoreBattleList(ID, userId, { option, lastTime })
      if (!data) break
      // 保留首页的 invisDes / options 等顶层字段，翻页只累加 list
      if (!root) root = data

      const raw = data.list || []

      for (const item of raw) {
        // 翻页边界可能重复返回同一场，按 gameSeq 去重
        const key = String(item.gameSeq ?? `${item.dtEventTime}-${item.heroIcon}`)
        if (seen.has(key)) continue
        seen.add(key)
        collected.push(item)
        if (match && match(item)) hit += 1
      }

      logger.debug(`[战绩查询] 第 ${page + 1}/${pageLimit} 页 option=${option} 返回 ${raw.length} 场，累计 ${collected.length} 场${match ? `，命中 ${hit} 场` : ''}`)

      // 给了 match 就按命中数收手：凑够展示量就够了，不必把整个窗口翻完
      if (match ? hit >= TARGET_COUNT : collected.length >= target) break
      if (!data.hasMore || !data.lastTime || data.lastTime === lastTime) break
      lastTime = data.lastTime
    }

    if (!root) return null

    if (!match && collected.length < TARGET_COUNT) {
      logger.debug(`[战绩查询] ${mode ? mode.key : '全部'}模式最终只凑到 ${collected.length} 场（上限 ${pageLimit} 页），该账号可能就是打得少`)
    }

    return { ...root, list: collected.slice(0, target) }
  }

  /** 拿头像与昵称。@ 了别人时昵称要按群名片查，不能拿对方 QQ 号当昵称 */
  async getTargetInfo (e, userId) {
    // 头像统一走 getUserAvatar：官方 QQ 机器人的 user_id 是 openid 而非 QQ 号，
    // 直接拼 q1.qlogo.cn 会回落到默认头像，导致所有人都渲染成同一张图
    const qqAvatar = await getUserAvatar(e, userId)

    // 昵称兜底不用 openid（一长串十六进制展示出来很难看），非 QQ 号就显示「召唤师」
    const nickname = String(userId) !== String(e.user_id)
      ? await resolveMemberName(e.group, userId)
      : (e.sender?.card || e.sender?.nickname || e.nickname || (isQQNumber(userId) ? String(userId) : '召唤师'))

    return { qqAvatar, nickname }
  }

  /** 取用户当前选中的营地 ID（没绑定返回 null） */
  getUserID (userInfo, userId) {
    if (!userInfo?.ids?.length) {
      logger.debug(`用户 ${userId} 未绑定ID`)
      return null
    }
    // ⚠️ `current` 缺失/越界时要兜到第一个（2026-10-06 修）：`ids[undefined]` 是 undefined，
    //    调用方拿它判空就会回「营地ID获取」教程图 —— 明明有绑定却说没绑。
    //    同仓读绑定的地方都写了兜底（accountManager.js:389 / :642 都是 `|| ids[0]`）。
    //    实测线上 31 条 UserData 全都带 current，所以是潜在缺陷、当前不触发。
    return userInfo.ids[userInfo.current] ?? userInfo.ids[0] ?? null
  }

  /** 把营地返回的战绩字段换成列表模板认的名字 */
  getBattleStats = ({ killcnt, deadcnt, assistcnt, gameresult }) => ({
    killCnt: killcnt,
    deadCnt: deadcnt,
    assistCnt: assistcnt,
    gameResult: { 1: '胜利', 2: '失败' }[gameresult] || gameresult
  })

  /** 单场战绩 → 列表模板需要的字段 */
  toListItem = item => ({
    gameType: item.mapName,
    gameTime: item.gametime,
    gameDuration: `${~~(item.usedTime / 60)}分${item.usedTime % 60}秒`,
    ...this.getBattleStats(item),
    heroIcon: item.heroIcon,
    desc: item.desc,
    tags: this.getTags(item),
    mvp: resolveMvp(item),
    evaluate: resolveEvaluate([item.evaluateUrlV3, item.evaluateUrlV2, item.evaluateUrl]),
    killTags: buildKillTags(item),
    gradeGame: item.gradeGame
  })

  getTags = ({ desc }) => (desc ? [desc] : [])

  /** 最长连胜：扫一遍，遇「胜利」加一、遇「失败」归零，记下峰值 */
  calculateWinningStreak = results =>
    results.reduce(([max, current], result) =>
      result === '胜利'
        ? [Math.max(max, current + 1), current + 1]
        : result === '失败' ? [max, 0] : [max, current],
      [0, 0])[0]
}
