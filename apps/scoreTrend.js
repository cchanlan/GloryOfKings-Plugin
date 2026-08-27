/**
 * #巅峰趋势 —— 把巅峰分的涨跌画成折线。
 *
 * 数据来自本地归档库（推送轮询顺手落的 BattleArchive.json，保留 35 天），
 * 所以库里够点的时候**一次营地请求都不发**；凑不够 10 场巅峰赛才去补拉战绩（最多 8 页）。
 *
 * 只统计巅峰赛的场次：排位局也带 old/newMasterMatchScore，但两者恒等，
 * 混进来会把折线压成水平噪声（口径细节见 utils/scoreTrend.js）。
 *
 * 天数只是首选窗口：窗口里凑不够 10 场巅峰赛就放宽到全库最近 10 场，并在图上标明。
 * 覆盖天数看轮询跑了多久，不是用户要的天数 —— 图头的徽标如实标「实际覆盖 X 天」。
 *
 * 用法：
 *   #巅峰趋势            近 14 天（不足 10 场则取最近 10 场）
 *   #巅峰趋势 7          近 7 天
 *   #巅峰趋势 1580886057 指定营地ID
 *   #巅峰趋势 2          第 2 个绑定账号（1-2 位数字优先当天数，3-4 位当序号）
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import path from 'path'
import {
  getCurrentId, readYamlFile, Button, shouldQuote, getUserAvatar,
  AT_HEAD, stripAtText, resolveTargetUserId, resolveMemberName
} from '#utils'
import { loadArchive, collectBattles, ARCHIVE_KEEP_DAYS } from '../utils/battleArchive.js'
import {
  pickPeakWindow, buildTrendView, TREND_DEFAULT_DAYS, TREND_TARGET_POINTS
} from '../utils/scoreTrend.js'
import { getHeroNameMap, loadPushList } from '../utils/pushStore.js'
import { heroIconUrl } from '../utils/reportStore.js'
import { PluginData } from '#components'

export class ScoreTrend extends plugin {
  constructor () {
    super({
      name: '王者巅峰趋势',
      dsc: '巅峰分涨跌折线图',
      event: 'message',
      priority: 0,
      rule: [
        { reg: `${AT_HEAD}#(巅峰(分)?趋势|上分趋势|分数趋势|巅峰曲线)\\s*(.*)$`, fnc: 'trend' }
      ]
    })
  }

  async trend (e) {
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint, shouldQuote())

    const input = stripAtText(e.msg).replace(/^#(巅峰(分)?趋势|上分趋势|分数趋势|巅峰曲线)\s*/, '').trim()
    const args = parseArgs(input)

    let campId = args.campId
    if (!campId && args.index) {
      const ids = (readYamlFile(path.join(PluginData, 'UserData.yaml')) || {})[userId]?.ids || []
      campId = ids[args.index - 1] || ''
      if (!campId) return e.reply(`你没有第 ${args.index} 个绑定的营地ID，发送 #营地ID 看看列表`, shouldQuote())
    }
    if (!campId) campId = getCurrentId(userId)

    if (!campId) {
      return e.reply(['你还没有绑定营地ID，先发送 #绑定营地 [营地ID]', Button.bind()], shouldQuote())
    }

    const days = Math.min(Math.max(args.days || TREND_DEFAULT_DAYS, 1), ARCHIVE_KEEP_DAYS)
    const fromSec = Math.floor(Date.now() / 1000) - days * 86400

    let { list: picked, relaxed } = pickPeakWindow(loadArchive(campId), fromSec)

    // 库里凑不够 10 场巅峰：现拉几页补上。归档是推送轮询的副产品，没开推送的号库里可能是空的。
    // 补拉下限用整个归档保留期而不是 days —— 要凑的是场次，天数窗口不够就往更早翻
    if (picked.length < TREND_TARGET_POINTS) {
      try {
        const archiveFrom = Math.floor(Date.now() / 1000) - ARCHIVE_KEEP_DAYS * 86400
        await collectBattles(String(campId), String(userId), archiveFrom, { maxPages: 8 })
        ;({ list: picked, relaxed } = pickPeakWindow(loadArchive(campId), fromSec))
      } catch (error) {
        logger.debug(`[王者巅峰趋势] ${campId} 补拉战绩失败: ${error.message}`)
      }
    }

    if (picked.length < 2) {
      return e.reply([
        `近 ${days} 天只找到 ${picked.length} 场巅峰赛，画不出趋势。\n` +
        '· 排位赛不算：排位不影响巅峰分\n' +
        `· 试试更长的区间，比如 #巅峰趋势 ${Math.min(days * 2, ARCHIVE_KEEP_DAYS)}\n` +
        '· 开了 #开启战绩推送 之后每天的对局会自动存档，往后趋势会越来越全',
        Button.push()
      ], shouldQuote())
    }

    const heroMap = await getHeroNameMap()
    const view = buildTrendView(picked, { heroMap, iconOf: heroIconUrl, days, relaxed })
    if (!view) return e.reply('巅峰赛场次太少，攒几天再看吧', shouldQuote())

    const name = await displayName(e, userId)
    const img = await this.shot({
      ...view,
      title: '巅峰趋势',
      // 放宽过窗口就别再写「近 N 天」了，那是假的
      subText: relaxed ? `最近 ${picked.length} 场巅峰` : `近 ${days} 天`,
      username: name,
      avatar: await getUserAvatar(e, userId, 100),
      trendJson: JSON.stringify(view.trend),
      // 归档只留 35 天，且只覆盖轮询跑过的那段，别让人以为是全赛季
      footText: `数据取自本地战绩存档（最多 ${ARCHIVE_KEEP_DAYS} 天）· 只统计巅峰赛`
    })

    if (!img) return e.reply('趋势图渲染失败了，稍后再试', shouldQuote())
    return e.reply([img, Button.trend(campId)], shouldQuote())
  }

  async shot (view) {
    try {
      return await puppeteer.screenshot('ScoreTrend', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/ScoreTrend.html',
        // 模板里 CSS / 字体都靠 {{_res_path}} 拼相对路径，漏了这项样式表 404，
        // 出来的是一张没有任何样式的纯文字图
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        ...view
      })
    } catch (error) {
      logger.error(`[王者巅峰趋势] 渲染失败: ${error.message}`)
      return null
    }
  }
}

/** `#巅峰趋势 7 1580886057`：5 位以上是营地ID，1-2 位当天数，3-4 位当绑定序号 */
function parseArgs (input = '') {
  const out = { campId: '', index: null, days: null }
  for (const tok of String(input).split(/[\s,，、]+/).filter(Boolean)) {
    if (!/^\d+$/.test(tok)) continue
    if (tok.length >= 5) out.campId = tok
    else if (tok.length <= 2 && out.days === null) out.days = Number(tok)
    else if (out.index === null) out.index = Number(tok)
  }
  return out
}

/** 展示名兜底：推送订阅里缓存的营地昵称 → 群名片 → QQ 号，都不额外发请求 */
async function displayName (e, userId) {
  const cached = String(loadPushList()[String(userId)]?.roleName || '').trim()
  if (cached) return cached
  try {
    return await resolveMemberName(e, userId) || String(userId)
  } catch {
    return String(userId)
  }
}
