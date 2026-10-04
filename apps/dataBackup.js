/**
 * 数据备份指令（限主人）。
 *
 * 包里带 data/AuthPool.json 与 config/config/auth.yaml，**含营地登录凭证**，
 * 拿到就能以主人的账号身份请求营地接口。所以：
 * - 只在私聊里发文件，群里触发直接拒绝（哪怕发的人是主人，群里还有别人）
 * - 回复里也不打印任何凭证内容，只报文件名和条目路径
 *
 * 发文件三级回退：OneBot 的 file 消息段 → 适配器自带 sendFile → base64。
 * file:// 在「Bot 和 Yunzai 不在同一容器」的部署里读不到宿主路径，base64 是那种情况的兜底；
 * 三条都失败也不算白干，包已经落盘，最后一句会把服务器路径报给主人自己去取。
 */
import fs from 'node:fs'
import { createBackup, listBackups, formatBytes, BACKUP_DIR, BACKUP_KEEP } from '../utils/backup.js'
import { shouldQuote } from '#utils'

const fmtTime = ms => {
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 私聊上下文：群里发备份等于把凭证甩在公屏上 */
function isPrivate (e) {
  return !e.isGroup && !e.group_id && !e.group
}

async function sendBackupFile (e, file, name) {
  const errors = []
  const seg = { type: 'file', data: { file: `file://${file}`, name } }

  const attempts = [
    ['file 消息段', async () => e.bot.sendApi('send_msg', {
      message_type: 'private', user_id: e.user_id, message: [seg]
    })],
    ['适配器 sendFile', async () => {
      const target = e.friend || e.bot?.pickFriend?.(e.user_id)
      if (!target?.sendFile) throw new Error('适配器没有 sendFile')
      return target.sendFile(file, name)
    }],
    ['base64', async () => {
      const data = await fs.promises.readFile(file)
      return e.bot.sendApi('send_msg', {
        message_type: 'private',
        user_id: e.user_id,
        message: [{ type: 'file', data: { file: `base64://${data.toString('base64')}`, name } }]
      })
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

export class DataBackup extends plugin {
  constructor () {
    super({
      name: '王者数据备份',
      dsc: '打包插件数据与配置私发给主人',
      event: 'message',
      // 和插件其他新指令一致用 0：战绩查询那条正则是宽匹配，抢在它前面更稳
      priority: 0,
      rule: [
        { reg: '^#王者(数据)?备份$', fnc: 'backup', permission: 'master' },
        { reg: '^#王者备份列表$', fnc: 'list', permission: 'master' }
      ]
    })
  }

  async backup (e) {
    if (!isPrivate(e)) {
      return e.reply('备份包里有营地登录凭证，不在群里发。请私聊我发「#王者数据备份」', shouldQuote())
    }

    await e.reply('📦 正在打包插件数据…', shouldQuote())

    let result
    try {
      result = await createBackup()
    } catch (err) {
      logger.error(`[王者插件] 备份打包失败：${err?.stack || err}`)
      return e.reply(`❌ 打包失败：${err?.message || err}`)
    }

    const sent = await sendBackupFile(e, result.file, result.name)
    if (!sent.ok) logger.error(`[王者插件] 备份发送失败：${sent.errors.join(' / ')}`)

    const lines = [
      '📦 王者插件数据备份',
      `文件：${result.name}`,
      `体积：${formatBytes(result.size)}（原始 ${formatBytes(result.rawSize)} / ${result.names.length} 个文件）`,
      result.skipped.length ? `⚠️ 跳过 ${result.skipped.length} 个：${result.skipped.map(s => s.name).join('、')}` : '',
      sent.ok
        ? `已通过「${sent.via}」发送，注意这份包含登录凭证，别转发`
        : `⚠️ 文件发送失败，包已落在服务器：${result.file}`,
      `保留最近 ${BACKUP_KEEP} 份${result.pruned.length ? `，本次清掉 ${result.pruned.length} 份旧的` : ''}`,
      '恢复方式：解压后把 data/ 和 config/config/ 覆盖回插件目录，再重启'
    ].filter(Boolean)

    return e.reply(lines.join('\n'))
  }

  async list (e) {
    const items = listBackups()
    if (!items.length) return e.reply('还没有备份，发「#王者数据备份」打一份', shouldQuote())

    const lines = [
      `📦 已有 ${items.length} 份备份（最多留 ${BACKUP_KEEP} 份）`,
      ...items.map((item, i) => `${i + 1}. ${fmtTime(item.mtime)} · ${formatBytes(item.size)}`),
      `目录：${BACKUP_DIR}`
    ]
    return e.reply(lines.join('\n'), shouldQuote())
  }
}
