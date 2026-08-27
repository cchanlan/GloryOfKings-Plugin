/**
 * #段位趋势 —— 把段位的升降画成阶梯图。
 *
 * 和 #巅峰趋势 是一对：巅峰趋势看巅峰分（连续刻度），这条看段位（离散阶梯）。
 * 排位玩家原先什么趋势都看不到——巅峰趋势只取 mapName 含「巅峰」的场次，
 * 不打巅峰赛的人那张图永远是空的。
 *
 * 数据同样来自本地归档库（BattleArchive.json，推送轮询顺手落的，保留 35 天），
 * 库里够点时一次营地请求都不发；不够才补拉几页。
 *
 * 段位快照每一场都有，娱乐局也有（实测 413/413），所以这里**不按模式过滤**：
 * 娱乐局能把「这几天在摸鱼、段位没动」如实画成水平段。但胜率、升降段只算排位局，
 * 因为只有排位赛改变段位。口径细节全写在 utils/rankTrend.js 的文件头。
 *
 * 用法：
 *   #段位趋势            近 14 天
 *   #段位趋势 7          近 7 天
 *   #段位趋势 1580886057 指定营地ID
 *   #段位趋势 2          第 2 个绑定账号（1-2 位数字优先当天数，3-4 位当序号）
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import path from 'path'
import {
  getCurrentId, readYamlFile, Button, shouldQuote, getUserAvatar,
  AT_HEAD, stripAtText, resolveTargetUserId, resolveMemberName
} from '#utils'
import { loadArchive, collectBattles, ARCHIVE_KEEP_DAYS } from '../utils/battleArchive.js'
import {
  pickRankBattles, buildRankTrendView, RANK_TREND_DEFAULT_DAYS, RANK_TREND_MIN_POINTS
} from '../utils/rankTrend.js'
import { getHeroNameMap, loadPushList } from '../utils/pushStore.js'
import { heroIconUrl } from '../utils/reportStore.js'
import { PluginData } from '#components'

const CMD = '(段位趋势|段位曲线|排位趋势|段位走势)'

export class RankTrend extends plugin {
  constructor () {
    super({
      name: '王者段位趋势',
      dsc: '段位升降阶梯图',
      event: 'message',
      priority: 0,
      rule: [
        { reg: `${AT_HEAD}#${CMD}\\s*(.*)$`, fnc: 'trend' }
      ]
    })
  }

  async trend (e) {
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint, shouldQuote())

    const input = stripAtText(e.msg).replace(new RegExp(`^#${CMD}\\s*`), '').trim()
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

    const days = Math.min(Math.max(args.days || RANK_TREND_DEFAULT_DAYS, 1), ARCHIVE_KEEP_DAYS)
    const fromSec = Math.floor(Date.now() / 1000) - days * 86400

    let picked = pickRankBattles(loadArchive(campId), fromSec)

    // 库里不够画：现拉几页补上。归档是推送轮询的副产品，没开推送的号库里可能是空的
    if (picked.length < RANK_TREND_MIN_POINTS) {
      try {
        await collectBattles(String(campId), String(userId), fromSec, { maxPages: 6 })
        picked = pickRankBattles(loadArchive(campId), fromSec)
      } catch (error) {
        logger.debug(`[王者段位趋势] ${campId} 补拉战绩失败: ${error.message}`)
      }
    }

    if (picked.length < 2) {
      return e.reply([
        `近 ${days} 天只找到 ${picked.length} 场带段位记录的对局，画不出趋势。\n` +
        `· 试试更长的区间，比如 #段位趋势 ${Math.min(days * 2, ARCHIVE_KEEP_DAYS)}\n` +
        '· 开了 #开启战绩推送 之后每天的对局会自动存档，往后趋势会越来越全',
        Button.push()
      ], shouldQuote())
    }

    const heroMap = await getHeroNameMap()
    const view = buildRankTrendView(picked, { heroMap, iconOf: heroIconUrl, days })
    if (!view) return e.reply('带段位记录的场次太少，攒几天再看吧', shouldQuote())

    const name = await displayName(e, userId)
    const img = await this.shot({
      ...view,
      title: '段位趋势',
      subText: `近 ${days} 天`,
      username: name,
      avatar: await getUserAvatar(e, userId, 100),
      trendJson: JSON.stringify(view.trend),
      levelJson: JSON.stringify(view.levels),
      // 归档只留 35 天，且只覆盖轮询跑过的那段，别让人以为是全赛季
      footText: `数据取自本地战绩存档（最多 ${ARCHIVE_KEEP_DAYS} 天）· 段位快照每场都有，升降段只算排位赛`
    })

    if (!img) return e.reply('趋势图渲染失败了，稍后再试', shouldQuote())
    return e.reply([img, Button.rankTrend(campId)], shouldQuote())
  }

  async shot (view) {
    try {
      return await puppeteer.screenshot('RankTrend', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/RankTrend.html',
        // 模板里 CSS / 字体都靠 {{_res_path}} 拼相对路径，漏了这项样式表 404，
        // 出来的是一张没有任何样式的纯文字图
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        ...view
      })
    } catch (error) {
      logger.error(`[王者段位趋势] 渲染失败: ${error.message}`)
      return null
    }
  }
}

/** `#段位趋势 7 1580886057`：5 位以上是营地ID，1-2 位当天数，3-4 位当绑定序号 */
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
