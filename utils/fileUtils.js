import fs from 'fs'
import path from 'path'
import crypto from 'node:crypto'
import fetch from 'node-fetch'
import { PluginData } from '#components'

const IMG_CACHE_DIR = path.join(PluginData, 'imgCache')

/**
 * 远程图片本地化：首次下载缓存到 data/imgCache，之后直接读本地。
 * QQ 官方机器人对 markdown 外链图有域名白名单限制，且中文路径不编码会被判非法，
 * 直接回传 Buffer 可让适配器走 richMedia 上传通道，规避这两个问题。
 * @param {string} url 远程图片地址
 * @returns {Promise<Buffer|string>} 成功返回图片 Buffer，失败回退原 url
 */
export async function getLocalImage (url) {
  try {
    const ext = path.extname(new URL(url).pathname) || '.png'
    const key = crypto.createHash('md5').update(url).digest('hex')
    const cacheFile = path.join(IMG_CACHE_DIR, `${key}${ext}`)

    if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 0) {
      return fs.readFileSync(cacheFile)
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
    logger?.warn?.(`[GloryOfKings] 图片本地化失败，回退外链: ${url} (${err.message})`)
    return url
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
