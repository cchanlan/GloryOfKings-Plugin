import fs from 'fs'
import path from 'path'
import crypto from 'node:crypto'
import fetch from 'node-fetch'
import { PluginData } from '#components'

const IMG_CACHE_DIR = path.join(PluginData, 'imgCache')

/**
 * 远程图片本地化：首次下载缓存到 data/imgCache，之后直接读本地。
 * 下载失败（404 等）会写入空文件作为标记，后续不再重试。
 * @param {string} url 远程图片地址
 * @returns {Promise<Buffer|string>} 成功返回图片 Buffer，失败返回空字符串
 */
export async function getLocalImage (url) {
  try {
    const ext = path.extname(new URL(url).pathname) || '.png'
    const key = crypto.createHash('md5').update(url).digest('hex')
    const cacheFile = path.join(IMG_CACHE_DIR, `${key}${ext}`)

    if (fs.existsSync(cacheFile)) {
      // 空文件 = 之前下载失败的标记，不再重试
      const stat = fs.statSync(cacheFile)
      return stat.size > 0 ? fs.readFileSync(cacheFile) : ''
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
    return buffer
  } catch (err) {
    // 缓存失败标记（空文件），避免下次重试
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
