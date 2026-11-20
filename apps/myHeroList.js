// 我的英雄读取营地原生英雄页的生涯数据，不再碰被限流的游戏侧全量接口。
import puppeteer from '../utils/uiRender.js'
import { getImgType, ApiService, getLocalImage, Button, replyCampIdGuide, CAMP_ID_GUIDE_HINT, CAMP_ID_SUFFIX_HINT, AT_HEAD, stripAtText, resolveTargetUserId, resolveUserData, shouldQuote } from '#utils'
import { getMyHeroRoster, DEFAULT_MY_HERO_COUNT, compareMyHeroRows } from '../utils/myHeroRoster.js'
import { heroPowerColor } from '../utils/heroPowerColor.js'

// 营地头像缺失时使用的战斗页立绘备用源
const HERO_IMG_BASE = 'https://game-1255653016.file.myqcloud.com/battle_skin_1250-326'
// 默认展示数量，指令后可跟数字改
const MAX_COUNT = 30

// 熟练度等级 → 营地里的叫法。实测 8=神话 7=传说 6=巅峰 5=超凡（对着 pagedetails 的 skilledTitle 核过），
// 4 及以下没实测到，直接显示 Lv.N，不猜。
const SKILLED_NAME = { 8: '神话', 7: '传说', 6: '巅峰', 5: '超凡' }

// “元流之子(射手)” → { name: '元流之子', subName: '射手' }
function splitHeroName(rawName) {
  const text = rawName || ''
  const matched = text.match(/^(.+?)\s*[（(]([^）)]+)[）)]\s*$/)
  return {
    name: matched ? matched[1] : text,
    subName: matched ? matched[2] : ''
  }
}

export class MyHeroList extends plugin {
  constructor() {
    super({
      name: '查询王者我的英雄',
      dsc: '查询账号全部英雄的场次/胜率/最高战力',
      event: 'message',
      priority: 5,
      rule: [
        {
          reg: `${AT_HEAD}#(王者)?我的英雄\\s*(.*)$`,
          fnc: 'myHeroList'
        }
      ]
    })
  }

  async myHeroList(e) {
    const msg = stripAtText(e.msg).replace(/^#(王者)?我的英雄\s*/, '').trim()
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint)

    // 指令后可以混着写营地ID和展示数量：营地ID是 5 位以上，数量是 4 位以内
    let ID = ''
    let limit = DEFAULT_MY_HERO_COUNT
    for (const tok of msg.split(/[\s,，、]+/).filter(Boolean)) {
      if (!/^\d+$/.test(tok)) continue
      if (tok.length >= 5) ID = tok
      else limit = Math.min(Math.max(Number(tok), 1), MAX_COUNT)
    }

    if (!ID) {
      const userInfo = (await resolveUserData(userId))[userId]
      ID = userInfo?.ids?.[userInfo.current || 0] || ''
    }

    if (!ID) {
      await replyCampIdGuide(e, `${CAMP_ID_SUFFIX_HINT}\n${CAMP_ID_GUIDE_HINT}`, shouldQuote())
      return
    }

    let res
    try {
      res = await getMyHeroRoster(ApiService, ID, String(e.user_id))
    } catch (error) {
      logger.error(`[我的英雄] 查询 ${ID} 失败: ${error.message}`)
      await e.reply(ApiService.formatUserFacingError(error, {
        isMaster: Boolean(e.isMaster),
        scene: '我的英雄查询异常'
      }))
      return
    }

    // 仅过滤生涯无对局的英雄；场次、胜率来自同一份完整生涯列表。
    const played = res.heroes.filter(hero => Number(hero.playNum) > 0)
    if (!played.length) {
      await e.reply('营地生涯记录中暂无英雄对局')
      return
    }
    // 默认按战力降序（营地那页「最高战力」列排序），战力相同的场次多的排前面
    const picked = played.sort(compareMyHeroRows).slice(0, limit)

    const heroes = await Promise.all(picked.map(hero => this.buildHeroCard(hero)))

    const totalPlay = played.reduce((sum, hero) => sum + Number(hero.playNum || 0), 0)

    const img = await puppeteer.screenshot('MyHeroList', {
      imgType: getImgType(),
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/MyHeroList.html',
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      ydId: String(ID),
      heroCount: played.length,
      ownCount: res.ownCount,
      shownCount: heroes.length,
      totalPlay,
      totalRate: res.totalRate,
      profileRate: res.profileRate,
      hasCurvePower: heroes.some(hero => hero.fromTodayCurve),
      hasMissingPower: heroes.some(hero => hero.seasonPower == null),
      dataScopeLabel: res.dataScopeLabel,
      playScopeLabel: res.playScopeLabel,
      previewNote: res.previewNote,
      heroes
    })

    // ⚠️ screenshot 失败返回 false 而不抛错，不判空会把 false 当文本发进群（2026-10-06 修）
    if (!img) return e.reply('我的英雄出图失败，稍后再试', shouldQuote())
    await e.reply([img, Button.heroList(msg ? ID : '')], shouldQuote())
  }

  /** 整理成模板要的结构，头像转 base64 防截图时外链加载失败 */
  async buildHeroCard(hero) {
    const { name, subName } = splitHeroName(hero.name)
    const level = Number(hero.skilledLevel) || 0

    return {
      name,
      subName,
      // heroTypes 是数组（瑶是 ["辅助","法师"]），对应营地那页英雄名下面的定位
      heroType: (hero.heroTypes || []).join('/') || hero.heroType || '',
      skilledText: level ? (SKILLED_NAME[level] ? `${SKILLED_NAME[level]}` : `Lv.${level}`) : '',
      // 称号取的是拿历史最高战力时的那个，原样展示（「中国澳门第58孙权」）
      honorText: hero.honorText || '',
      imgUrl: await this.resolveHeroImage(hero),
      playNum: Number(hero.playNum) || 0,
      // 胜率直接使用营地返回的字符串，不从百分比反推胜场
      winRate: hero.winRate || '—',
      historyPower: hero.historyPower,
      historyColor: heroPowerColor(hero.historyPower || null),
      seasonPower: hero.seasonPower,
      seasonColor: heroPowerColor(hero.seasonPower),
      fromTodayCurve: hero.seasonPowerSource === 'today-curve'
    }
  }

  /** 优先使用营地提供的方形头像，避免横向立绘被二次裁切。 */
  async resolveHeroImage(hero) {
    const candidates = [
      hero.url,
      hero.heroIcon,
      `${HERO_IMG_BASE}/${hero.heroId}00.jpg?imageMogr2/thumbnail/x170/crop/270x170/gravity/east`
    ].filter(Boolean)

    for (const url of candidates) {
      const img = await getLocalImage(url)
      if (Buffer.isBuffer(img)) return `data:image/jpeg;base64,${img.toString('base64')}`
    }

    return candidates[candidates.length - 1] || ''
  }
}
