/**
 * 落盘的两条保命规则：原子写 + 坏文件隔离。零外部依赖，可脱机单测。
 *
 * ## 1. 为什么必须原子写
 *
 * 裸 `fs.writeFileSync` 是「先把文件截断成 0 字节，再把内容写进去」。进程正好在这中间
 * 被杀（`pm2 restart`、OOM、宿主重启）就留下一个半截文件。本插件的每个数据文件都是
 * **整库一份**，坏一次就是整份没了：
 *
 * | 文件 | 写入频次 | 丢了的后果 |
 * |---|---|---|
 * | `GameRecordPush.yaml` | 每个订阅每轮一次，约 3600 次/天 | 所有人的战绩推送消失 |
 * | `UserData.yaml` | 绑定/切换账号时 | 所有人要重新绑营地 |
 * | `AuthPool.json` | 登录态刷新时 | 所有人要重新扫码 |
 * | `GroupReportPush.yaml` | 开关群报时 | 群报订阅消失 |
 *
 * 写 `.tmp` 再 `rename` 覆盖：rename 在同一文件系统上是原子的，读方要么看到旧的完整
 * 文件、要么看到新的完整文件，没有中间态。`.tmp` 带 pid 后缀，两个进程同时写不会互相
 * 踩掉临时文件。
 *
 * ## 2. 为什么光原子写还不够，必须隔离坏文件
 *
 * 读订阅表的 `loadPushList` 出于「绝不让定时任务挂掉」的考虑，catch 里**静默返回空表**。
 * 这个设计本身是对的，但和裸写撞在一起会产生自我固化的数据丢失：
 *
 *   文件半截 → `YAML.parse` 抛错 → 静默返回 `{}` → 下一次 `savePushList({})` 把空表写回盘
 *
 * 于是「文件坏了」被自动改写成「所有订阅都没了」，现场干净得查不出原因，日志里一行都没有。
 * 所以解析失败时要做三件事：把坏文件挪走留证、打 error 日志、让下次写从干净状态开始。
 * 挪走而不是删掉——用户的订阅/绑定是攒出来的资产，手工还能从 `.corrupt-*` 里捞回来。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 同一个文件最多留几份坏文件快照。反复损坏时不至于把 data/ 塞满 */
const MAX_CORRUPT_COPIES = 3

/** 目录不存在就建出来。rename 的目标目录必须存在 */
function ensureDir (filePath) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

/**
 * 原子写文本文件：先写同目录的 `.tmp` 再 rename 覆盖。
 *
 * @param {string} filePath 目标路径
 * @param {string} content 要写入的完整内容
 * @throws 写盘失败时原样抛出，调用方决定是重试还是降级（临时文件已清掉）
 */
export function writeFileAtomic (filePath, content) {
  ensureDir(filePath)

  const tmpFile = `${filePath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmpFile, content, 'utf8')
    fs.renameSync(tmpFile, filePath)
  } catch (error) {
    // 失败要把临时文件清掉，否则 data/ 下会攒一堆 .tmp
    try { fs.unlinkSync(tmpFile) } catch {}
    throw error
  }
}

/**
 * `20260827-214301-472` 这种后缀，便于按时间排序也便于人读。
 * 带上毫秒是必要的：同一秒内连续隔离两次（比如轮询和指令同时读到坏文件）
 * 如果只到秒，第二份会 rename 覆盖掉第一份，把证据弄丢。
 */
function stamp (now = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}` +
    `-${String(now.getMilliseconds()).padStart(3, '0')}`
}

/**
 * 挑一个还没被占用的备份名。
 * 时间戳到毫秒已经够散，但撞上了就必须让路——rename 到已存在的名字是静默覆盖，
 * 那等于把上一份证据弄丢了，而留证是这个函数存在的全部意义。
 */
function pickBackupPath (filePath) {
  const base = `${filePath}.corrupt-${stamp()}`
  if (!fs.existsSync(base)) return base

  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`
    if (!fs.existsSync(candidate)) return candidate
  }
  return `${base}-${process.hrtime.bigint()}`
}

/** 只留最近 MAX_CORRUPT_COPIES 份坏文件快照 */
function pruneCorruptCopies (filePath) {
  const dir = path.dirname(filePath)
  const prefix = `${path.basename(filePath)}.corrupt-`

  try {
    const olds = fs.readdirSync(dir)
      .filter(name => name.startsWith(prefix))
      .sort()
      .slice(0, -MAX_CORRUPT_COPIES)
    for (const name of olds) {
      try { fs.unlinkSync(path.join(dir, name)) } catch {}
    }
  } catch {}
}

/**
 * 把解析失败的文件挪到 `<原名>.corrupt-<时间戳>` 并记一条 error 日志。
 *
 * **这个函数自己绝不抛错**：它跑在别人的 catch 分支里，是最后一道防线，
 * 再抛一次就把「读文件失败」升级成「整个定时任务崩掉」，比原来的问题更糟。
 *
 * @param {string} filePath 坏掉的文件路径
 * @param {Error|string} [error] 原始解析错误，写进日志
 * @param {string} [tag] 日志前缀，例如 `[王者推送]`
 * @returns {string} 隔离后的路径；文件不存在或挪不动时返回空串
 */
export function quarantineCorrupt (filePath, error, tag = '[王者插件]') {
  try {
    if (!filePath || !fs.existsSync(filePath)) return ''

    // 空文件不值得留证：它多半就是上一次写盘被打断的残留，留一堆 0 字节快照没意义，
    // 但日志还是要打——「文件是空的」和「文件没坏」对排查是两件事
    const empty = fs.statSync(filePath).size === 0
    const reason = error?.message || String(error || '解析失败')

    if (empty) {
      fs.unlinkSync(filePath)
      logger?.error?.(`${tag} ${path.basename(filePath)} 是空文件（可能上次写盘被打断），已删除并按空数据继续`)
      return ''
    }

    const backup = pickBackupPath(filePath)
    fs.renameSync(filePath, backup)
    pruneCorruptCopies(filePath)

    logger?.error?.(
      `${tag} ${path.basename(filePath)} 解析失败（${reason}），` +
      `已隔离到 ${path.basename(backup)} 并按空数据继续。` +
      '里面的数据可以手工捞回来，别直接删'
    )
    return backup
  } catch (err) {
    // 连挪都挪不动（权限/文件系统问题），那就只留一行日志
    try {
      logger?.error?.(`${tag} 隔离损坏文件 ${filePath} 失败: ${err.message}`)
    } catch {}
    return ''
  }
}
