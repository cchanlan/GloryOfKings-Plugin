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
// 上次清理时间，避免每次调用都扫描目录
let lastCleanup = 0

/**
 * 远程图片本地化：首次下载缓存到 data/imgCache，之后直接读本地。
 * - 成功下载：缓存30天，过期自动重新拉取
 * - 下载失败（404等）：写空文件标记，7天后重试（CDN可能已补图）
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

    // 定期清理过期缓存
    if (Date.now() - lastCleanup > 86400000) {
      lastCleanup = Date.now()
      cleanImageCache()
    }

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
 * 清理过期缓存：删除超过30天的成功缓存和超过7天的失败标记
 */
export function cleanImageCache () {
  try {
    if (!fs.existsSync(IMG_CACHE_DIR)) return
    const now = Date.now()
    let cleaned = 0
    for (const file of fs.readdirSync(IMG_CACHE_DIR)) {
      const filePath = path.join(IMG_CACHE_DIR, file)
      try {
        const stat = fs.statSync(filePath)
        if (!stat.isFile()) continue
        const age = now - stat.mtimeMs
        const isExpired = stat.size > 0 ? age > CACHE_MAX_AGE : age > FAIL_RETRY_INTERVAL
        if (isExpired) {
          fs.unlinkSync(filePath)
          cleaned++
        }
      } catch {}
    }
    if (cleaned > 0) {
      logger?.debug?.(`[GloryOfKings] 图片缓存清理完成，删除 ${cleaned} 个过期文件`)
    }
  } catch {}
}

export function readJsonFile (filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

export function writeJsonFile (filePath, data) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(filePath, JSON.stringify(data))
}

export function getFilePath (userId, folder = 'ScanCodeLoginData') {
  return path.join(PluginData, folder, `${userId}.json`)
}
