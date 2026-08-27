/**
 * #王者对比 —— 两个号横着比一遍。
 *
 * 每人只花 1 次营地请求：段位、巅峰分、战斗力、场次、胜率、MVP、英雄数、皮肤数、最高战力英雄
 * 全在营地主页那一个接口的 head.mods 里（字段对应见 utils/profileSummary.js）。
 *
 * 比谁：
 *   #王者对比 @某人      对方要绑过营地ID（拿他自己绑的那个号）
 *   #王者对比 1580886057 直接给营地ID，和谁都能比
 *   #王者对比 2 3        两个都是绑定序号时，比自己名下的两个号
 * 单独发 #王者对比 会提示要给个对手 —— 自己跟自己比没有意义。
 *
 * 出图走 KingCompare.html：左右对阵 + 九项对撞条，赢的一边标金色。
 * 胜负判定见 ITEMS，段位不按星数硬比（星耀 1 星和王者 1 星不是一个量级），走 compareRank
 * 的两级判据。渲染失败时回落到逐行文字（renderCompare），判定口径两边完全一致。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import path from 'path'
import {
  ApiService, getCurrentId, readYamlFile, Button, shouldQuote,
  AT_HEAD, stripAtText, pickAtText, resolveMemberName
} from '#utils'
import { summarizeProfile, rankText, compareRank } from '../utils/profileSummary.js'
import { getHeroNameMap } from '../utils/pushStore.js'
import { PluginData } from '#components'

/**
 * 对比项。cmp 返回 >0 表示左边赢；text 负责把值渲染成人话。
 * has 为假的项整条跳过（比如没打巅峰赛的号），不参与比分 —— 缺数据不算输。
 * num 给出图时画对撞条用；段位没有 num：星耀 68 星和王者 1 星的星数不可线性比。
 */
const ITEMS = [
  {
    icon: '🏅',
    label: '段位',
    has: s => Boolean(s.rank?.name),
    text: s => rankText(s.rank),
    cmp: (a, b) => compareRank(a.rank, b.rank)
  },
  {
    icon: '⛰️',
    label: '巅峰分',
    has: s => s.peak > 0,
    text: s => String(s.peak),
    num: s => s.peak,
    cmp: (a, b) => a.peak - b.peak
  },
  {
    icon: '💪',
    label: '战斗力',
    has: s => s.power > 0,
    text: s => String(s.power),
    num: s => s.power,
    cmp: (a, b) => a.power - b.power
  },
  {
    icon: '🎮',
    label: '总场次',
    has: s => s.plays > 0,
    text: s => `${s.plays} 场`,
    num: s => s.plays,
    cmp: (a, b) => a.plays - b.plays
  },
  {
    icon: '📈',
    label: '胜率',
    has: s => s.winRate > 0,
    text: s => `${s.winRate}%`,
    num: s => s.winRate,
    cmp: (a, b) => a.winRate - b.winRate
  },
  {
    icon: '🌟',
    label: 'MVP',
    has: s => s.mvp > 0,
    text: s => `${s.mvp} 次`,
    num: s => s.mvp,
    cmp: (a, b) => a.mvp - b.mvp
  },
  {
    icon: '🦸',
    label: '英雄',
    has: s => s.heroOwn > 0,
    text: s => `${s.heroOwn}${s.heroTotal ? `/${s.heroTotal}` : ''}`,
    num: s => s.heroOwn,
    cmp: (a, b) => a.heroOwn - b.heroOwn
  },
  {
    icon: '🎨',
    label: '皮肤',
    has: s => s.skinOwn > 0,
    text: s => `${s.skinOwn}${s.skinTotal ? `/${s.skinTotal}` : ''}`,
    num: s => s.skinOwn,
    cmp: (a, b) => a.skinOwn - b.skinOwn
  },
  {
    icon: '🔥',
    label: '最高战力',
    has: s => Number(s.topHero?.power) > 0,
    text: s => `${s.topHero.heroName || '英雄'} ${s.topHero.power}`,
    num: s => Number(s.topHero?.power) || 0,
    cmp: (a, b) => a.topHero.power - b.topHero.power
  }
]

export class KingCompare extends plugin {
  constructor () {
    super({
      name: '王者对比',
      dsc: '两个账号横向对比',
      event: 'message',
      priority: 0,
      rule: [
        { reg: `${AT_HEAD}#(王者)?对比\\s*(.*)$`, fnc: 'compare' }
      ]
    })
  }

