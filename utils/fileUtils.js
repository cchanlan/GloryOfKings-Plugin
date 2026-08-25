import fs from 'fs'
import path from 'path'
import crypto from 'node:crypto'
import fetch from 'node-fetch'
import { PluginData } from '#components'

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

function isPlaceholder (buffer) {
  if (!PLACEHOLDER_SIZES.has(buffer.length)) return false
  return PLACEHOLDER_MD5.has(crypto.createHash('md5').update(buffer).digest('hex'))
}

/**
 * 远程图片本地化：首次下载缓存到 data/imgCache，之后直接读本地。
 * - 成功下载：缓存 7 天，过期自动重新拉取
 * - 下载失败（404等）：写空文件标记，7天后重试（CDN可能已补图）
 *
 * 过期清理不在这里做，挂在 index.js 的插件启动流程里（见 cleanImageCache）。
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
    const res = await fetch(safeUrl, { timeout: 15000 })
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
 * 清理过期缓存：删除超过 7 天的成功缓存和超过 7 天的失败标记。
 * 由 index.js 在插件载入后调用一次；单张图平均 490KB，攒久了是几十 MB 量级，
 * 所以清掉多少字节要报出来，不然用户看不到这件事发生过。
 * @returns {{cleaned:number, freedBytes:number, kept:number}}
 */
export function cleanImageCache () {
  const stats = { cleaned: 0, freedBytes: 0, kept: 0 }

  try {
    if (!fs.existsSync(IMG_CACHE_DIR)) return stats
    const now = Date.now()

    for (const file of fs.readdirSync(IMG_CACHE_DIR)) {
      const filePath = path.join(IMG_CACHE_DIR, file)
      try {
        const stat = fs.statSync(filePath)
        if (!stat.isFile()) continue
        const age = now - stat.mtimeMs
        const isExpired = stat.size > 0 ? age > CACHE_MAX_AGE : age > FAIL_RETRY_INTERVAL
        if (isExpired) {
          fs.unlinkSync(filePath)
          stats.cleaned += 1
          stats.freedBytes += stat.size
        } else {
          stats.kept += 1
        }
      } catch {}
    }

    if (stats.cleaned > 0) {
      const mb = (stats.freedBytes / 1024 / 1024).toFixed(1)
      logger?.info?.(`[GloryOfKings] 图片缓存清理：删除 ${stats.cleaned} 个过期文件，释放 ${mb} MB，保留 ${stats.kept} 个`)
    }
  } catch {}

  return stats
}

export function readJsonFile (filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

/**
 * 原子写 JSON：先写同目录的 .tmp 再 rename 覆盖。
 *
 * 裸 writeFileSync 是「先截断再写」，进程正好在这中间被 kill（pm2 restart、OOM）
 * 就留下一个半截文件，下次 JSON.parse 直接抛错——归档库和排行榜快照都是整库一个文件，
 * 坏一次就是整份数据没了。rename 在同一文件系统上是原子的，读方要么看到旧的完整文件、
 * 要么看到新的完整文件，不存在中间态。
 *
 * .tmp 带 pid 后缀：同一份数据被两个进程同时写时不会互相踩掉临时文件。
 */
export function writeJsonFile (filePath, data) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const tmpFile = `${filePath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data))
    fs.renameSync(tmpFile, filePath)
  } catch (error) {
    // 失败要把临时文件清掉，否则 data/ 下会攒一堆 .tmp
    try { fs.unlinkSync(tmpFile) } catch {}
    throw error
  }
}

export function getFilePath (userId, folder = 'ScanCodeLoginData') {
  return path.join(PluginData, folder, `${userId}.json`)
}
