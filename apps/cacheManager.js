/**
 * 图片缓存治理。
 *
 * 缓存本身在 utils/fileUtils.js（md5 文件名、7 天过期、空文件当失败标记），
 * 这里只管「什么时候清」和「让主人看得见」两件事：
 *
 * - 定时清理：早先只在插件启动后跑一次。pm2 下 Yunzai 可以连着跑几个月不重启，
 *   等于永不清理；实测 data/imgCache 攒到 56MB，里面有超期两天以上的文件。
 * - 容量上限：过期判据只管时间管不住量。#皮肤墙 / #全部皮肤 一次拉几百张图，
 *   几个重度用户轮着查，7 天内的「有效」缓存本身就能堆到几百 MB，
 *   所以还要有一道按体积削的兜底（imgCacheMaxMB）。
 *
 * 指令限主人：这是运维动作，不该让群友随手触发一次全目录同步 IO 扫描。
 */
import { cleanImageCache, scanImageCache, resolveCacheMaxBytes } from '../utils/fileUtils.js'
import { shouldQuote } from '#utils'
import { Config, PluginName } from '#components'

/** 读配置，读不到就用默认值，和插件里其他 readConfig 的兜底思路一致 */
function readConfig () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/**
 * 配置里的容量上限（MB）→ 字节。实现挪到 utils/fileUtils.js，
 * 因为皮肤墙批量下载完也要按同一个上限即时削一次（一次 700+ 张图能冲到上限的两三倍）。
 */
const resolveMaxBytes = resolveCacheMaxBytes

const fmtMB = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const fmtAge = ms => {
  if (!ms) return '—'
  const days = Math.floor(ms / 86400000)
  const hours = Math.floor((ms % 86400000) / 3600000)
  return days ? `${days} 天 ${hours} 小时` : `${hours} 小时`
}

export class CacheManager extends plugin {
  constructor () {
    super({
      name: '王者图片缓存治理',
      dsc: '清理插件下载的远程图片缓存',
      event: 'message',
      // 和插件其他新指令一致用 0：queryGameStats 的战绩正则是宽匹配，抢在它前面更稳
      priority: 0,
      rule: [
        { reg: '^#(王者)?缓存(状态|信息)$', fnc: 'status', permission: 'master' },
        { reg: '^#清理(王者)?缓存$', fnc: 'clean', permission: 'master' }
      ]
    })

    this.task = {
      name: '王者图片缓存清理',
      cron: readConfig().imgCacheCleanCron || '0 12 4 * * *',
      fnc: () => runClean('定时'),
      log: false
    }
  }

  async status (e) {
    const scanned = scanImageCache()
    const maxBytes = resolveMaxBytes()

    const lines = [
      '🗂 王者图片缓存状态',
      `文件数：${scanned.files.length} 个`,
      `占用：${fmtMB(scanned.bytes)}${maxBytes ? ` / 上限 ${fmtMB(maxBytes)}` : '（未设上限）'}`,
      `其中已过期：${scanned.expiredCount} 个（${fmtMB(scanned.expiredBytes)}）`,
      `最旧的文件：${fmtAge(scanned.oldestMs)}前下载`,
      maxBytes && scanned.bytes > maxBytes ? '⚠️ 已超出上限，下次定时清理会按时间从旧到新削减' : '',
      '清理指令：#清理王者缓存（每天自动清一次）'
    ].filter(Boolean)

    return e.reply(lines.join('\n'), shouldQuote())
  }

  async clean (e) {
    const before = scanImageCache()
    const stats = cleanImageCache({ maxBytes: resolveMaxBytes() })

    if (!stats.cleaned) {
      return e.reply(
        `缓存里没有需要清理的文件（${before.files.length} 个 / ${fmtMB(before.bytes)} 都还在有效期内且未超上限）`,
        shouldQuote()
      )
    }

    return e.reply([
      '🧹 王者图片缓存已清理',
      `删除 ${stats.cleaned} 个文件，释放 ${fmtMB(stats.freedBytes)}`,
      stats.trimmed ? `其中 ${stats.trimmed} 个是超出容量上限被削掉的` : '',
      `保留 ${stats.kept} 个（${fmtMB(stats.keptBytes)}）`
    ].filter(Boolean).join('\n'), shouldQuote())
  }
}

/** 定时/启动两处共用。整个过程包在 try 里：清缓存失败绝不能影响插件可用性 */
function runClean (scene) {
  try {
    const stats = cleanImageCache({ maxBytes: resolveMaxBytes() })
    logger.debug(`[${PluginName}] ${scene}缓存清理完成：删除 ${stats.cleaned} 个，保留 ${stats.kept} 个`)
  } catch (error) {
    logger.debug(`[${PluginName}] ${scene}缓存清理跳过：${error.message}`)
  }
}

// 启动清理。放在模块顶层而不是 constructor 里：Yunzai 的 loader 每收到一条消息
// 都会给每个 plugin 类 new 一个实例，写在 constructor 里等于每条消息都排一个定时器。
// 延后 30 秒且不 await —— 这是同步 IO 扫目录，不该挤在 Bot 启动的关键路径上。
setTimeout(() => runClean('启动'), 30 * 1000).unref?.()