  async compare (e) {
    const self = String(e.user_id)
    const input = stripAtText(e.msg).replace(/^#(王者)?对比\s*/, '').trim()
    const nums = input.split(/[\s,，、]+/).filter(tok => /^\d+$/.test(tok))
    const campIds = nums.filter(tok => tok.length >= 5)
    const indexes = nums.filter(tok => tok.length < 5).map(Number)

    const mine = readYamlFile(path.join(PluginData, 'UserData.yaml')) || {}
    const myIds = mine[self]?.ids || []
    const byIndex = idx => myIds[idx - 1] || ''

    // 左边默认是自己（当前号），除非用序号/营地ID显式指定了两个对手
    let left = campIds[0] || byIndex(indexes[0]) || getCurrentId(self)
    let right = campIds[1] || byIndex(indexes[1]) || ''
    let leftOwner = self
    let rightOwner = self

    // 只给了一个参数时，那个参数是「对手」，自己当左边
    if ((campIds.length + indexes.length) === 1) {
      right = campIds[0] || byIndex(indexes[0])
      left = getCurrentId(self)
    }

    // @ 了人就拿对方自己绑的号，比参数优先级低（显式给ID时以ID为准）
    if (!right) {
      const atUser = await this.pickOther(e)
      if (atUser.hint) return e.reply(atUser.hint, shouldQuote())
      if (atUser.userId) {
        right = getCurrentId(atUser.userId)
        rightOwner = atUser.userId
        if (!right) {
          const who = await this.nameOf(e, atUser.userId)
          return e.reply(`${who} 还没绑定营地ID，让 TA 先发 #绑定营地 [营地ID]`, shouldQuote())
        }
      }
    }

    if (!left) {
      return e.reply(['你还没有绑定营地ID，先发送 #绑定营地 [营地ID]', Button.bind()], shouldQuote())
    }
    if (!right) {
      return e.reply([
        '要跟谁比？@ 一个人，或者直接给营地ID：\n#王者对比 @某人\n#王者对比 1580886057\n#王者对比 1 2（比自己绑的两个号）',
        Button.compare()
      ], shouldQuote())
    }
    if (String(left) === String(right)) {
      return e.reply('这俩是同一个号，比不出高低', shouldQuote())
    }

    const [a, b] = await Promise.all([
      this.summarize(left, leftOwner),
      this.summarize(right, rightOwner)
    ])

    if (!a || !b) {
      const bad = !a ? left : right
      return e.reply(`取不到营地ID ${bad} 的主页数据，对方可能没开「陌生人可见」`, shouldQuote())
    }

    // 最高战力英雄的名字走官网 herolist（6 小时缓存，不碰营地接口）
    const heroMap = await getHeroNameMap()
    for (const side of [a, b]) {
      if (side.topHero?.heroId) side.topHero.heroName = heroMap[side.topHero.heroId] || ''
    }

    return e.reply([
      await this.shot(a, b) || renderCompare(a, b),
      Button.compare(left, right)
    ], shouldQuote())
  }

  /** 出图。失败返回 null，由调用方回落到逐行文字 */
  async shot (a, b) {
    try {
      return await puppeteer.screenshot('KingCompare', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/KingCompare.html',
        // 模板的 CSS / 字体都靠 {{_res_path}} 拼相对路径，漏了这项样式表 404，出的是纯文字图
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        ...buildCompareView(a, b)
      })
    } catch (error) {
      logger.error(`[王者对比] 渲染失败: ${error.message}`)
      return null
    }
  }

  /** 解析被 @ 的人。这里不用 resolveTargetUserId：那个会在没 @ 时退回自己，而对比需要区分「没给对手」 */
  async pickOther (e) {
    if (e.at && !e.atme) return { userId: String(e.at), hint: '' }

    const name = pickAtText(e.msg)
    if (!name) return { userId: '', hint: '' }
    if (/^\d{5,12}$/.test(name)) return { userId: name, hint: '' }

    try {
      const map = e?.bot?.gml?.get?.(e.group_id) || await e?.group?.getMemberMap?.()
      if (map?.size) {
        const key = name.toLowerCase()
        for (const [userId, info] of map) {
          for (const raw of [info?.card, info?.nickname]) {
            if (String(raw || '').trim().toLowerCase() === key) return { userId: String(userId), hint: '' }
          }
        }
      }
    } catch (error) {
      logger.debug(`[王者对比] 群成员反查失败: ${error.message}`)
    }

    return { userId: '', hint: `没找到「${name}」这个人，请从 @ 列表里点选对方再发一次，或直接带上对方的营地ID` }
  }

  async summarize (campId, ownerQQ) {
    try {
      const res = await ApiService.getProfile(String(campId), String(ownerQQ))
      const summary = summarizeProfile(res?.data)
      if (summary) summary.campId = String(campId)
      return summary
    } catch (error) {
      logger.error(`[王者对比] ${campId} 取主页失败: ${error.message}`)
      return null
    }
  }

  async nameOf (e, userId) {
    try {
      return await resolveMemberName(e, userId) || String(userId)
    } catch {
      return String(userId)
    }
  }
}

