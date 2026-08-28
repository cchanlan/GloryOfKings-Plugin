/**
 * #导出战绩 —— 把本地战绩归档导成 CSV 发出来。
 *
 * 零营地请求：读的是 data/BattleArchive.json（战绩推送轮询顺手攒的库），
 * 所以能导多少完全取决于归档覆盖了多少天，文案里会如实标出范围。
 *
 * 发文件走三级回退（同 dataBackup）：file 消息段 → 适配器 sendFile → base64。
 * 和备份不同的是**战绩里没有任何凭证**，所以群里也能发，不强制私聊。
 */
import fs from 'node:fs'
import path from 'path'
import { buildBattleCsv, archiveRange, writeExportFile } from '../utils/battleExport.js'
import { getHeroNameMap } from '../utils/reportStore.js'
import { ARCHIVE_KEEP_DAYS } from '../utils/battleArchive.js'
import {
  getCurrentId, Button, shouldQuote, parsePerfArgs,
  AT_HEAD, stripAtText, resolveTargetUserId
} from '#utils'
import { PluginData } from '#components'

const fmtDate = sec => {
  const d = new Date(Number(sec) * 1000)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 发文件。群里发群文件、私聊发私聊文件，三级回退：
 *   1. OneBot 的 file 消息段（走 e.reply，适配器自己挑 group/private）
 *   2. 适配器自带 sendFile
 *   3. base64（Bot 和 Yunzai 不在同一容器时 file:// 读不到宿主路径）
 * @returns {Promise<{ok: boolean, via: string, errors: string[]}>}
 */
async function sendExportFile (e, file, name) {
  const errors = []
  const seg = { type: 'file', data: { file: `file://${file}`, name } }

  const attempts = [
    ['file 消息段', async () => e.reply(seg)],
    ['适配器 sendFile', async () => {
      const target = e.isGroup
        ? (e.group || e.bot?.pickGroup?.(e.group_id))
        : (e.friend || e.bot?.pickFriend?.(e.user_id))
      if (!target?.sendFile) throw new Error('适配器没有 sendFile')
      return target.sendFile(file, name)
    }],
    ['base64', async () => {
      const data = await fs.promises.readFile(file)
      return e.reply({ type: 'file', data: { file: `base64://${data.toString('base64')}`, name } })
    }]
  ]

  for (const [via, run] of attempts) {
    try {
      await run()
      return { ok: true, via, errors }
    } catch (err) {
      errors.push(`${via}: ${err?.message || err}`)
    }
  }
  return { ok: false, via: '', errors }
}

export class BattleExport extends plugin {
  constructor () {
    super({
      name: '王者战绩导出',
      dsc: '把本地战绩归档导出成 CSV',
      event: 'message',
      // 同 heroGuide / whoIsPlaying：抢在 queryGameStats 的宽匹配前面
      priority: 0,
      rule: [
        { reg: `${AT_HEAD}#(王者)?(导出战绩|战绩导出)\\s*(.*)$`, fnc: 'exportCsv' }
      ]
    })
  }

  async exportCsv (e) {
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint, shouldQuote())

    const input = stripAtText(e.msg).replace(/^#(王者)?(导出战绩|战绩导出)\s*/, '').trim()
    // 同 battleReport：5 位以上当营地ID，4 位以内当「最近几天」
    const args = parsePerfArgs(input)
    let campId = args.campId
    const days = args.all ? 0 : Math.min(args.count || 0, ARCHIVE_KEEP_DAYS)

    if (!campId) campId = getCurrentId(userId)
    if (!campId) {
      return e.reply(['你还没有绑定营地ID，先发送 #绑定营地 [营地ID]', Button.bind()], shouldQuote())
    }

    const range = archiveRange(campId)
    if (!range?.count) {
      return e.reply([
        [
          '本地还没有这个号的战绩归档，所以导不出东西。',
          '归档是战绩推送的轮询顺手攒的，发送 #开启战绩推送 之后就会开始积累。'
        ].join('\n'),
        // 按钮是消息段，不能 join 进字符串（会变成 [object Object]）
        Button.push(false)
      ], shouldQuote())
    }

    let result
    try {
      const heroMap = await getHeroNameMap()
      result = buildBattleCsv(campId, { days, heroMap })
    } catch (error) {
      logger.error(`[战绩导出] 生成失败: ${error.message}`)
      return e.reply(`生成导出文件失败：${error.message}`, shouldQuote())
    }

    if (!result.count) {
      return e.reply(`最近 ${days} 天没有对局记录，归档覆盖 ${fmtDate(range.earliest)} ~ ${fmtDate(range.latest)}`, shouldQuote())
    }

    // 时间戳带到秒：分钟级精度下同一分钟内导两次会互相覆盖（备份那边踩过同样的坑）。
    // 范围也进文件名，「全部」和「最近 7 天」两份同时存在时才分得清
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
    const name = `王者战绩_${campId}_${days > 0 ? days + '天' : '全部'}_${stamp}.csv`
    let file
    try {
      file = writeExportFile(name, result.csv)
    } catch (error) {
      logger.error(`[战绩导出] 落盘失败: ${error.message}`)
      return e.reply(`导出文件写入失败：${error.message}`, shouldQuote())
    }

    const sizeKB = (Buffer.byteLength(result.csv, 'utf8') / 1024).toFixed(1)
    const scope = days > 0 ? `最近 ${days} 天` : '归档全部'
    const summary = [
      `📄 战绩导出完成（${scope}）`,
      `营地ID ${campId} · ${result.count} 场 · ${sizeKB}KB`,
      `覆盖 ${fmtDate(result.fromSec)} ~ ${fmtDate(result.toSec)}`,
      `归档共 ${range.count} 场（${fmtDate(range.earliest)} ~ ${fmtDate(range.latest)}，最多保留 ${ARCHIVE_KEEP_DAYS} 天）`
    ].join('\n')

    await e.reply(summary, shouldQuote())

    const sent = await sendExportFile(e, file, name)
    if (!sent.ok) {
      logger.error(`[战绩导出] 发送失败: ${sent.errors.join(' | ')}`)
      await e.reply([
        '文件发送失败（适配器可能不支持发文件），已存在服务器上：',
        path.relative(path.join(PluginData, '..'), file),
        `完整路径：${file}`
      ].join('\n'), shouldQuote())
    }
  }
}
