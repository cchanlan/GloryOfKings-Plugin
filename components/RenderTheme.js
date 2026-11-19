/** 出图主题只读配置：每次渲染传入内联 CSS，不写插件资源、不依赖浏览器 CSS 缓存。 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
let cachedImage = null
function rasterType (bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  return ''
}
// 模糊仅作用于独立背景层；旧 renderBackgroundOpacity 不再叠透明度遮罩。
export function backgroundBlur (value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return 12
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(30, n)) : 12
}
export function resolveBackground (value, basePath) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) return ''
  const source = value.trim()
  if (/^https?:\/\//i.test(source)) {
    try {
      const url = new URL(source)
      if (url.username || url.password) return ''
      return url.href
    } catch { return '' }
  }
  // 不把其它协议当文件读；本地仅接受真实的栅格图，不支持 SVG/HTML。
  if (/^[a-z][\w+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) return ''
  try {
    const filename = path.resolve(basePath, source)
    const st = fs.statSync(filename)
    if (!st.isFile() || st.size <= 0 || st.size > MAX_IMAGE_BYTES) return ''
    const key = `${filename}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}`
    if (cachedImage?.key === key) return cachedImage.data
    const bytes = fs.readFileSync(filename)
    if (bytes.length > MAX_IMAGE_BYTES) return ''
    const mime = rasterType(bytes)
    if (!mime) return ''
    const data = `data:${mime};base64,${bytes.toString('base64')}`
    cachedImage = { key, data }
    return data
  } catch { return '' }
}
export function buildThemeStyle (config = {}, basePath = '.') {
  const blur = backgroundBlur(config.renderBackgroundBlur)
  const image = resolveBackground(config.renderBackground, basePath)
  // URL 必须无法结束 CSS 字符串或 </style>；URL 查询参数中的 & 不做 HTML 转义。
  const safeImage = image.replace(/[<>"'\\()\s]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
  return `html{--gok-background-blur:${blur}px;${safeImage ? `--gok-custom-background:url("${safeImage}");` : ''}}`
}
