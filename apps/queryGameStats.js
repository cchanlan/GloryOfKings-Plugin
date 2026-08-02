import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginData, PluginPath } from '#components'
import { ApiService, readYamlFile, getUserAvatar, isQQNumber } from '#utils'

// 战绩模式筛选走服务端 option 参数（取值见 morebattlelist 响应里的 options 字段）。
// 实测：排位(1) 与 巅峰(4) 是干净的单一模式，一页直接给满 30 场；
//       标准(2) 是宽筛，会连带把排位和快速赛一起返回，所以还要在客户端二次过滤。
// 各模式的 gametype/battleType 实测值：
//   排位 gametype=4（mapName「排位赛 双排/五排」）
//   标准 gametype=5 battleType=5（mapName「王者峡谷」，注意不含「标准」二字）
//   快速赛 gametype=5 battleType=48（mapName「快速赛」，不算标准局）
//   巅峰 gametype=14 battleType=32（mapName「巅峰赛」）
const MODE_MAP = [
  { key: '排位', option: 1 },
  {
    key: '标准',
    option: 2,
    filter: item => Number(item.gametype) === 5 && Number(item.battleType) === 5
  },
  { key: '巅峰', option: 4 }
]

// 服务端一页固定 30 场。宽筛模式过滤后可能不足，用 lastTime 游标往前翻页补齐。
const TARGET_COUNT = 30
const MAX_PAGES = 5

export class QueryGameStats extends plugin {
  constructor() {
    super({
      name: '查询王者战绩',
      dsc: '查询战绩',
      event: 'message',
      priority: 1,
      rule: [
        {
          reg: '^#?(查询|王者)(\\d+)(排位|标准|巅峰)?战绩\\s*(.*)$',
          fnc: 'queryGameStatsBySlot'
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
    const [, , num, mode = '', rest = ''] = e.msg.match(/^#?(查询|王者)(\d+)(排位|标准|巅峰)?战绩\s*(.*)$/) || []
    const value = Number(num)
    if (value > 9999) {
      return this.handleQuery(e, `${mode}${rest}`, 0, value)
    }
    return this.handleQuery(e, `${mode}${rest}`, value)
  }

  async handleQuery(e, rawInput, idSlot = 0, directId = 0) {
    const userId = (e.at && !e.atme) ? e.at : e.user_id
    logger.debug(`用户 ${userId} 请求查询战绩...`)

    const { qqAvatar, nickname } = await this.getTargetInfo(e, userId)

    const userData = readYamlFile(path.join(PluginData, 'UserData.yaml')) || {}
    let input = rawInput || ''

    // 先解析并剥离模式关键词（排位/标准/巅峰），剩下的再按 ID/序号处理
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
        await e.reply(segment.image(path.join(PluginPath, 'resources', 'img', '营地ID获取.png')), true)
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
      await e.reply(segment.image(path.join(PluginPath, 'resources', 'img', '营地ID获取.png')), true)
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

      await e.reply(await puppeteer.screenshot('QueryGameRecordList', {
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
      }), true)
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
          await e.reply(img, true)
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

    e.reply(await puppeteer.screenshot('QueryGameRecordList', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html',
      data: processedData,
      qqAvatar,
      nickname,
      roleJobName: battleList.list[0].roleJobName,
      modeLabel: mode ? mode.key : '',
      winningStreak: this.calculateWinningStreak(processedData.map(d => d.gameResult))
    }), true)
  }

  /**
   * 拉取战绩列表。指定模式时用服务端 option 精确筛选，
   * 宽筛模式（标准）过滤后不足 30 场时用 lastTime 游标继续往前翻页补齐。
   * @returns 与 morebattlelist 的 data 同构的对象，list 已按模式过滤
   */
  async collectBattles(ID, userId, mode) {
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

      if (collected.length >= TARGET_COUNT) break
      // 服务端已给干净结果时不必翻页；只有宽筛模式过滤掉东西了才继续
      if (!mode?.filter) break
      if (!data.hasMore || !data.lastTime || data.lastTime === lastTime) break
      lastTime = data.lastTime
    }

    if (!root) return null

    if (collected.length < TARGET_COUNT) {
      logger.debug(`[战绩查询] ${mode ? mode.key : '全部'}模式最终只凑到 ${collected.length} 场（上限 ${MAX_PAGES} 页），该账号可能就是打得少`)
    }

    return { ...root, list: collected.slice(0, TARGET_COUNT) }
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

  generateDetailImage = async ({ head, battle, redTeam, blueTeam, redRoles, blueRoles }) => {
    const isBlue = head.acntCamp === blueTeam.acntCamp
    const [myTeam, enemyTeam] = isBlue ? [blueTeam, redTeam] : [redTeam, blueTeam]
    const [myRoles, enemyRoles] = isBlue ? [blueRoles, redRoles] : [redRoles, blueRoles]

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
    
    // 优先使用顶级标签 (evaluateUrlV3)，但仅当evaluateMap中有对应值时
    if (evaluateUrlV3 && this.evaluateMap[evaluateUrlV3]) {
      tags.push(this.evaluateMap[evaluateUrlV3])
    } else if (evaluateUrlV2 && this.evaluateMap[evaluateUrlV2]) {
      tags.push(this.evaluateMap[evaluateUrlV2])
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
