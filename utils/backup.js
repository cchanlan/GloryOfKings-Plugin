/**
 * 插件数据备份（零依赖 zip）。
 *
 * 为什么自己拼 zip：插件的 package.json 只有 yaml 和 node-fetch 两个依赖，
 * 加 archiver 之类会让老用户升级后不装依赖直接起不来。备份要打的东西又都很小
 * （data 下除 imgCache 外实测 350KB 上下），所以用内置 zlib 的 deflateRaw
 * 全内存压完再一次性落盘，不必上流式那一套。
 *
 * 备份包里有 AuthPool.json 和 config/config/auth.yaml，**含营地登录凭证**，
 * 所以调用方（apps/dataBackup.js）只在私聊里发文件，群里一律拒绝。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { PluginPath, PluginData } from '#components'

const deflateRaw = promisify(zlib.deflateRaw)

/** 备份落盘目录。它自己在 data 下面，所以收集时必须跳过，否则第二次备份会把第一份打进去 */
export const BACKUP_DIR = path.join(PluginData, 'backup')

/** 只留最近这么多份，多的按 mtime 从旧到新删 */
export const BACKUP_KEEP = 5

/**
 * 单文件体积上限。全部内容要进内存，正常数据文件都在几百 KB；
 * 真出现超大文件（日志误落进 data/）宁可跳过并在回复里报出来，也不能把 Yunzai 撑爆。
 */
const MAX_FILE_BYTES = 32 * 1024 * 1024

/** 备份范围：用户数据 + 用户改过的配置。default_config 是随仓库发的，不用备 */
const TARGETS = ['data', 'config/config']

/** imgCache 是可再生的图片缓存（上限 200MB），backup 是备份自己，都不进包 */
const SKIP_DIRS = new Set(['imgCache', 'backup'])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** zip 用的是 DOS 时间戳：秒只有 5 位（2 秒精度），年份从 1980 起算 */
function dosStamp (date) {
  const d = date instanceof Date && !isNaN(date) ? date : new Date()
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff
  }
}

/**
 * 拼 zip：每个文件一个 local header + 数据，末尾中央目录 + EOCD。
 *
 * 名字一律 UTF-8 并置 flag bit 11 —— 包里没有中文名，但解压工具认这个位更稳；
 * 不用 data descriptor（flag bit 3），全内存压缩本来就能先算出 crc 和长度，
 * 直接写进 local header，兼容性比回填/描述符都好。
 */
async function buildZip (entries) {
  const body = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = entry.data
    const crc = crc32(raw)
    let comp = await deflateRaw(raw, { level: 9 })
    let method = 8
    // 已经压过的内容（png 之类）deflate 之后反而更大，那就存原文
    if (comp.length >= raw.length) { comp = raw; method = 0 }
    const { time, date } = dosStamp(entry.mtime)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    body.push(local, nameBuf, comp)

    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(0x0800, 8)
    head.writeUInt16LE(method, 10)
    head.writeUInt16LE(time, 12)
    head.writeUInt16LE(date, 14)
    head.writeUInt32LE(crc, 16)
    head.writeUInt32LE(comp.length, 20)
    head.writeUInt32LE(raw.length, 24)
    head.writeUInt16LE(nameBuf.length, 28)
    head.writeUInt32LE(offset, 42)
    central.push(head, nameBuf)

    offset += local.length + nameBuf.length + comp.length
  }

  const dir = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(dir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...body, dir, eocd])
}

function walk (dir, base, out) {
  let items = []
  try {
    items = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of items) {
    const full = path.join(dir, item.name)
    if (item.isDirectory()) {
      if (!SKIP_DIRS.has(item.name)) walk(full, `${base}${item.name}/`, out)
      continue
    }
    if (!item.isFile()) continue
    try {
      const stat = fs.statSync(full)
      out.push({ name: `${base}${item.name}`, full, size: stat.size, mtime: stat.mtime })
    } catch { /* 扫描期间文件被删掉就跳过 */ }
  }
}

/** 待备份文件清单（zip 内路径保留 data/ 与 config/config/ 前缀，解压后能直接覆盖回来） */
export function collectBackupFiles () {
  const files = []
  for (const rel of TARGETS) {
    const dir = path.join(PluginPath, rel)
    if (!fs.existsSync(dir)) continue
    walk(dir, `${rel}/`, files)
  }
  return files.sort((a, b) => a.name.localeCompare(b.name))
}

const pad = n => String(n).padStart(2, '0')

function stamp (d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function formatBytes (bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/** 已有备份，按时间新→旧 */
export function listBackups () {
  if (!fs.existsSync(BACKUP_DIR)) return []
  return fs.readdirSync(BACKUP_DIR)
    .filter(name => name.endsWith('.zip'))
    .map(name => {
      const full = path.join(BACKUP_DIR, name)
      try {
        const stat = fs.statSync(full)
        return { name, full, size: stat.size, mtime: stat.mtimeMs }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
}

/** 超出 keep 份的旧备份删掉，返回删掉的文件名 */
export function pruneBackups (keep = BACKUP_KEEP) {
  const removed = []
  for (const item of listBackups().slice(Math.max(keep, 1))) {
    try { fs.unlinkSync(item.full); removed.push(item.name) } catch { /* 删不掉就下次再说 */ }
  }
  return removed
}

/**
 * 打一份备份并落盘到 {@link BACKUP_DIR}。
 * @returns {Promise<{file:string,name:string,size:number,rawSize:number,names:string[],skipped:Array,pruned:string[]}>}
 */
export async function createBackup () {
  const files = collectBackupFiles()
  const entries = []
  const skipped = []

  for (const item of files) {
    if (item.size > MAX_FILE_BYTES) {
      skipped.push({ name: item.name, reason: `过大（${formatBytes(item.size)}）` })
      continue
    }
    try {
      entries.push({ name: item.name, data: fs.readFileSync(item.full), mtime: item.mtime })
    } catch (err) {
      skipped.push({ name: item.name, reason: err.message })
    }
  }
  if (!entries.length) throw new Error('没有可备份的文件（data 与 config/config 都是空的）')

  const buf = await buildZip(entries)
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  // 文件名精度到秒，同一秒里连打两份会重名互相覆盖（连点两次指令就能撞上），加序号避开
  let name = `GloryOfKings-${stamp()}.zip`
  for (let i = 2; fs.existsSync(path.join(BACKUP_DIR, name)); i++) {
    name = `GloryOfKings-${stamp()}-${i}.zip`
  }
  const file = path.join(BACKUP_DIR, name)
  fs.writeFileSync(file, buf)

  return {
    file,
    name,
    size: buf.length,
    rawSize: entries.reduce((sum, e) => sum + e.data.length, 0),
    names: entries.map(e => e.name),
    skipped,
    // 落盘之后再清，否则 keep=1 时会把刚写的这份算进去
    pruned: pruneBackups()
  }
}
