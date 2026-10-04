// 我的英雄：主表取自游戏侧 /play/h5getherolist（全部竞技模式的生涯累计），一次请求拿全量英雄。
// 和 heroList.js 的区别：那边走营地赛季页只有当前赛季 top5，这里是账号拥有的全部英雄（实测一个号 132 条）。
//
// 「战力」列是**历史最高战力**（营地 App 那页右上角「⇄ 历史赛季」的口径），
// 来自营地侧 /hero/getseasonusaullyherolist（seasonId=0），不是 h5getherolist 里的当前值。
// 那个接口顺带把「拿历史最高时的荣耀称号」也放在 honorTitle 里给了，于是以前那套逐英雄拉
// pagedetails 扫称号的流程整个去掉了 —— 实测历史口径的称号是当前口径的超集：
// 有 honorTitle 的英雄，历史那条必定不比 pagedetails 给的差（孙权「中国澳门第58」vs「台北第99」），
// 当前已掉榜的（戈娅）历史接口照样给得出来；而 honorTitle 为 null 的，pagedetails 实测也一律为空。
// 顺带 #我的英雄 15 从十几秒（15 个英雄串行请求）降到 2 个请求。
//
// 两个接口靠 heroId 关联，主表必须用 h5getherolist：它有 winNum 能算总胜率，
// playNum 也是营地那页的口径（孙权 2201），而历史接口的 playNum 是另一套（同英雄 1182），
// 所以只从历史接口补 maxHeroFightPower 与称号两个字段。
// 历史接口拿不到时（没绑角色 / 接口异常）退回显示当前战力，模板列名也跟着变，保证图还能出。
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { getImgType, ApiService, readYamlFile, getLocalImage, Button, AT_HEAD, stripAtText, resolveTargetUserId, resolveUserData, shouldQuote } from '#utils'
import path from 'path'
import { PluginData, PluginPath } from '#components'

// 英雄头像图（营地战斗页头像，裁成横图），和常用英雄榜共用一套
const HERO_IMG_BASE = 'https://game-1255653016.file.myqcloud.com/battle_skin_1250-326'
// 默认展示数量，指令后可跟数字改
const SHOW_COUNT = 10
const MAX_COUNT = 30

// 熟练度等级 → 营地里的叫法。实测 8=神话 7=传说 6=巅峰 5=超凡（对着 pagedetails 的 skilledTitle 核过），
// 4 及以下没实测到，直接显示 Lv.N，不猜。
const SKILLED_NAME = { 8: '神话', 7: '传说', 6: '巅峰', 5: '超凡' }

