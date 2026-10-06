/**
 * #英雄攻略 —— 出装建议 / 铭文推荐 / 英雄关系（搭档·压制·被压制）/ 技能，一张图出完。
 *
 * 两个数据源互补（见 utils/heroGuide.js）：
 *   **官网资料库** —— 两套成套出装 + 官方 Tips、英雄关系、技能。零营地请求，没绑营地ID也能用。
 *   **营地官方接口** —— 3 件核心装备、3 套铭文，每项都带真实胜率与出场率。要登录态，
 *     拿不到就自动跳过这两块，不影响出图。
 *
 * ## 为什么指令拆成了两个文件（2026-10-05）
 *
 * 本类只有**带「王者」前缀**的指令，priority 0（同 whoIsPlaying：完整锚定的短指令抢在
 * queryGameStats 的宽匹配前面）。不带前缀的 `#攻略 / #出装 / #铭文 / #克制` 挪到了
 * apps/heroGuideAlias.js、priority 降到 5000 —— 原神等别的插件也有同名指令，
 * 裸指令挂 0 会抢在它们前面把消息吞掉（真发生过）。
 *
 * 拆文件是因为云崽的 priority 按**类**算、而插件 index.js 每个文件只注册**一个导出**
 * （字母序第一个，campIm.js 的注释里踩过同款坑），两个优先级只能是两个文件。
 * 出图逻辑沉淀成下面的 `runHeroGuide` 共用，别复制两份。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { getImgType, Button, shouldQuote, resolveCurrentId, AT_HEAD, stripAtText, ApiService } from '#utils'
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
          // ⚠️ 用 AT_HEAD 替掉 ^（2026-10-06 修）：手打/粘贴出来的「@昵称」到 Bot 这边只是
          //    一段纯文本、顶在指令前面，硬 ^ 锚点直接匹配不上 → 整条消息静默无响应。
          //    同组其余入口（myHeroList / heroDetail / heroMedalWall / myKingHomepage）都用了 AT_HEAD。
          reg: `${AT_HEAD}#王者(英雄攻略|攻略|出装|克制|铭文出装|铭文)\\s*(.*)$`,
          fnc: 'guide'
        }
      ]
    })
  }

  async guide (e) {
    return runHeroGuide(e)
  }
}

/**
 * 出攻略的公共体，HeroGuide（本文件）和 HeroGuideAlias（heroGuideAlias.js）共用。
 * 解析入口对「带不带王者前缀」都吃得下，两个注册类的正侧只管收口到这里。
 */
async function runHeroGuide (e) {
  // ⚠️ 解析前必须先剥掉前置的纯文本 @（只补正则不改这里的话，会拿「@昵称 #攻略 妲己」去查英雄）
  const heroName = stripAtText(e.msg)
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
    // ⚠️ 不能把 error.message 原样甩给用户（2026-10-06 修）：getHeroGuide 链上抛的可能是
    //    api 层的技术文案（「获取官网装备表失败。错误: HTTP 503…」），而且鉴权类错误里可能
    //    带账号/登录态线索。全项目 15 处异常回复都走 formatUserFacingError，这里漏了。
    await e.reply(ApiService.formatUserFacingError(error, {
      isMaster: Boolean(e.isMaster),
      scene: '英雄攻略查询异常'
    }), shouldQuote())
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

  // 营地那两块是增强项：有登录态就带上核心装备与铭文，拿不到就照旧只用官网数据。
  // 本机没绑的话顺带问一句共享库
  const { campId: boundCampId } = await resolveCurrentId(e.user_id)
  const camp = await getCampBuild(hero.ename, boundCampId || '', String(e.user_id))

  const img = await puppeteer.screenshot('HeroGuide', {
    imgType: getImgType(),
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

  // ⚠️ screenshot 失败返回 false 而不抛错，不判空会把 false 当文本发进群（2026-10-06 修）
  if (!img) return e.reply('英雄攻略出图失败，稍后再试', shouldQuote())
  await e.reply([img, Button.heroGuide(hero.name)], shouldQuote())
}

export { runHeroGuide }
