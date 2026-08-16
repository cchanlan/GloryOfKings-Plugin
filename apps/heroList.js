// 常用英雄榜：数据取自营地赛季页（/game/seasonpage），排位赛在 behavior.rankInfo.heros、
// 巅峰赛在 behavior.masterInfo.heros，两者各是当前赛季场次前 5 的英雄（营地自身的限制）。
// 注意只有传具体 seasonId 时才带 heroFightPower/honorTitle，seasonId=0 的 historyList 里这两个字段是空的。
// 生涯累计榜（/game/profile/herolist）作为赛季无数据时的兜底，字段参考自 https://github.com/KimigaiiWuyi/WzryUID
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ApiService, readYamlFile, getLocalImage, Button } from '#utils'
import path from 'path'
import { PluginData, PluginPath } from '#components'

// 英雄头像图（营地战斗页头像，裁成横图），比赛季页给的横版立绘更贴脸，优先用它
const HERO_IMG_BASE = 'https://game-1255653016.file.myqcloud.com/battle_skin_1250-326'
// 展示数量：营地两个 tab 各给 5 个，合并去重后按战力取前 5
const SHOW_COUNT = 5
// 称号标（郡/城/省/国 冠名）
const HONOR_ICON = {
  1: `file://${path.join(PluginPath, 'resources', 'img', 'icon_honor_county.png')}`,
  2: `file://${path.join(PluginPath, 'resources', 'img', 'icon_honor_city.png')}`,
  3: `file://${path.join(PluginPath, 'resources', 'img', 'icon_honor_province.png')}`,
  4: `file://${path.join(PluginPath, 'resources', 'img', 'icon_honor_contry.png')}`
}

// 荣誉标里的长名简化：元流之子(射手/法师/辅助/坦克/刺客) → 元射/元法/元辅/元坦/元刺
// 荣誉标空间有限，用简写更整齐；英雄名列另有分类副标，不影响识别
function simplifyHeroName(text) {
  if (!text) return text
  return text.replace(/元流之子\s*[（(]\s*(.)[^）)]*[）)]/g, '元$1')
}

// 战力配色，跟营地一致
function fightColor(power) {
  const p = Number(power) || 0
  if (p <= 2500) return '#c8c8c8'
  if (p <= 5000) return '#6f8ef5'
  if (p <= 7500) return '#a24bff'
  if (p <= 10000) return '#f5d76e'
  return '#ff5b7c'
}

// 赛季页的胜率是 0~1 的小数，营地展示成一位小数百分比
function toPercent(rate) {
  const v = Number(rate) || 0
  return `${(v * 100).toFixed(1)}%`
}

// “元流之子(射手)” → { name: '元流之子', subName: '射手' }
function splitHeroName(rawName) {
  const text = rawName || ''
  const matched = text.match(/^(.+?)\s*[（(]([^）)]+)[）)]\s*$/)
  return {
    name: matched ? matched[1] : text,
    subName: matched ? matched[2] : ''
  }
}

export class HeroList extends plugin {
  constructor() {
    super({
      name: '查询王者常用英雄',
      dsc: '查询账号常用英雄的场次/胜率/战力',
      event: 'message',
      priority: 5,
      rule: [
        {
          reg: '^#(王者)?(常用英雄|我的英雄|英雄战力榜)\\s*(.*)$',
          fnc: 'heroList'
        }
      ]
    })
  }

  async heroList(e) {
    const msg = e.msg.replace(/^#(王者)?(常用英雄|我的英雄|英雄战力榜)\s*/, '').trim()
    const userId = (e.at && !e.atme) ? e.at : e.user_id

    const userFilePath = path.join(PluginData, 'UserData.yaml')
    const allUserData = readYamlFile(userFilePath) || {}
    const userInfo = allUserData[userId]

    const ID = msg || (userInfo && userInfo.ids && userInfo.ids.length
      ? userInfo.ids[userInfo.current || 0]
      : null)

    if (!ID) {
      await e.reply(['未查询到营地ID，请先使用 #绑定营地 绑定营地ID，或在指令后附带营地ID', Button.bind()])
      return
    }

    // 先取主页拿 roleId 和昵称/头像
    let profile
    try {
      profile = await ApiService.getProfile(ID, String(userId))
    } catch (error) {
      logger.error(`[常用英雄] 查询主页 ${ID} 失败: ${error.message}`)
      await e.reply(ApiService.formatUserFacingError(error, {
        isMaster: Boolean(e.isMaster),
        scene: '常用英雄查询异常'
      }))
      return
    }

    if (profile?.returnCode === -10107) {
      await e.reply(`ID: ${ID}，召唤师隐藏了主页信息，无法查看`)
      return
    }
    const roleId = profile?.data?.targetRoleId
    if (!roleId) {
      await e.reply('获取角色信息失败，请稍后重试')
      return
    }

    const roleData = (profile.data.roleList || []).find(r => r.roleId === roleId) || {}
    const roleName = roleData.roleName || String(ID)
    const roleIcon = roleData.roleIcon || ''
    // 分区/区服（如“微信/安卓”“QQ/苹果”），用于标明常用英雄数据所属地区
    const roleArea = [roleData.areaName, roleData.roleText].filter(Boolean).join(' · ')

    // 再取当前赛季的排位/巅峰常用英雄
    let picked
    try {
      picked = await this.fetchSeasonHeroes(roleId, userId)
      if (!picked.heroes.length) {
        picked = await this.fetchCareerHeroes(ID, roleId, userId)
      }
    } catch (error) {
      logger.error(`[常用英雄] 查询英雄列表 ${ID} 失败: ${error.message}`)
      await e.reply(ApiService.formatUserFacingError(error, {
        isMaster: Boolean(e.isMaster),
        scene: '常用英雄查询异常'
      }))
      return
    }

    if (!picked.heroes.length) {
      await e.reply('未获取到常用英雄数据，请前往王者营地开启「陌生人可见」后重试')
      return
    }

    const heroes = await Promise.all(picked.heroes.map(hero => this.buildHeroCard(hero)))

    const img = await puppeteer.screenshot('HeroList', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/HeroList.html',
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      ydId: String(ID),
      roleName,
      roleIcon,
      roleArea,
      scopeName: picked.scopeName,
      showModes: picked.showModes,
      heroCount: heroes.length,
      heroes
    })

    await e.reply([img, Button.heroList(msg ? ID : '')], true)
  }