// 战力配色，跟营地一致（和 heroList.js 同一套阈值）
function fightColor(power) {
  const p = Number(power) || 0
  if (p <= 2500) return '#c8c8c8'
  if (p <= 5000) return '#6f8ef5'
  if (p <= 7500) return '#a24bff'
  if (p <= 10000) return '#f5d76e'
  return '#ff5b7c'
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
    let limit = SHOW_COUNT
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
      await e.reply(['未查询到营地ID，请先使用 #绑定营地 绑定营地ID，或在指令后附带营地ID', Button.bind()])
      return
    }

    let res
    try {
      res = await ApiService.getGameHeroList(ID, String(userId))
    } catch (error) {
      logger.error(`[我的英雄] 查询 ${ID} 失败: ${error.message}`)
      await e.reply(ApiService.formatUserFacingError(error, {
        isMaster: Boolean(e.isMaster),
        scene: '我的英雄查询异常'
      }))
      return
    }

    // 没打过的英雄场次为 0，营地那个页面也不展示，这里同样过滤掉
    const played = (res?.data?.heroList || []).filter(hero => Number(hero.playNum) > 0)
    if (!played.length) {
      await e.reply('未获取到英雄数据，请前往王者营地开启「陌生人可见」后重试')
      return
    }

    // 历史最高战力 + 历史口径称号，一次请求拿全；失败不抛错，下面自动退回当前战力
    const history = await this.fetchHistoryPower(ID, userId)

    const merged = played.map(hero => {
      const hit = history.byHero.get(String(hero.heroId))
      const maxPower = Number(hit?.maxPower) || 0
      return {
        ...hero,
        displayPower: maxPower || Number(hero.heroFightPower) || 0,
        honorText: hit?.honor || ''
      }
    })

    // 默认按战力降序（营地那页「最高战力」列排序），战力相同的场次多的排前面
    const sorted = [...merged].sort(
      (a, b) => b.displayPower - a.displayPower || Number(b.playNum) - Number(a.playNum)
    )
    const picked = sorted.slice(0, limit)

    const heroes = await Promise.all(picked.map(hero => this.buildHeroCard(hero)))

    const totalPlay = played.reduce((sum, hero) => sum + Number(hero.playNum || 0), 0)
    const totalWin = played.reduce((sum, hero) => sum + Number(hero.winNum || 0), 0)

    const img = await puppeteer.screenshot('MyHeroList', {
      imgType: getImgType(),
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/MyHeroList.html',
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      ydId: String(ID),
      heroCount: played.length,
      ownCount: Number(res?.data?.hasData?.heroNum) || played.length,
      shownCount: heroes.length,
      // 历史接口拿不到时图上要如实标成当前口径，不能默认写「最高战力」
      powerLabel: history.ok ? '最高战力' : '战力',
      totalPlay,
      totalRate: totalPlay ? `${((totalWin / totalPlay) * 100).toFixed(1)}%` : '—',
      heroes
    })

    await e.reply([img, Button.heroList(msg ? ID : '')], shouldQuote())
  }

  /**
   * 拉「历史最高战力」与配套的历史口径称号，一次请求拿全。
   * seasonId 传 0 就是营地那页的「历史赛季」（-1 是当前赛季，只回本赛季用过的几个英雄）。
   * 取不到时不抛错：返回空 Map，调用方退回当前战力、模板列名也跟着变，保证图还能出。
   * @param {string} ID 营地ID
   * @param {string|number} userId 发起查询的机器人用户ID
   * @returns {Promise<{ok: boolean, byHero: Map<string, {maxPower: number, honor: string}>}>}
   */
  async fetchHistoryPower(ID, userId) {
    const result = { ok: false, byHero: new Map() }

    // roleId 只能从 profile 拿，不是营地ID
    let roleId = ''
    try {
      const profile = await ApiService.getProfile(ID, String(userId))
      roleId = profile?.data?.targetRoleId || ''
    } catch (error) {
      logger.error(`[我的英雄] 取角色信息失败，战力退回当前值: ${error.message}`)
      return result
    }
    if (!roleId) return result

    try {
      const res = await ApiService.getSeasonUsuallyHeroList(roleId, String(userId), 0)
      for (const item of res?.data?.list || []) {
        const heroId = String(item?.heroId ?? '')
        if (!heroId) continue
        result.byHero.set(heroId, {
          maxPower: Number(item.maxHeroFightPower) || 0,
          honor: String(item?.honorTitle?.desc?.full || '')
        })
      }
      result.ok = result.byHero.size > 0
    } catch (error) {
      logger.error(`[我的英雄] 历史最高战力获取失败，战力退回当前值: ${error.message}`)
    }

    return result
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
      // 这个接口的 winRate 已经是 "53.8%" 这种字符串，不用再换算
      winRate: hero.winRate || '—',
      fightPower: hero.displayPower,
      fightColor: fightColor(hero.displayPower)
    }
  }

  /** 头像优先用战斗页特写图，取不到再用接口给的横版图 */
  async resolveHeroImage(hero) {
    const candidates = [
      `${HERO_IMG_BASE}/${hero.heroId}00.jpg?imageMogr2/thumbnail/x170/crop/270x170/gravity/east`,
      hero.url,
      hero.heroIcon
    ].filter(Boolean)

    for (const url of candidates) {
      const img = await getLocalImage(url)
      if (Buffer.isBuffer(img)) return `data:image/jpeg;base64,${img.toString('base64')}`
    }

    return candidates[candidates.length - 1] || ''
  }
}
