// 英雄梯度榜：数据来自官方营地 getdetailranklistbyid 接口，实时拉取
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { ApiService, Button, shouldQuote } from '#utils'

// 段位筛选：文字 → segment（对应接口 tabFilter 下标）
const SEGMENT_MAP = [
  { seg: 3, names: ['巅峰赛', '巅峰', '1350', '巅峰赛1350+'] },
  { seg: 1, names: ['所有段位', '全段位', '全部段位', '所有'] },
  { seg: 4, names: ['顶端排位', '顶端', '顶端局'] },
  { seg: 5, names: ['赛事', 'kpl', '职业'] }
]
const SEGMENT_LABEL = { 1: '所有段位', 3: '巅峰赛1350+', 4: '顶端排位', 5: '赛事' }

// 分路筛选：文字 → position（对应接口 branchFilter 下标）
const POSITION_MAP = [
  { pos: 1, names: ['对抗路', '对抗', '上单', '单', '边路'] },
  { pos: 2, names: ['中路', '中单', '中'] },
  { pos: 3, names: ['发育路', '发育', '射手', 'adc', '下路'] },
  { pos: 4, names: ['游走', '辅助', '游'] },
  { pos: 5, names: ['打野', '野'] }
]
const POSITION_LABEL = { 0: '全部分路', 1: '对抗路', 2: '中路', 3: '发育路', 4: '游走', 5: '打野' }

// T 梯度配色
const TIER_COLOR = {
  T0: '#ff5b7c',
  T1: '#f5d76e',
  T2: '#6f8ef5',
  T3: '#9aa7bd'
}

// 简化过长英雄名（荣誉标空间有限）：元流之子(射手) → 元流之子，分类挪到副标
function splitHeroName(rawName) {
  const text = rawName || ''
  const match = text.match(/^(.+?)\s*[（(]([^）)]+)[）)]\s*$/)
  if (match) {
    return { name: match[1], sub: match[2] }
  }
  return { name: text, sub: '' }
}

// 从指令里解析出段位与分路（默认 巅峰赛1350+ / 全部分路）
function parseFilter(msg) {
  let segment = 3
  let position = 0

  for (const item of SEGMENT_MAP) {
    if (item.names.some(n => msg.includes(n))) {
      segment = item.seg
      break
    }
  }
  for (const item of POSITION_MAP) {
    if (item.names.some(n => msg.includes(n))) {
      position = item.pos
      break
    }
  }
  return { segment, position }
}

// 把 updateTime(20260724) 格式化成 2026-07-24
function formatUpdateTime(raw) {
  const text = String(raw || '')
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  }
  return text
}

function toPercent(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return '-'
  return `${(num * 100).toFixed(1)}%`
}

export class HeroTierList extends plugin {
  constructor() {
    super({
      name: '查询王者英雄梯度榜',
      dsc: '查询实时英雄梯度榜（T0~T3 胜率/登场率/Ban率）',
      event: 'message',
      priority: 5,
      rule: [
        {
          reg: '^#(王者)?(英雄梯度|梯度|强度)\\s*(.*)$',
          fnc: 'heroTierList'
        }
      ]
    })
  }

  async heroTierList(e) {
    const msg = e.msg.replace(/^#(王者)?(英雄梯度|梯度|强度)\s*/, '').trim()
    const { segment, position } = parseFilter(msg)

    let res
    try {
      res = await ApiService.getdetailranklistbyid({ segment, position })
    } catch (error) {
      logger.error(`[英雄梯度榜] 查询失败: ${error.message}`)
      await e.reply(ApiService.formatUserFacingError(error, {
        isMaster: Boolean(e.isMaster),
        scene: '英雄梯度榜查询异常'
      }))
      return
    }

    const list = res?.data?.list
    if (!Array.isArray(list) || !list.length) {
      await e.reply('未获取到英雄梯度榜数据，请稍后再试')
      return
    }

    // 按 T 梯度分组，梯度内保持接口原有（热度）排序
    const tierOrder = ['T0', 'T1', 'T2', 'T3']
    const groupMap = {}
    for (const item of list) {
      const info = item.heroInfo || {}
      const { name, sub } = splitHeroName(info.heroName)
      const tRank = tierOrder.includes(item.tRank) ? item.tRank : 'T3'
      if (!groupMap[tRank]) groupMap[tRank] = []
      groupMap[tRank].push({
        name,
        sub,
        career: info.heroCareer || '',
        icon: info.heroIcon || '',
        winRate: toPercent(item.winRate),
        showRate: toPercent(item.showRate),
        banRate: toPercent(item.banRate)
      })
    }

    const groups = tierOrder
      .filter(t => groupMap[t]?.length)
      .map(t => ({
        tier: t,
        color: TIER_COLOR[t],
        count: groupMap[t].length,
        heroes: groupMap[t]
      }))

    // 英雄多时（如全部分路 130+）用 4 列并切紧凑样式，避免卡片过长；少时保持 3 列大卡片
    const compact = list.length > 60
    const cols = compact ? 4 : 3

    const img = await puppeteer.screenshot('HeroTierList', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/HeroTierList.html',
      segmentLabel: SEGMENT_LABEL[segment] || '巅峰赛1350+',
      positionLabel: POSITION_LABEL[position] || '全部分路',
      updateTime: formatUpdateTime(res?.data?.updateTime),
      heroCount: list.length,
      cols,
      compact,
      groups
    })

    // 注意：本函数内 segment 被 parseFilter 的返回值遮蔽，按钮统一在 Button 里构造
    await e.reply([img, Button.heroTier()], shouldQuote())
  }
}
