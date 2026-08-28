/**
 * #英雄攻略 —— 出装建议 / 英雄关系（搭档·压制·被压制）/ 技能，一张图出完。
 *
 * 数据全部来自王者荣耀**官网**英雄资料库（见 utils/heroGuide.js），
 * 所以这条指令**一次营地请求都不发**，也不吃营地频控：没绑营地ID的人照样能用。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { Button, shouldQuote } from '#utils'
import { getHeroGuide } from '../utils/heroGuide.js'

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
          reg: '^#(王者)?(英雄攻略|攻略|出装|克制|铭文出装)\\s*(.*)$',
          fnc: 'guide'
        }
      ]
    })
  }

  async guide (e) {
    const heroName = e.msg
      .replace(/^#(王者)?(英雄攻略|攻略|出装|克制|铭文出装)\s*/, '')
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
      skills
    })

    await e.reply([img, Button.heroGuide(hero.name)], shouldQuote())
  }
}
