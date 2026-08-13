import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginData, PluginPath } from '#components'
import { ApiService, readYamlFile, getUserAvatar, isQQNumber, Button } from '#utils'

// 战绩模式筛选走服务端 option 参数（取值见 morebattlelist 响应里的 options 字段）。
// 各模式的 gametype/battleType 实测值：
//   排位 gametype=4（mapName「排位赛 双排/五排」）
//   巅峰 gametype=14 battleType=32（mapName「巅峰赛」）
const MODE_MAP = [
  { key: '排位', option: 1 },
  { key: '巅峰', option: 4 }
]

// 服务端一页固定 30 场。宽筛模式过滤后可能不足，用 lastTime 游标往前翻页补齐。
const TARGET_COUNT = 30
const HERO_TARGET = 100
const MAX_PAGES = 10

export class QueryGameStats extends plugin {
  constructor() {
    super({
      name: '查询王者战绩',
      dsc: '查询战绩',
      event: 'message',
      priority: 1,
      rule: [
        {
          reg: '^#?(查询|王者)(\\d+)(排位|巅峰)?战绩\\s*(.*)$',
          fnc: 'queryGameStatsBySlot'
        },
        {
          reg: '^#?查战绩\\s*(.+)$',
          fnc: 'queryHeroStats'
        },
        {
          reg: '^#?查(?!询|王)\\s*(.*?)\\s*战\\s*绩\\s*$',
          fnc: 'queryHeroStats'
        },
        {
          reg: '^#?(查询|王者)战绩\\s*(.*)$',
          fnc: 'queryGameStats'
        }
      ]
    })
  }

