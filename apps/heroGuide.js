/**
 * #英雄攻略 —— 出装建议 / 铭文推荐 / 英雄关系（搭档·压制·被压制）/ 技能，一张图出完。
 *
 * 两个数据源互补（见 utils/heroGuide.js）：
 *   **官网资料库** —— 两套成套出装 + 官方 Tips、英雄关系、技能。零营地请求，没绑营地ID也能用。
 *   **营地官方接口** —— 3 件核心装备、3 套铭文，每项都带真实胜率与出场率。要登录态，
 *     拿不到就自动跳过这两块，不影响出图。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { Button, shouldQuote, getCurrentId } from '#utils'
import { getHeroGuide, getCampBuild } from '../utils/heroGuide.js'

export class HeroGuide extends plugin {
  constructor () {
    super({
      name: '王者英雄攻略',
      dsc: '英雄出装建议、英雄关系与技能说明（官网资料库）',
      event: 'message',
      // 同 whoIsPlaying：完整锚定的短指令要抢在 queryGameStats 的宽匹配前面
      priority: 0,
      rule: [
        {
          reg: '^#(王者)?(英雄攻略|攻略|出装|克制|铭文出装|铭文)\\s*(.*)$',
          fnc: 'guide'
        }
      ]
    })
  }

  async guide (e) {
    const heroName = e.msg
      .replace(/^#(王者)?(英雄攻略|攻略|出装|克制|铭文出装|铭文)\s*/, '')
      .replace(/的?(出装|攻略|克制关系)?$/, '')
      .trim()

    if (!heroName) {
      await e.reply([
        '请带上英雄名，如：#英雄攻略 孙悟空\n也可以发 #出装 亚瑟 / #克制 妲己',
        Button.hero()
      ], shouldQuote())
      return
    }

    let guide
    try {
      guide = await getHeroGuide(heroName)
    } catch (error) {
      logger.error(`[英雄攻略] ${heroName} 获取失败: ${error.message}`)
      await e.reply(`获取「${heroName}」的攻略失败：${error.message}`, shouldQuote())
      return
    }

    if (!guide) {
      await e.reply(`没找到英雄「${heroName}」，试试写全名，如 #英雄攻略 百里守约`, shouldQuote())
      return
    }

    const { hero, builds, relations, skills } = guide

    if (!builds.length && !relations.length && !skills.length) {
      await e.reply(`「${hero.name}」的资料页暂时没有可用内容，可能官网刚改版，请稍后再试`, shouldQuote())
      return
    }

    // 营地那两块是增强项：有登录态就带上核心装备与铭文，拿不到就照旧只用官网数据
    const camp = await getCampBuild(hero.ename, getCurrentId(e.user_id) || '', String(e.user_id))

    const img = await puppeteer.screenshot('HeroGuide', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/HeroGuide.html',
      heroName: hero.name,
      // fllb_2105 本身可能已经是「对抗路/打野」这种多定位串，原样透传；
      // fzy_8576 是个定位编号（'3'/'4'）不是名字，别拼上去
      heroRole: hero.role,
      heroIntro: hero.intro,
      heroAvatar: hero.avatar,
      heroCover: hero.cover || hero.avatar,
      builds,
      relations,
      skills,
      coreEquips: camp?.coreEquips || [],
      runeSets: camp?.runeSets || []
    })

    await e.reply([img, Button.heroGuide(hero.name)], shouldQuote())
  }
}
