import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { getImgType, shouldQuote, stripAtText, fetchSharedRoster, uploadLocalBindings } from '#utils'
import ApiService from '../utils/api.js'
import { dedupeTargets } from '../utils/rankStore.js'
import { isHeroPowerReady, queryHeroPowerRank } from '../utils/heroPowerShare.js'

/**
 * `#英雄名总排名` —— 跨机器人查某个英雄的战力排名。
 *
 * 数据来源两条腿走路：
 *   1. **现查**：把本机所有绑定的营地 ID 挨个拉一次**全量英雄列表**，命中的直接取战力。
 *      不依赖任何人先发 `#常用英雄`，绑定过就能上榜。
 *   2. **共享库**：别的机器人上报过的战力（`utils/heroPowerShare.js`），补进来看不到的号。
 *
 * ⚠️ 现查**不能**用 `seasonpage` 的 `rankInfo.heros` / `masterInfo.heros`：
 *    营地那边只给各模式场次前 5 的英雄（`num`/`topNum`/`count` 参数全部无效），
 *    「元流之子(法师)」这种冷门分身哪怕有战力也进不去前 5，于是永远查不到。
 *    `getGameHeroList`（营地「我的英雄」页，`/play/h5getherolist`）实测一次给全部英雄
 *    （一个号 133 条），`heroFightPower` 与赛季页同名字段逐条一致，且一次请求就够。
 */

/** 英雄头像（营地战斗页特写，裁成横图） */
const HERO_IMG_BASE = 'https://game-1255653016.file.myqcloud.com/battle_skin_1250-326'

/** 最多展示多少人 */
const MAX_ROWS = 20

/** 现查结果缓存：24 个绑定扫一遍实测 28 秒左右，5 分钟内重复查直接复用 */
const CACHE_TTL_MS = 5 * 60 * 1000
const scanCache = new Map()

/** 元流之子五个分身的缩写展开 */
const YUAN_FORMS = { 法: '法师', 射: '射手', 辅: '辅助', 坦: '坦克', 刺: '刺客' }

function expandYuanName (name) {
  const abbr = name.match(/^元(.)$/)
  const form = abbr && YUAN_FORMS[abbr[1]]
  return form ? `元流之子(${form})` : name
}

/**
 * 英雄名归一化：营地接口半角/全角括号两种都给过（见 utils/heroName.js 文件头），
 * 用户手输也两种都常见。比较和查询共享库前统一成半角、去掉空格。
 */
function normHeroName (name) {
  return String(name ?? '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/\s+/g, '')
}

/**
 * 查一个号：拿 roleId / 昵称 / 头像，再翻他的全量英雄列表。
 *
 * 用 `getGameHeroList` 而不是赛季页：后者只给各模式场次前 5，元流之子(法师)
 * 这类冷门分身有战力也拿不到（实测测试号 388 战力 / 8 场，不在前 5）。
 * 全量接口一次返回全部英雄（133 条），战力口径与赛季页一致。
 */
async function scanOne (campId, botUserId, heroName) {
  try {
    const profile = await ApiService.getProfile(campId, botUserId)
    const roleId = profile?.data?.targetRoleId
    if (!roleId) return null

    const heroList = await ApiService.getGameHeroList(campId, botUserId)
    const want = normHeroName(heroName)
    const hit = (heroList?.data?.heroList || []).find(
      hero => normHeroName(hero.name) === want
    )
    const power = Number(hit?.heroFightPower) || 0
    if (!power) return null

    const roleData = (profile.data.roleList || []).find(r => r.roleId === roleId) || {}

    return {
      nick: roleData.roleName || String(campId),
      area: [roleData.areaName, roleData.roleText].filter(Boolean).join(' · '),
      power,
      roleIcon: roleData.roleIcon || '',
      heroId: Number(hit.heroId) || 0
    }
  } catch (error) {
    // 单个号挂了（隐藏主页 / 掉登录）不能影响整张榜，跳过就是
    logger.debug?.(`[英雄战力排名] 查 ${campId} 失败: ${error.message}`)
    return null
  }
}

/**
 * 扫一遍本机所有绑定，挑出养了这只英雄的人。
 *
 * 3 个一批并发：串行查 9 个号要 30 秒以上，群里等不住；全开又容易把
 * 营地那边的登录池打满。分批是这两个约束的折中。
 */
async function scanBindings (heroName) {
  const targets = new Map(dedupeTargets())

  // 英雄榜也要覆盖别的机器人的人：先把本机绑定整表推上去，再拉全库营地ID 名单。
  // 共享库挂了就只扫本机，不能影响出图。
  try {
    await Promise.race([
      uploadLocalBindings().catch(() => {}),
      new Promise(resolve => {
        const timer = setTimeout(resolve, 3000)
        timer.unref?.()
      })
    ])

    const roster = await fetchSharedRoster()
    if (roster.ok) {
      for (const campId of roster.campIds) {
        if (!targets.has(String(campId))) targets.set(String(campId), '')
      }
    }
  } catch {
    // 共享库不可用，按本机绑定查
  }

  const list = [...targets]
  const rows = []
  const CONCURRENCY = 3

  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const batch = list.slice(i, i + CONCURRENCY)
    const results = await Promise.all(
      batch.map(([campId, botUserId]) => scanOne(campId, botUserId, heroName))
    )
    for (const row of results) if (row) rows.push(row)
  }
  return rows
}