  async queryGameStats(e) {
    return this.handleQuery(e, e.msg.replace(/^#?(查询|王者)战绩\s*/, ''), 0)
  }

  // #查询2战绩 —— 2 为绑定列表中的营地ID序号；数字大于 9999 时视为直接传营地ID
  // 后面仍可接模式与场次序号，如 #查询2排位战绩3
  async queryGameStatsBySlot(e) {
    const [, , num, mode = '', rest = ''] = e.msg.match(/^#?(查询|王者)(\d+)(排位|巅峰)?战绩\s*(.*)$/) || []
    const value = Number(num)
    if (value > 9999) {
      return this.handleQuery(e, `${mode}${rest}`, 0, value)
    }
    return this.handleQuery(e, `${mode}${rest}`, value)
  }

  async queryHeroStats(e) {
    const heroName = (
      e.msg.match(/^#?查战绩\s*(.+)$/)?.[1] ||
      e.msg.match(/^#?查\s*(.*?)\s*战\s*绩\s*$/)?.[1] ||
      ''
    ).trim()
    if (!heroName) {
      await e.reply('请输入英雄名称，例如：#查英雄战绩 妲己')
      return
    }

    // 解析英雄名 → heroId
    let heroId, matchedName
    try {
      const result = await this.resolveHeroId(heroName)
      heroId = result.heroId
      matchedName = result.matchedName
    } catch (err) {
      await e.reply(err.message)
      return
    }

    const userId = (e.at && !e.atme) ? e.at : e.user_id
    const { qqAvatar, nickname } = await this.getTargetInfo(e, userId)

    const userData = readYamlFile(path.join(PluginData, 'UserData.yaml')) || {}
    const ID = this.getUserID(userData[userId], userId)
    if (!ID) {
      await e.reply([
        segment.image(path.join(PluginPath, 'resources', 'img', '营地ID获取.png')),
        Button.bind()
      ], true)
      return
    }

    let battleList
    try {
      battleList = await this.collectBattles(ID, String(userId), null, { forcePaginate: true })
    } catch (error) {
      logger.error(`[英雄战绩查询] 查询 ${ID} 失败: ${error.message}`)
      await e.reply(ApiService.formatUserFacingError(error, {
        isMaster: Boolean(e.isMaster),
        scene: '英雄战绩查询异常'
      }))
      return
    }

    // 按英雄过滤：多策略匹配，兼容不同 API 版本的字段格式
    const heroBattles = (battleList?.list || []).filter(item => {
      // 方式1：直接比对 heroId 字段（数值或字符串）
      if (item.heroId != null && String(item.heroId) === heroId) return true
      // 方式2：heroId 数值比对
      if (item.heroId != null && Number(item.heroId) === Number(heroId)) return true
      // 方式3：从 heroIcon URL 中提取 heroId00.jpg 模式
      if (item.heroIcon) {
        const m = item.heroIcon.match(/\/(\d+)00\.jpg/)
        if (m && m[1] === heroId) return true
      }
      // 方式4：heroName 直接包含匹配
      if (item.heroName && item.heroName === matchedName) return true
      return false
    })

    const total = battleList?.list?.length || 0
    logger.info(`[英雄战绩查询] ${matchedName}(heroId=${heroId})，总战绩 ${total} 场，命中 ${heroBattles.length} 场`)
    if (total) {
      const sample = battleList.list[0]
      const sampleIconId = sample.heroIcon?.match(/\/(\d+)00\.jpg/)?.[1] || 'N/A'
      logger.info(`[英雄战绩查询] 首条: heroId=${sample.heroId} heroName=${sample.heroName} heroIconId=${sampleIconId} keys=[${Object.keys(sample).join(',')}]`)
      // 列出所有不同的 heroIconId，方便排查
      const iconIds = [...new Set(battleList.list.map(i => i.heroIcon?.match(/\/(\d+)00\.jpg/)?.[1]).filter(Boolean))]
      logger.info(`[英雄战绩查询] 本页 heroIconId 去重: ${iconIds.join(',')}`)
    }

    if (!heroBattles.length) {
      const emptyImg = await puppeteer.screenshot('QueryGameRecordList', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html',
        data: [],
        qqAvatar,
        nickname,
        emptyState: true,
        emptyTitle: `${matchedName} 暂无战绩`,
        emptyDescription: `ID: ${ID} 近期战绩中没有使用过 ${matchedName}`,
        heroLabel: matchedName
      })
      await e.reply([emptyImg, Button.heroStats(matchedName)], true)
      return
    }

    // 统计基于全量，展示取最近 30 场
    const totalGames = heroBattles.length
    const totalWins = heroBattles.filter(item => Number(item.gameresult) === 1).length
    const winRate = Math.round((totalWins / totalGames) * 100)

    const processedData = heroBattles.slice(0, TARGET_COUNT).map(item => ({
      gameType: item.mapName,
      gameTime: item.gametime,
      gameDuration: `${~~(item.usedTime / 60)}分${item.usedTime % 60}秒`,
      ...this.getBattleStats(item),
      heroIcon: item.heroIcon,
      desc: item.desc,
      tags: this.getTags(item),
      gradeGame: item.gradeGame
    }))

    const listImg = await puppeteer.screenshot('QueryGameRecordList', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html',
      data: processedData,
      qqAvatar,
      nickname,
      heroLabel: `${matchedName}（最近${totalGames}场 ${winRate}%胜率）`,
      winningStreak: this.calculateWinningStreak(processedData.map(d => d.gameResult))
    })

    await e.reply([listImg, Button.heroStats(matchedName, ID)], true)
  }

  /**
   * 通过英雄名模糊匹配 heroId。
   * 优先精确匹配，其次前缀匹配，最后包含匹配。
   * @returns {{ heroId: string, matchedName: string }}
   */
  async resolveHeroId(heroName) {
    const heroList = await ApiService.getHeroList()
    if (!Array.isArray(heroList) || !heroList.length) {
      throw new Error('获取英雄列表失败，请稍后再试')
    }

    const name = heroName.trim()

    // 元X 缩写展开：元射→元流之子(射手)、元法→元流之子(法师) 等
    const YUAN_ABBR = { 射: '射手', 法: '法师', 坦: '坦克', 辅: '辅助', 刺: '刺客' }
    const abbr = name.match(/^元(.)/)
    if (abbr && YUAN_ABBR[abbr[1]]) {
      const full = `元流之子(${YUAN_ABBR[abbr[1]]})`
      const hero = heroList.find(h => h.cname === full)
      if (hero) return { heroId: String(hero.ename), matchedName: name }
    }

    // 精确匹配
    let hero = heroList.find(h => h.cname === name)
    // 前缀匹配
    if (!hero) hero = heroList.find(h => h.cname?.startsWith(name))
    // 包含匹配
    if (!hero) hero = heroList.find(h => h.cname?.includes(name))

    if (!hero) {
      throw new Error(`未找到英雄「${name}」，请检查名称`)
    }

    // 元流之子(法师) → 元法 简写
    const simplify = h => h.replace(/元流之子\s*[（(]\s*(.)[^）)]*[）)]/g, '元$1')
    return { heroId: String(hero.ename), matchedName: simplify(hero.cname) }
  }

  async handleQuery(e, rawInput, idSlot = 0, directId = 0) {
    const userId = (e.at && !e.atme) ? e.at : e.user_id
    logger.debug(`用户 ${userId} 请求查询战绩...`)

    const { qqAvatar, nickname } = await this.getTargetInfo(e, userId)

    const userData = readYamlFile(path.join(PluginData, 'UserData.yaml')) || {}
    let input = rawInput || ''

    // 先解析并剥离模式关键词（排位/巅峰），剩下的再按 ID/序号处理
    let mode = null
    for (const m of MODE_MAP) {
      if (input.includes(m.key)) {
        mode = m
        input = input.replace(m.key, '')
        break
      }
    }
    input = input.trim()
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
        ], true)
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
      ], true)
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
      await e.reply([emptyImg, Button.gameStats(ID, 0, mode ? mode.key : '')], true)
      return
    }

    if (index && index < 9999) {
      const battle = battleList.list[index - 1]
      if (!battle) {
        await e.reply(`索引超出范围，当前最多可查询${battleList.list.length}场战绩`)
        return
      }

      const detail = await this.getBattleDetail(ID, battle, String(userId))
      if (detail) {
        try {
          const img = await this.generateDetailImage(detail)
          await e.reply([img, Button.gameStatsDetail(ID, mode ? mode.key : '')], true)
        } catch (err) {
          logger.error(`[战绩查询] 生成图片失败: ${err}`)
          await e.reply('生成战绩详情图片失败，请稍后再试')
        }
      } else {
        await e.reply('获取单场战绩详情失败')
      }
      return
    }

    const processedData = battleList.list.map(item => ({
      gameType: item.mapName,
      gameTime: item.gametime,
      gameDuration: `${~~(item.usedTime / 60)}分${item.usedTime % 60}秒`,
      ...this.getBattleStats(item),
      heroIcon: item.heroIcon,
      desc: item.desc,
      tags: this.getTags(item),
      gradeGame: item.gradeGame
    }))

    const listImg = await puppeteer.screenshot('QueryGameRecordList', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html',
      data: processedData,
      qqAvatar,
      nickname,
      roleJobName: battleList.list[0].roleJobName,
      modeLabel: mode ? mode.key : '',
      winningStreak: this.calculateWinningStreak(processedData.map(d => d.gameResult))
    })

    await e.reply([listImg, Button.gameStats(ID, processedData.length, mode ? mode.key : '')], true)
  }

  /**
   * 拉取战绩列表。指定模式时用服务端 option 精确筛选，
   * 过滤后不足 30 场时用 lastTime 游标继续往前翻页补齐。
   * @param {object} [mode] 模式筛选
   * @param {object} [opts]
   * @param {boolean} [opts.forcePaginate=false] 强制翻满 MAX_PAGES 页（英雄战绩查询用）
   * @returns 与 morebattlelist 的 data 同构的对象，list 已按模式过滤
   */
  async collectBattles(ID, userId, mode, { forcePaginate = false } = {}) {
    const option = mode?.option ?? 0
    const collected = []
    const seen = new Set()
    let lastTime = 0
    let root = null

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { data } = await ApiService.getMoreBattleList(ID, userId, { option, lastTime })
      if (!data) break
      // 保留首页的 invisDes / options 等顶层字段，翻页只累加 list
      if (!root) root = data

      const raw = data.list || []
      const picked = mode?.filter ? raw.filter(mode.filter) : raw

      for (const item of picked) {
        // 翻页边界可能重复返回同一场，按 gameSeq 去重
        const key = String(item.gameSeq ?? `${item.dtEventTime}-${item.heroIcon}`)
        if (seen.has(key)) continue
        seen.add(key)
        collected.push(item)
      }

      logger.debug(`[战绩查询] 第 ${page + 1} 页 option=${option} 返回 ${raw.length} 场，命中 ${picked.length} 场，累计 ${collected.length} 场`)

      if (forcePaginate ? collected.length >= HERO_TARGET : collected.length >= TARGET_COUNT) break
      // 服务端已给干净结果时不必翻页；只有宽筛模式或强制翻页才继续
      if (!forcePaginate && !mode?.filter) break
      if (!data.hasMore || !data.lastTime || data.lastTime === lastTime) break
      lastTime = data.lastTime
    }

    if (!root) return null

    if (collected.length < TARGET_COUNT) {
      logger.debug(`[战绩查询] ${mode ? mode.key : '全部'}模式最终只凑到 ${collected.length} 场（上限 ${MAX_PAGES} 页），该账号可能就是打得少`)
    }

    return { ...root, list: forcePaginate ? collected.slice(0, HERO_TARGET) : collected.slice(0, TARGET_COUNT) }
  }

  async getTargetInfo(e, userId) {
    // 头像统一走 getUserAvatar：官方 QQ 机器人的 user_id 是 openid 而非 QQ 号，
    // 直接拼 q1.qlogo.cn 会回落到默认头像，导致所有人都渲染成同一张图
    const qqAvatar = await getUserAvatar(e, userId)
    let nickname = ''
    try {
      if (e.at && !e.atme) {
        const member = e.group?.pickMember ? e.group.pickMember(userId) : null
        const info = member?.info || (await member?.getInfo?.())
        nickname = info?.card || info?.nickname || member?.card || member?.nickname || ''
      } else {
        nickname = e.sender?.card || e.sender?.nickname || e.nickname || ''
      }
    } catch (err) {
      logger.debug(`[战绩查询] 获取昵称失败: ${err.message}`)
    }
    // 兜底不用 openid（一长串十六进制展示出来很难看），非 QQ 号就显示「召唤师」
    if (!nickname) nickname = isQQNumber(userId) ? String(userId) : '召唤师'
    return { qqAvatar, nickname }
  }

  getUserID(userInfo, userId) {
    if (!userInfo?.ids?.length) {
      logger.debug(`用户 ${userId} 未绑定ID`)
      return null
    }
    return userInfo.ids[userInfo.current]
  }

  async getBattleDetail(ID, battle, requesterBotUserId = '') {
    const { battleType, gameSvrId, relaySvrId, gameSeq, battleDetailUrl } = battle
    const targetRoleId = battleDetailUrl.match(/toAppRoleId=(\d+)/)?.[1]

    let detail
    try {
      ({ data: detail } = await ApiService.getBattledetail(ID, battleType, gameSvrId, relaySvrId, targetRoleId, gameSeq, requesterBotUserId))
    } catch (error) {
      logger.error(`[战绩查询] 获取详情失败: ${error.message}`)
      return null
    }


    if (!detail) {
      logger.error('[战绩查询] 获取战斗详情失败：接口返回空数据')
      return null
    }

    if (!detail?.head?.acntCamp) {
      logger.error('[战绩查询] 战斗详情数据不完整，缺少acntCamp字段')
      return null
    }

    return detail
  }

  // 评价标签 URL → 本地图标
  evalLocalImg = {
    // 顶级分路
    'https://game-1255653016.file.myqcloud.com/manage/custom_wzry_battledetail_tags/4b4f396f8e6d18bdf8bf699b8c5d9be4.png': `file://${path.join(PluginPath, 'resources', 'img', 'top_mid.png')}`,
    'https://game-1255653016.file.myqcloud.com/manage/custom_wzry_battledetail_tags/9eb904626303912a65d9b69bc8d88aa9.png': `file://${path.join(PluginPath, 'resources', 'img', 'top_jungle.png')}`,
    'https://game-1255653016.file.myqcloud.com/manage/custom_wzry_battledetail_tags/5db4fef1bfc72dd2c5ae71b01ef3951b.png': `file://${path.join(PluginPath, 'resources', 'img', 'top_warrior.png')}`,
    'https://game-1255653016.file.myqcloud.com/manage/custom_wzry_battledetail_tags/a8b5101bc81ae64cf96c67ed1ab21975.png': `file://${path.join(PluginPath, 'resources', 'img', 'top_roam.png')}`,
    'https://game-1255653016.file.myqcloud.com/manage/custom_wzry_battledetail_tags/926ba0111984464ad46e72dc93157fcd.png': `file://${path.join(PluginPath, 'resources', 'img', 'top_marksman.png')}`,
    // 金牌
    'https://camp.qq.com/battle/common/evaluateV3/gold_warrior.png': `file://${path.join(PluginPath, 'resources', 'img', 'gold_warrior.png')}`,
    'https://camp.qq.com/battle/common/evaluateV3/gold_archer.png': `file://${path.join(PluginPath, 'resources', 'img', 'gold_archer.png')}`,
    'https://camp.qq.com/battle/common/evaluateV3/gold_mage.png': `file://${path.join(PluginPath, 'resources', 'img', 'gold_mage.png')}`,
    'https://camp.qq.com/battle/common/evaluateV3/gold_support.png': `file://${path.join(PluginPath, 'resources', 'img', 'gold_support.png')}`,
    // 银牌
    'https://camp.qq.com/battle/common/evaluateV3/silver_warrior.png': `file://${path.join(PluginPath, 'resources', 'img', 'silver_warrior.png')}`,
    'https://camp.qq.com/battle/common/evaluateV3/silver_archer.png': `file://${path.join(PluginPath, 'resources', 'img', 'silver_archer.png')}`,
    'https://camp.qq.com/battle/common/evaluateV3/silver_mage.png': `file://${path.join(PluginPath, 'resources', 'img', 'silver_mage.png')}`,
    'https://camp.qq.com/battle/common/evaluateV3/silver_support.png': `file://${path.join(PluginPath, 'resources', 'img', 'silver_support.png')}`
  }

  generateDetailImage = async ({ head, battle, redTeam, blueTeam, redRoles, blueRoles }) => {
    const isBlue = head.acntCamp === blueTeam.acntCamp
    const [myTeam, enemyTeam] = isBlue ? [blueTeam, redTeam] : [redTeam, blueTeam]
    const [myRoles, enemyRoles] = isBlue ? [blueRoles, redRoles] : [redRoles, blueRoles]

    // 为每个玩家补上评价标签（顶级优先，本地图片）
    const TOP_RE = /custom_wzry_battledetail_tags/
    for (const role of [...myRoles, ...enemyRoles]) {
      const bs = role.battleStats || {}
      const urls = [bs.evaluateIconV3, bs.evaluateIconV2, bs.evaluateIcon].filter(Boolean)
      const topTag = urls.find(u => TOP_RE.test(u) && this.evaluateMap[u])
      const medalTag = urls.find(u => !TOP_RE.test(u) && this.evaluateMap[u])
      const bestTag = topTag || medalTag
      bs.evalTag = bestTag ? this.evaluateMap[bestTag] : ''
      // 用本地图标替代远程图片
      if (bestTag && this.evalLocalImg[bestTag]) {
        bs.evalLocalIcon = this.evalLocalImg[bestTag]
      }
    }

    return puppeteer.screenshot('QueryGameRecordDetails', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordDetails.html',
      gameResult: head.gameResult ? '胜利' : '失败',
      gameResultEn: head.gameResult ? 'VICTORY' : 'DEFEAT',
      myTeamColor: isBlue ? '蓝' : '红',
      enemyTeamColor: isBlue ? '红' : '蓝',
      ...this.getTeamData(myTeam, enemyTeam, myRoles, enemyRoles, head, battle)
    })
  }

  getBattleStats = ({ killcnt, deadcnt, assistcnt, gameresult }) => ({
    killCnt: killcnt,
    deadCnt: deadcnt,
    assistCnt: assistcnt,
    gameResult: { 1: '胜利', 2: '失败' }[gameresult] || gameresult
  })

  getTags = ({ desc, evaluateUrlV2, mvpUrlV2, evaluateUrlV3 }) => {
    const tags = []
    if (mvpUrlV2) tags.push('MVP')

    // 顶级标签优先于奖牌：不管来自 V2 还是 V3，只要 URL 包含顶级标签就取它
    const TOP_RE = /custom_wzry_battledetail_tags/
    const v3Tag = evaluateUrlV3 && this.evaluateMap[evaluateUrlV3]
    const v2Tag = evaluateUrlV2 && this.evaluateMap[evaluateUrlV2]
    const v3IsTop = TOP_RE.test(evaluateUrlV3)
    const v2IsTop = TOP_RE.test(evaluateUrlV2)

    if (v3IsTop) {
      tags.push(v3Tag)
    } else if (v2IsTop) {
      tags.push(v2Tag)
    } else {
      tags.push(v3Tag || v2Tag)
    }

    if (desc && !tags.includes(desc)) tags.push(desc)
    return tags.filter(t => t)
  }

  evaluateMap = {
    // 原有的金牌/银牌标签
    'https://camp.qq.com/battle/common/evaluateV3/gold_warrior.png': '金牌战士',
    'https://camp.qq.com/battle/common/evaluateV3/gold_archer.png': '金牌射手',
    'https://camp.qq.com/battle/common/evaluateV3/silver_archer.png': '银牌射手',
    'https://camp.qq.com/battle/common/evaluateV3/gold_mage.png': '金牌法师',
    'https://camp.qq.com/battle/common/evaluateV3/gold_support.png': '金牌辅助',
    'https://camp.qq.com/battle/common/evaluateV3/silver_warrior.png': '银牌战士',
    'https://camp.qq.com/battle/common/evaluateV3/silver_archer.png': '银牌射手',
    'https://camp.qq.com/battle/common/evaluateV3/silver_mage.png': '银牌法师',
    'https://camp.qq.com/battle/common/evaluateV3/silver_support.png': '银牌辅助',
    // 顶级标签 evaluateUrlV3
    'https://game-1255653016.file.myqcloud.com/manage/custom_wzry_battledetail_tags/4b4f396f8e6d18bdf8bf699b8c5d9be4.png': '顶级中路',
    'https://game-1255653016.file.myqcloud.com/manage/custom_wzry_battledetail_tags/9eb904626303912a65d9b69bc8d88aa9.png': '顶级打野',
    'https://game-1255653016.file.myqcloud.com/manage/custom_wzry_battledetail_tags/5db4fef1bfc72dd2c5ae71b01ef3951b.png': '顶级对抗路',
    'https://game-1255653016.file.myqcloud.com/manage/custom_wzry_battledetail_tags/a8b5101bc81ae64cf96c67ed1ab21975.png': '顶级游走',
    'https://game-1255653016.file.myqcloud.com/manage/custom_wzry_battledetail_tags/926ba0111984464ad46e72dc93157fcd.png': '顶级发育路'
  }

  getTeamData = (myTeam, enemyTeam, myRoles, enemyRoles, head, battle) => ({
    tips: head.tips,
    mapName: head.mapName,
    startTime: battle.startTime,
    usedTime: ~~(battle.usedTime / 60),
    matchDesc: head.matchDesc,
    myEconomyRate: (myTeam.money / (myTeam.money + enemyTeam.money)) * 100,
    myMoney: this.formatMoney(myTeam.money),
    myTowerCnt: myTeam.towerCnt,
    enemyMoney: this.formatMoney(enemyTeam.money),
    enemyTowerCnt: enemyTeam.towerCnt,
    myKillDeadAssistCnt: `${myTeam.killCnt}/${myTeam.deadCnt}/${myTeam.assistCnt}`,
    enemyKillDeadAssistCnt: `${enemyTeam.killCnt}/${enemyTeam.deadCnt}/${enemyTeam.assistCnt}`,
    myRoles, enemyRoles,
    ...this.getDragonStats(myTeam, enemyTeam)
  })

  formatMoney = money => money > 1000 ? `${(money / 1000).toFixed(1)}k` : money

  getDragonStats = (my, enemy) => ({
    myBdragon1: my.bdragon1, myBdragon2: my.bdragon2, myBdragon3: my.bdragon3,
    myLdragon1: my.ldragon1, myLdragon2: my.ldragon2,
    enemyBdragon1: enemy.bdragon1, enemyBdragon2: enemy.bdragon2, enemyBdragon3: enemy.bdragon3,
    enemyLdragon1: enemy.ldragon1, enemyLdragon2: enemy.ldragon2
  })

  calculateWinningStreak = results =>
    results.reduce(([max, current], result) =>
      result === '胜利'
        ? [Math.max(max, current + 1), current + 1]
        : result === '失败' ? [max, 0] : [max, current],
      [0, 0])[0]
}
