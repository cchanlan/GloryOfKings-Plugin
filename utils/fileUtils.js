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
          return fs.readFileSync(cacheFile)
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