/** 现查 + 共享库合并，按战力降序并编好名次（导出只为测试脚本能直接调） */
export async function collectRows (heroName) {
  const cached = scanCache.get(heroName)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.rows

  const rows = await scanBindings(heroName)

  // 共享库那半边：别的机器人上报过的战力，补进来
  if (isHeroPowerReady()) {
    const shared = await queryHeroPowerRank(heroName, MAX_ROWS)
    if (shared.ok) {
      for (const item of shared.list) {
        rows.push({
          nick: item.nick || '未命名',
          area: item.area || '',
          power: Number(item.power) || 0,
          roleIcon: item.roleIcon || '',
          heroId: Number(item.heroId) || 0
        })
      }
    }
  }

  // 同一个人可能既被现查到、又在共享库里，按「昵称+区服」去重（现查的排在前面）
  const seen = new Set()
  const merged = []
  for (const row of rows) {
    const key = `${row.nick}|${row.area}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(row)
  }

  merged.sort((a, b) => b.power - a.power)
  merged.forEach((row, index) => { row.rank = index + 1 })

  const result = merged.slice(0, MAX_ROWS)
  scanCache.set(heroName, { at: Date.now(), rows: result })
  return result
}

export class HeroPowerRank extends plugin {
  constructor() {
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

    // 归一化后再查：共享库里存的是半角括号，用户手输全角时也要能对上
    const heroName = normHeroName(expandYuanName(raw))

    let rows
    try {
      rows = await collectRows(heroName)
    } catch (error) {
      logger.error(`[英雄战力排名] 查询失败: ${error.message}`)
      await e.reply('查询出错了，稍后再试', shouldQuote())
      return
    }

    if (!rows.length) {
      await e.reply([
        `没有查到「${heroName}」的战力数据`,
        '本机绑定的营地号里没有这只英雄的战力记录'
      ].join('\n'), shouldQuote())
      return
    }

    const heroId = rows.find(row => row.heroId)?.heroId || 0

    const img = await puppeteer.screenshot('HeroPowerRank', {
      imgType: getImgType(),
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/HeroPowerRank.html',
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      heroName,
      heroIcon: heroId
        ? `${HERO_IMG_BASE}/${heroId}00.jpg?imageMogr2/thumbnail/x170/crop/270x170/gravity/east`
        : '',
      total: rows.length,
      list: rows
    })

    if (!img) return e.reply('战力排名出图失败，稍后再试', shouldQuote())
    await e.reply(img, shouldQuote())
  }
}
