import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { getImgType, shouldQuote, stripAtText } from '#utils'
import { isHeroPowerReady, queryHeroPowerRank } from '../utils/heroPowerShare.js'

/**
 * `#英雄名总排名` —— 跨机器人的英雄战力榜。
 *
 * 数据来源是共享库里各接入方上报的战力（见 utils/heroPowerShare.js 的说明），
 * 不是营地接口——营地只给各模式场次前 5 的英雄，做不了这个。
 *
 * 指令名必须避开 `#排位总排名` / `#巅峰总排名`（apps/rankList.js 的），
 * 那两条是「段位/巅峰分」榜，跟英雄战力是两码事，正则里用负向断言排掉。
 */

/** 英雄头像（营地战斗页特写，裁成横图），跟 apps/heroList.js 用的是同一个源 */
const HERO_IMG_BASE = 'https://game-1255653016.file.myqcloud.com/battle_skin_1250-326'

/** 最多展示多少人：太多图会很高，QQ 里会被折叠 */
const MAX_ROWS = 50

/** 元流之子五个分身的缩写展开，跟 #查战力 用的是同一张表 */
const YUAN_FORMS = { 法: '法师', 射: '射手', 辅: '辅助', 坦: '坦克', 刺: '刺客' }

function expandYuanName (name) {
  const abbr = name.match(/^元(.)$/)
  const form = abbr && YUAN_FORMS[abbr[1]]
  return form ? `元流之子(${form})` : name
}

export class HeroPowerRank extends plugin {
  constructor () {
    super({
      name: '英雄战力总排名',
      dsc: '跨机器人查询某个英雄的战力排名',
      event: 'message',
      priority: 5,
      rule: [
        {
          reg: '^#(?!排位总排名|巅峰总排名)(.+?)\\s*总排名$',
          fnc: 'rank'
        }
      ]
    })
  }

  async rank (e) {
    const raw = stripAtText(e.msg)
      .replace(/^#/, '')
      .replace(/\s*总排名\s*$/, '')
      .trim()
    if (!raw) return

    const heroName = expandYuanName(raw)

    if (!isHeroPowerReady()) {
      await e.reply('这台机器人还没接入营地ID共享库，先让主人用 #营地共享库地址 / #营地共享库令牌 接上', shouldQuote())
      return
    }

    const result = await queryHeroPowerRank(heroName, MAX_ROWS)

    if (!result.ok) {
      await e.reply(result.message || '查询失败，稍后再试', shouldQuote())
      return
    }

    if (!result.list.length) {
      await e.reply([
        `共享库里还没有「${heroName}」的战力数据`,
        '让群友先发一次 #常用英雄 上报自己的战力'
      ].join('\n'), shouldQuote())
      return
    }

    const img = await puppeteer.screenshot('HeroPowerRank', {
      imgType: getImgType(),
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/HeroPowerRank.html',
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      heroName,
      heroIcon: result.heroId
        ? `${HERO_IMG_BASE}/${result.heroId}00.jpg?imageMogr2/thumbnail/x170/crop/270x170/gravity/east`
        : '',
      total: result.total,
      list: result.list.map(item => ({
        rank: item.rank,
        nick: item.nick || '未命名',
        area: item.area || '',
        power: Number(item.power) || 0
      }))
    })

    if (!img) return e.reply('战力排名出图失败，稍后再试', shouldQuote())
    await e.reply(img, shouldQuote())
  }
}
