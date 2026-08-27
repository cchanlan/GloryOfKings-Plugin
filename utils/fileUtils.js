import fs from 'fs'
import path from 'path'
import crypto from 'node:crypto'
import fetch from 'node-fetch'
import { PluginData, Config } from '#components'
import { writeFileAtomic } from './safeStore.js'

const IMG_CACHE_DIR = path.join(PluginData, 'imgCache')
// 成功缓存过期时间（7天）
const CACHE_MAX_AGE = 7 * 24 * 3600 * 1000
// 404 标记重试间隔（7天）——CDN 可能补图
const FAIL_RETRY_INTERVAL = 7 * 24 * 3600 * 1000

// 腾讯图源对还没铺图的资源不返 404，而是回一张 HTTP 200 的通用占位图
// （120x120 PNG，画面是灰底山峰 + “暂时无法查看”，内容固定不变）。
// 刚上线的新皮肤，营地接口给的 szLargeIcon/bigCover 常常就是它。
// 若当成正常图缓存，渲染出来就是一块灰底山峰，且 <img> 加载成功导致 onerror 不触发、
// 调用方的回退链彻底失效。故按内容 md5 精确识别，命中即视为下载失败，
// 走下面的失败标记逻辑（7天后重试，届时 CDN 大概率已补上真图）。
const PLACEHOLDER_MD5 = new Set([
  'fee9458c29cdccf10af7ec01155dc7f0' // 5093 字节，120x120 PNG「暂时无法查看」
])
// 上面各占位图的体积，用于读缓存时快速预筛：体积不符就不必再算 md5
const PLACEHOLDER_SIZES = new Set([5093])

/** 单张图的下载超时 */
const DOWNLOAD_TIMEOUT_MS = 15000

/** 缓存目录默认容量上限（MB）。超出后按 mtime 从旧到新删，直到降回上限之下 */
export const DEFAULT_CACHE_MAX_MB = 200

/**
 * 配置里的容量上限（MB）→ 字节，填 0 或负数表示不限量。
 *
 * 定时清理（apps/cacheManager.js）和批量下载后的即时削减（apps/skinWall.js）共用这一份：
 * 两处各读一遍配置很容易对「上限」理解不一致，而超限判据只该有一个来源。
 */
export function resolveCacheMaxBytes () {
  let mb = NaN
  try {
    mb = Number(Config.getDefOrConfig('config')?.imgCacheMaxMB)
  } catch {}
  const value = Number.isFinite(mb) ? mb : DEFAULT_CACHE_MAX_MB
  return value > 0 ? value * 1024 * 1024 : 0
}

function isPlaceholder (buffer) {
  if (!PLACEHOLDER_SIZES.has(buffer.length)) return false
  return PLACEHOLDER_MD5.has(crypto.createHash('md5').update(buffer).digest('hex'))
}

/**
 * 远程图片本地化：首次下载缓存到 data/imgCache，之后直接读本地。
 * - 成功下载：缓存 7 天，过期自动重新拉取
 * - 下载失败（404等）：写空文件标记，7天后重试（CDN可能已补图）
 *
 * 过期清理不在这里做，挂在 apps/cacheManager.js（启动后一次 + 每天定时一次 + 指令）。
 * 早先是在「下载成功」这条路径末尾按天触发的，但缓存一旦铺满就再也不会有新下载，
 * 清理跟着永不执行——实测目录里躺着 9 天前的文件而上限是 7 天，58MB 从没被清过。
 * @param {string} url 远程图片地址
 * @returns {Promise<Buffer|string>} 成功返回图片 Buffer，失败返回空字符串
 */
export async function getLocalImage (url) {
  try {
    const ext = path.extname(new URL(url).pathname) || '.png'
    const key = crypto.createHash('md5').update(url).digest('hex')
    const cacheFile = path.join(IMG_CACHE_DIR, `${key}${ext}`)

    if (fs.existsSync(cacheFile)) {
      const stat = fs.statSync(cacheFile)
      const age = Date.now() - stat.mtimeMs

      if (stat.size > 0) {
        // 成功缓存：检查是否过期
        if (age < CACHE_MAX_AGE) {
          const cached = fs.readFileSync(cacheFile)
          if (!isPlaceholder(cached)) return cached
          // 加占位图识别之前缓存下来的占位图：转成失败标记，7天后重试
          fs.writeFileSync(cacheFile, '')
          return ''
        }
        // 过期，删除后重新下载
        fs.unlinkSync(cacheFile)
      } else {
        // 失败标记：7天内不重试，超过则删标记重新尝试
        if (age < FAIL_RETRY_INTERVAL) {
          return ''
        }
        fs.unlinkSync(cacheFile)
      }
    }

    // 路径里的中文等非 ASCII 字符需要 encode，否则部分 CDN 直接 400
    const safeUrl = encodeURI(decodeURI(url))
    // 超时必须用 signal：node-fetch 从 v3 起（本插件锁 ^3.3.0）已经移除了 `timeout`
    // 这个选项，写了也是被忽略的死参数 —— 于是对端连上却不给完整响应时这里会永久挂住，
    // 而这条路径在战绩详情图（英雄头像 / 评价图标）的出图链上，推送任务会跟着卡死。
    const res = await fetch(safeUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }

    const buffer = Buffer.from(await res.arrayBuffer())
    if (!buffer.length) {
      throw new Error('响应内容为空')
    }
    if (isPlaceholder(buffer)) {
      throw new Error('图源返回占位图（资源尚未铺图）')
    }

    fs.mkdirSync(IMG_CACHE_DIR, { recursive: true })
    fs.writeFileSync(cacheFile, buffer)

    return buffer
  } catch (err) {
    // 缓存失败标记（空文件），7天后才重试
    try {
      const ext = path.extname(new URL(url).pathname) || '.png'
      const key = crypto.createHash('md5').update(url).digest('hex')
      const cacheFile = path.join(IMG_CACHE_DIR, `${key}${ext}`)
      fs.mkdirSync(IMG_CACHE_DIR, { recursive: true })
      fs.writeFileSync(cacheFile, '')
    } catch {}
    logger?.debug?.(`[GloryOfKings] 图片本地化失败，已缓存标记: ${url} (${err.message})`)
    return ''
  }
}