/* ---------------------------------------------------------- 出图 */

/**
 * 一侧的显示名。营地允许把昵称设成全空白（实测有人用全角空格/零宽字符），
 * 直接拿来渲染就是一片空白——「🎉 　赢了」这种，看着像 bug。剔掉不可见字符后为空就退回营地ID。
 */
const VISIBLE = /[^\s​-‏⁠﻿]/
function sideName (s) {
  return VISIBLE.test(String(s.roleName || '')) ? s.roleName : s.campId
}

/** 一侧的副标题：大区 + 等级，都可能缺 */
function sideSub (s) {
  return [s.areaName, s.gameLevel ? `Lv.${s.gameLevel}` : '', `营地 ${s.campId}`]
    .filter(Boolean)
    .join(' · ')
}

/** 把两份摘要整成模板要的视图。判定口径与 renderCompare 完全一致，只是多了对撞条 */
function buildCompareView (a, b) {
  const items = []
  const skip = []
  let winA = 0
  let winB = 0

  for (const item of ITEMS) {
    // 一边缺数据这项就不比：算「输」会冤枉没打巅峰赛的号
    if (!item.has(a) || !item.has(b)) {
      skip.push(item.label)
      continue
    }
    const diff = item.cmp(a, b)
    if (diff > 0) winA += 1
    else if (diff < 0) winB += 1

    // 对撞条按两边的比值给宽度；段位没有 num（星数跨段不可比），那行就不画条
    let barA = 0
    let barB = 0
    if (item.num) {
      const va = item.num(a)
      const vb = item.num(b)
      const max = Math.max(va, vb)
      if (max > 0) {
        barA = Math.max(4, Math.round((va / max) * 100))
        barB = Math.max(4, Math.round((vb / max) * 100))
      }
    }

    items.push({
      icon: item.icon,
      label: item.label,
      leftText: item.text(a),
      rightText: item.text(b),
      side: diff > 0 ? 'a' : (diff < 0 ? 'b' : ''),
      barA,
      barB
    })
  }

  const nameA = sideName(a)
  const nameB = sideName(b)
  const compared = winA + winB
  const gap = Math.abs(winA - winB)

  let verdict = '🤝 打平，谁也别嘴谁'
  let winSide = ''
  if (!compared) {
    verdict = '两边都没什么可比的数据\n可能都没开「陌生人可见」'
  } else if (winA !== winB) {
    winSide = winA > winB ? 'a' : 'b'
    verdict = `${winA > winB ? nameA : nameB} 赢了${gap >= 4 ? '，而且是碾压' : ''}`
  }

  return {
    title: '王者对比',
    subText: `${compared} 项分出胜负`,
    leftName: nameA,
    rightName: nameB,
    leftIcon: a.roleIcon || '',
    rightIcon: b.roleIcon || '',
    leftSub: sideSub(a),
    rightSub: sideSub(b),
    items,
    winA,
    winB,
    winSide,
    verdict,
    compared,
    skipped: skip.length,
    skipList: skip.join('、'),
    footText: '数据取自营地主页 · 段位先比段再比星 · 缺数据的项不计分'
  }
}

/* ---------------------------------------------------------- 文案（出图失败时的兜底） */

function renderCompare (a, b) {
  const nameA = sideName(a)
  const nameB = sideName(b)

  const lines = [
    '⚔️ 王者对比',
    `${nameA}${a.areaName ? `（${a.areaName}）` : ''}`,
    `${nameB}${b.areaName ? `（${b.areaName}）` : ''}`,
    ''
  ]

  let winA = 0
  let winB = 0

  for (const item of ITEMS) {
    // 一边缺数据这项就不比：算「输」会冤枉没打巅峰赛的号
    if (!item.has(a) || !item.has(b)) continue
    const diff = item.cmp(a, b)
    if (diff > 0) winA += 1
    else if (diff < 0) winB += 1
    lines.push(`${item.icon} ${item.label}　${item.text(a)}${diff > 0 ? ' 🏆' : ''}　vs　${item.text(b)}${diff < 0 ? ' 🏆' : ''}`)
  }

  const compared = winA + winB
  lines.push('')
  if (!compared) {
    lines.push('两边都没什么可比的数据，可能都没开「陌生人可见」')
    return lines.join('\n')
  }

  lines.push(`比分 ${winA} : ${winB}`)
  if (winA > winB) lines.push(`🎉 ${nameA} 赢了${winA - winB >= 4 ? '，而且是碾压' : ''}`)
  else if (winB > winA) lines.push(`🎉 ${nameB} 赢了${winB - winA >= 4 ? '，而且是碾压' : ''}`)
  else lines.push('🤝 打平，谁也别嘴谁')

  lines.push('（数值项各算一分，缺数据的项不计；段位先比段再比星）')
  return lines.join('\n')
}
