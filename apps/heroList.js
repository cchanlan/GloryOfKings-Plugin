// 常用英雄榜：接口与字段参考自 https://github.com/KimigaiiWuyi/WzryUID
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ApiService, readYamlFile } from '#utils'
import path from 'path'
import { PluginData } from '#components'

// 英雄头像图（营地战斗页头像，裁成横图）
const HERO_IMG_BASE = 'https://game-1255653016.file.myqcloud.com/battle_skin_1250-326'
// 称号标（郡/城/省/国 冠名）
const HONOR_ICON = {
  1: 'https://camp.qq.com/battle/home_v2/icon_honor_county.png',
  2: 'https://camp.qq.com/battle/home_v2/icon_honor_city.png',
  3: 'https://camp.qq.com/battle/home_v2/icon_honor_province.png',
  4: 'https://camp.qq.com/battle/home_v2/icon_honor_contry.png'
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
      await e.reply('未查询到营地ID，请先使用 #绑定营地 绑定营地ID，或在指令后附带营地ID')
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

    // 再取常用英雄列表
    let heroData
    try {
      heroData = await ApiService.getProfileHeroList(ID, roleId, String(userId))
    } catch (error) {
      logger.error(`[常用英雄] 查询英雄列表 ${ID} 失败: ${error.message}`)
      await e.reply(ApiService.formatUserFacingError(error, {
        isMaster: Boolean(e.isMaster),
        scene: '常用英雄查询异常'
      }))
      return
    }

    const heroList = heroData?.data?.heroList
    if (!Array.isArray(heroList) || !heroList.length) {
      await e.reply('未获取到常用英雄数据，请前往王者营地开启「陌生人可见」后重试')
      return
    }

    const heroes = heroList.map(hero => {
      const basic = hero.basicInfo || {}
      const honor = hero.honorTitle
      const honorType = honor?.type
      // 荣誉标为“冠名标”：该英雄在对应区域排名靠前才会拥有
      // desc.full 带地区（如“中国澳门第58孙权”），desc.name/abbr 只是简称，故 full 优先
      const honorText = simplifyHeroName(honor?.desc?.full || honor?.desc?.name || honor?.desc?.abbr || '')
      // 拆分带分类后缀的长名：“元流之子(射手)” → 主名 + 分类，便于两行显示
      const rawName = basic.title || ''
      const nameMatch = rawName.match(/^(.+?)\s*[（(]([^）)]+)[）)]\s*$/)
      const heroName = nameMatch ? nameMatch[1] : rawName
      const heroSubName = nameMatch ? nameMatch[2] : ''
      return {
        name: heroName,
        subName: heroSubName,
        imgUrl: `${HERO_IMG_BASE}/${basic.heroId}00.jpg?imageMogr2/thumbnail/x170/crop/270x170/gravity/east`,
        playNum: basic.playNum ?? '-',
        winRate: basic.winRate ?? '-',
        fightPower: basic.heroFightPower ?? 0,
        fightColor: fightColor(basic.heroFightPower),
        honorIcon: honorType ? (HONOR_ICON[honorType] || '') : '',
        honorText
      }
    })

    const img = await puppeteer.screenshot('HeroList', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/HeroList.html',
      ydId: String(ID),
      roleName,
      roleIcon,
      roleArea,
      heroCount: heroes.length,
      heroes
    })

    await e.reply(img)
  }
}