/**
 * 扫一遍缓存目录，返回每个文件的体积与年龄。清理和「#王者缓存状态」共用。
 * @returns {{files:Array<{path:string,size:number,mtimeMs:number,expired:boolean}>, bytes:number, expiredCount:number, expiredBytes:number, oldestMs:number}}
 */
export function scanImageCache () {
  const out = { files: [], bytes: 0, expiredCount: 0, expiredBytes: 0, oldestMs: 0 }
  if (!fs.existsSync(IMG_CACHE_DIR)) return out

  const now = Date.now()
  for (const name of fs.readdirSync(IMG_CACHE_DIR)) {
    const filePath = path.join(IMG_CACHE_DIR, name)
    try {
      const stat = fs.statSync(filePath)
      if (!stat.isFile()) continue
      const age = now - stat.mtimeMs
      // 空文件是下载失败标记，过期判据用 FAIL_RETRY_INTERVAL
      const expired = stat.size > 0 ? age > CACHE_MAX_AGE : age > FAIL_RETRY_INTERVAL
      out.files.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, expired })
      out.bytes += stat.size
      if (expired) {
        out.expiredCount += 1
        out.expiredBytes += stat.size
      }
      if (age > out.oldestMs) out.oldestMs = age
    } catch {}
  }

  return out
}

/**
 * 清理缓存。两道：先删过期的（成功缓存 7 天、失败标记 7 天），
 * 再看总量有没有超上限——超了就按 mtime 从旧到新继续删，直到降回上限之下。
 *
 * 为什么需要第二道：过期判据只管「时间」，管不住「量」。皮肤墙 / 全部皮肤这类指令
 * 一次就会拉几百张图，几个重度用户轮着查，7 天内的有效缓存本身就能堆到几百 MB。
 *
 * 调用时机是插件启动后一次 + 每天定时一次（见 apps/cacheManager.js）。
 * 早先只挂在「下载成功」那条路径上按天触发，但缓存一旦铺满就再也不会有新下载，
 * 清理跟着永不执行——实测目录里躺着 9 天前的文件而上限是 7 天，58MB 从没被清过。
 *
 * @param {object} [opts]
 * @param {number} [opts.maxBytes=0] 容量上限，0 表示不限
 * @param {boolean} [opts.quiet=false] 不打日志（状态查询里顺带清理时用）
 * @returns {{cleaned:number, freedBytes:number, kept:number, keptBytes:number, trimmed:number}}
 */
export function cleanImageCache ({ maxBytes = 0, quiet = false } = {}) {
  const stats = { cleaned: 0, freedBytes: 0, kept: 0, keptBytes: 0, trimmed: 0 }

  try {
    const scanned = scanImageCache()
    const survivors = []

    for (const file of scanned.files) {
      if (!file.expired) {
        survivors.push(file)
        continue
      }
      try {
        fs.unlinkSync(file.path)
        stats.cleaned += 1
        stats.freedBytes += file.size
      } catch {
        survivors.push(file)
      }
    }

    let liveBytes = survivors.reduce((sum, f) => sum + f.size, 0)

    if (maxBytes > 0 && liveBytes > maxBytes) {
      // 最久没被用到的先删。注：读缓存走 readFileSync 不会更新 mtime，
      // 所以这里的「旧」是「下载得早」而不是严格意义的 LRU，对图片缓存足够了
      survivors.sort((a, b) => a.mtimeMs - b.mtimeMs)
      while (liveBytes > maxBytes && survivors.length) {
        const victim = survivors.shift()
        try {
          fs.unlinkSync(victim.path)
          stats.cleaned += 1
          stats.trimmed += 1
          stats.freedBytes += victim.size
          liveBytes -= victim.size
        } catch {
          break
        }
      }
    }

    stats.kept = survivors.length
    stats.keptBytes = liveBytes

    if (stats.cleaned > 0 && !quiet) {
      const mb = (stats.freedBytes / 1024 / 1024).toFixed(1)
      const trimNote = stats.trimmed ? `（其中 ${stats.trimmed} 个是超出容量上限被削掉的）` : ''
      logger?.info?.(`[GloryOfKings] 图片缓存清理：删除 ${stats.cleaned} 个文件${trimNote}，释放 ${mb} MB，保留 ${stats.kept} 个`)
    }
  } catch {}

  return stats
}

export function readJsonFile (filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

/**
 * 原子写 JSON。实现（.tmp + rename）与「为什么必须原子写」都在 utils/safeStore.js，
 * 全仓库的落盘走同一份，别再各自写一遍 tmp 逻辑。
 */
export function writeJsonFile (filePath, data) {
  writeFileAtomic(filePath, JSON.stringify(data))
}

export function getFilePath (userId, folder = 'ScanCodeLoginData') {
  return path.join(PluginData, folder, `${userId}.json`)
}
