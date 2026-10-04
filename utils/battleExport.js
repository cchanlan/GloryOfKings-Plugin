/**
 * 战绩归档导出（CSV）。
 *
 * 数据来自本地归档库 data/BattleArchive.json（battleArchive.loadArchive），
 * **不发任何营地请求**：归档是战绩推送的轮询顺手攒下来的，导出只是把它换个格式吐出来。
 * 所以导出的覆盖范围 = 归档的覆盖范围（最多 ARCHIVE_KEEP_DAYS 天，且开推送之前的场次没有）。
 *
 * 为什么是 CSV 而不是 JSON：这个功能的用途是「自己拿去 Excel 里拉透视表」。
 * 两个必要的坑：
 *   1. **必须带 UTF-8 BOM**，否则 Excel（简中版）会按 GBK 解，中文英雄名全乱码
 *   2. 字段里可能有逗号（`mapName` 是「排位赛 双排」这种，desc 是「实力局」），
 *      一律加引号并把内部引号翻倍，别自己拼裸 CSV
 */
import fs from 'node:fs'
import path from 'path'
import { loadArchive, getArchiveRange } from './battleArchive.js'
import { PluginData } from '#components'

export const EXPORT_DIR = path.join(PluginData, 'export')

/** 导出目录里最多留几个文件，超了按修改时间从旧到新删 */
export const EXPORT_KEEP = 10

/** CSV 表头。顺序即列顺序，改这里就够 */
const COLUMNS = [
  '对局时间', '模式', '结果', '英雄', '击杀', '死亡', '助攻', 'KDA',
  '评分', 'MVP', '时长(分)', '段位', '星数', '巅峰分变化', '评价'
]

const pad = n => String(n).padStart(2, '0')

const fmtTime = sec => {
  const d = new Date(Number(sec) * 1000)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 一个 CSV 单元格。Excel 对换行也敏感，顺手压成空格 */
const cell = value => {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ')
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * 巅峰分变化。判据是 old != new（不是「字段有没有值」）——
 * 排位场次也会带这两个字段且前后相等，用「有值」判会给排位局印出 (0)。
 * 这个坑在 pushStore 里踩过，别在这里重犯。
 */
function scoreDelta (battle) {
  const from = Number(battle.oldMasterMatchScore) || 0
  const to = Number(battle.newMasterMatchScore) || 0
  if (!from || !to || from === to) return ''
  const diff = to - from
  return `${from}→${to}(${diff > 0 ? '+' : ''}${diff})`
}

/**
 * 生成 CSV 文本。
 * @param {string|number} campId 营地ID
 * @param {object} [options]
 * @param {number} [options.days=0] 只导出最近几天，0 = 归档里的全部
 * @param {object} [options.heroMap={}] heroId -> 英雄名（reportStore.getHeroNameMap）
 * @returns {{csv: string, count: number, fromSec: number, toSec: number}}
 */
export function buildBattleCsv (campId, { days = 0, heroMap = {} } = {}) {
  const all = loadArchive(campId)
  const cutoff = days > 0 ? Math.floor(Date.now() / 1000) - days * 86400 : 0
  const battles = all.filter(b => Number(b.dtEventTime) >= cutoff)

  const rows = battles.map(b => {
    const kills = Number(b.killcnt) || 0
    const deaths = Number(b.deadcnt) || 0
    const assists = Number(b.assistcnt) || 0
    // 0 死亡时 KDA 按「不除零」处理，和营地一样直接给 (K+A)
    const kda = deaths > 0 ? ((kills + assists) / deaths).toFixed(2) : String(kills + assists)

    return [
      fmtTime(b.dtEventTime),
      b.mapName || '',
      Number(b.gameresult) === 1 ? '胜' : '负',
      heroMap[b.heroId] || b.heroId || '',
      kills,
      deaths,
      assists,
      kda,
      b.gradeGame || '',
      Number(b.mvpcnt) > 0 ? 'MVP' : (Number(b.losemvp) > 0 ? 'SVP' : ''),
      Math.round((Number(b.usedTime) || 0) / 60),
      b.roleJobName || '',
      // stars 的 0 是真实值（1 星再输一局就是 0 星），别用 || 顶掉
      b.stars ?? '',
      scoreDelta(b),
      b.desc || ''
    ].map(cell).join(',')
  })

  const csv = '﻿' + [COLUMNS.map(cell).join(','), ...rows].join('\r\n') + '\r\n'
  const times = battles.map(b => Number(b.dtEventTime)).filter(Boolean)

  return {
    csv,
    count: battles.length,
    fromSec: times.length ? Math.min(...times) : 0,
    toSec: times.length ? Math.max(...times) : 0
  }
}

/** 归档覆盖范围，给文案用（转发 battleArchive 的实现，调用方不必再引一个模块） */
export function archiveRange (campId) {
  return getArchiveRange(campId)
}

/**
 * 落盘并清理旧文件，返回文件路径。
 * 放 data/export/ 而不是系统临时目录：容器化部署里 /tmp 常常和 Bot 进程不在同一个挂载点，
 * 发文件失败时还得让主人自己去服务器取，路径必须是稳定可预期的。
 */
export function writeExportFile (name, content) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true })
  const file = path.join(EXPORT_DIR, name)
  fs.writeFileSync(file, content, 'utf8')

  try {
    const files = fs.readdirSync(EXPORT_DIR)
      .map(f => ({ f, t: fs.statSync(path.join(EXPORT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(EXPORT_KEEP)) {
      fs.unlinkSync(path.join(EXPORT_DIR, f))
    }
  } catch (error) {
    logger.warn(`[战绩导出] 清理旧导出文件失败: ${error.message}`)
  }

  return file
}