  /**
   * 取当前赛季的排位 + 巅峰常用英雄，按 heroId 合并去重后按战力取前 5。
   * seasonId=0 只用来拿最新赛季号，英雄的战力/称号要再按 seasonId 请求一次才有。
   */
  async fetchSeasonHeroes(roleId, userId) {
    const first = await ApiService.getSeasonpage(roleId, String(userId), 0)
    const history = first?.data?.historyList || []
    const current = history[0]
    if (!current?.seasonId) return { heroes: [], scopeName: '', showModes: true }

    const seasonRes = await ApiService.getSeasonpage(roleId, String(userId), current.seasonId)
    const behavior = seasonRes?.data?.behavior || {}

    // 同一英雄在两个模式里战力/称号一致，场次和胜率各算各的
    const merged = new Map()
    const collect = (list, mode) => {
      for (const hero of list || []) {
        const heroId = hero.heroId
        if (!heroId) continue
        const item = merged.get(heroId) || {
          heroId,
          rawName: hero.heroName || '',
          imgUrl: hero.heroLandscapeIcon || '',
          fightPower: 0,
          honorTitle: null,
          rank: null,
          peak: null,
          totalCnt: 0
        }
        item.fightPower = Math.max(item.fightPower, Number(hero.heroFightPower) || 0)
        item.honorTitle = item.honorTitle || hero.honorTitle || null
        item.imgUrl = item.imgUrl || hero.heroLandscapeIcon || ''
        item[mode] = {
          gameCnt: Number(hero.gameCnt) || 0,
          winRate: toPercent(hero.winRate)
        }
        item.totalCnt += Number(hero.gameCnt) || 0
        merged.set(heroId, item)
      }
    }
    collect(behavior.rankInfo?.heros, 'rank')
    collect(behavior.masterInfo?.heros, 'peak')

    // 战力相同的（如同为满战力 9589）按两模式总场次排前面
    const heroes = [...merged.values()]
      .sort((a, b) => b.fightPower - a.fightPower || b.totalCnt - a.totalCnt)
      .slice(0, SHOW_COUNT)

    return { heroes, scopeName: current.seasonName || '', showModes: true }
  }

  /** 赛季内没打过排位/巅峰时的兜底：生涯累计前 5，只有一组场次/胜率 */
  async fetchCareerHeroes(ID, roleId, userId) {
    const res = await ApiService.getProfileHeroList(ID, roleId, String(userId))
    const heroes = (res?.data?.heroList || []).map(hero => {
      const basic = hero.basicInfo || {}
      return {
        heroId: basic.heroId,
        rawName: basic.title || '',
        imgUrl: '',
        fightPower: Number(basic.heroFightPower) || 0,
        honorTitle: hero.honorTitle || null,
        career: {
          gameCnt: Number(basic.playNum) || 0,
          winRate: basic.winRate || '-'
        },
        rank: null,
        peak: null,
        totalCnt: Number(basic.playNum) || 0
      }
    })
      .sort((a, b) => b.fightPower - a.fightPower || b.totalCnt - a.totalCnt)
      .slice(0, SHOW_COUNT)

    return { heroes, scopeName: '生涯累计', showModes: false }
  }

  /** 补齐渲染要用的头像（转 base64 防截图时加载失败）、配色和称号图标 */
  async buildHeroCard(hero) {
    const { name, subName } = splitHeroName(hero.rawName)
    const honorType = hero.honorTitle?.type
    const honorDesc = hero.honorTitle?.desc

    return {
      name,
      subName,
      imgUrl: await this.resolveHeroImage(hero),
      rankCnt: hero.rank ? hero.rank.gameCnt : (hero.career ? hero.career.gameCnt : ''),
      rankRate: hero.rank ? hero.rank.winRate : (hero.career ? hero.career.winRate : ''),
      peakCnt: hero.peak ? hero.peak.gameCnt : '',
      peakRate: hero.peak ? hero.peak.winRate : '',
      fightPower: hero.fightPower || '-',
      fightColor: fightColor(hero.fightPower),
      honorIcon: honorType ? (HONOR_ICON[honorType] || '') : '',
      honorText: simplifyHeroName(honorDesc?.full || honorDesc?.name || honorDesc?.abbr || '')
    }
  }

  /**
   * 头像优先用战斗页特写图（裁成脸部横图，辨识度高），取不到再用赛季页给的横版立绘。
   * 下载成功的转 base64 内联，避免截图时外链加载失败。
   */
  async resolveHeroImage(hero) {
    const candidates = [
      `${HERO_IMG_BASE}/${hero.heroId}00.jpg?imageMogr2/thumbnail/x170/crop/270x170/gravity/east`,
      hero.imgUrl
    ].filter(Boolean)

    for (const url of candidates) {
      const img = await getLocalImage(url)
      if (Buffer.isBuffer(img)) return `data:image/jpeg;base64,${img.toString('base64')}`
    }

    return candidates[candidates.length - 1] || ''
  }
}
