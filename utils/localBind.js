/**
 * 本地绑定表（`data/UserData.yaml`）的只读访问。
 *
 * 为什么单独一个文件而不是留在 utils/index.js 里：index.js 要 re-export 共享库的
 * `resolveCurrentId`，而共享库又要靠「本地优先」这一层判断该不该去查共享库。
 * 两边互相 import 就成环了，所以把最底层的读表逻辑摘出来，谁都能安全地引用它。
 *
 * ## 为什么带一份内存缓存
 *
 * 这份表被读得极频繁，而且是**在同步循环里**读：推送轮询要给「群里的每个成员」
 * 查当前营地号，群数 × 群成员数轻松上几千次。而每次读都是
 * `readFileSync + YAML.parse` 整份文件——实测（2026-09-26，本机 1.6KB 的表）
 * 单次 2ms，用户那台 300 人绑定、15KB 的表单次 25ms。
 * 几千次就是**几十秒的同步阻塞**，整段循环里一个 await 都没有，事件循环直接停摆
 * （表现就是「定时任务一跑，机器人整个僵住」）。
 *
 * 缓存靠**文件指纹**（mtimeMs + size）失效，而不是靠写入方主动通知：
 * 这份表有好几个写入方（绑定指令、共享库落地、备份还原…），逐个去加失效调用
 * 一定会漏，而漏一处就是「用户绑了号但机器人读到旧值」。指纹判定对写入方零要求。
 *
 * ⚠️ 两个必须守住的点：
 * 1. **对外返回的必须是拷贝**。`utils/shareStore.js` 的 adoptSharedBind / dropAdoptedBind
 *    是「拿 readUserData() 的返回值直接改、再 writeYamlFile」的写法，返回缓存本体的话
 *    它们改的就是缓存。写盘成功时靠指纹还能自愈，一旦写盘失败（磁盘满、权限）就变成
 *    「内存有、盘上没有」且 mtime 没变、缓存永远命中——**永久不一致**。
 * 2. **解析失败的结果不进缓存**。一次瞬时读失败被缓存下来，就成了「所有绑定都没了」，
 *    而且没有一行日志。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PluginData } from '#components'
import { readYamlFile } from './yamlUtils.js'

const USER_DATA_FILE = path.join(PluginData, 'UserData.yaml')

/**
 * 深拷贝。优先用 `structuredClone`（Node 17+ 全局），拿不到时退回 JSON 往返——
 * 这份表里只有字符串/数字/布尔/数组，JSON 往返语义完全够。
 * 能力探测是必要的：插件会被装在各种 Node 版本上跑，这里不该成为启动即崩的那一行。
 */
const deepCopy = typeof structuredClone === 'function'
  ? structuredClone
  : (value) => JSON.parse(JSON.stringify(value))

/**
 * 解析结果缓存：`{ mtimeNs, size, data }`。data 是整张表
 */
let cache = null

/**
 * 取文件的指纹。文件不存在或 stat 失败时返回 null。
 *
 * 用 `bigint: true` 拿**纳秒级**的 mtimeNs，而不是毫秒级的 mtimeMs：
 * 毫秒精度下同一毫秒内的两次写会得到同一个值，只能靠 size 兜底，而「改了个等长的值」
 * （比如把营地号 123 换成 456）size 也不变 —— 那就漏判了。
 * 纳秒精度下这个窗口小到可以忽略。
 *
 * ⚠️ 纳秒精度的**上限取决于文件系统**（ext4 是纳秒，NTFS 约 100 纳秒，FAT 只有 2 秒），
 *    所以它不是绝对保证。真正的保证来自写入方：插件自己的写入路径（savePushList 之类）
 *    写完会主动把缓存对齐过去，不依赖指纹；指纹只用来接住「用户手改了文件」这种外部改动，
 *    那种场景不可能和上一次读落在同一瞬间。
 */
function fingerprint () {
  try {
    const stat = fs.statSync(USER_DATA_FILE, { bigint: true })
    return { mtimeNs: stat.mtimeNs, size: stat.size }
  } catch {
    return null
  }
}

/**
 * 拿缓存里的整张表（**不拷贝**，只给本文件内部的热路径用）。
 * 调用方**不得修改返回值**——要改请走 `readUserData()`。
 */
function currentData () {
  const fp = fingerprint()

  // 文件不在了（没绑过任何人 / 被手工删了）：清掉缓存按空表处理。
  // 这里必须清缓存，否则「文件删了又建」时指纹可能撞上旧缓存
  if (!fp) {
    cache = null
    return {}
  }

  if (cache && cache.mtimeNs === fp.mtimeNs && cache.size === fp.size) return cache.data

  try {
    const data = readYamlFile(USER_DATA_FILE) || {}
    cache = { mtimeNs: fp.mtimeNs, size: fp.size, data }
    return data
  } catch {
    // 解析失败按空表处理（调用方各自决定怎么表达「没有」），但**不缓存**
    cache = null
    return {}
  }
}

/** 显式失效。测试用；正常运行靠文件指纹自动失效，不需要调用 */
export function invalidateUserDataCache () {
  cache = null
}

/**
 * 直接读整张绑定表（返回**拷贝**，改它不会影响缓存和磁盘）。
 * 读失败按空表处理，调用方各自决定怎么表达「没有」
 */
export function readUserData () {
  return deepCopy(currentData())
}

/**
 * 某个 QQ 绑定的全部营地ID。
 * @param {string|number} userId
 * @returns {string[]} 没绑过返回空数组
 */
export function getBoundIds (userId) {
  const entry = currentData()[userId]
  return Array.isArray(entry?.ids) ? [...entry.ids] : []
}

/**
 * 某个 QQ 当前选中的营地ID。
 * @param {string|number} userId
 * @returns {string|null}
 */
export function getCurrentId (userId) {
  const entry = currentData()[userId]
  if (!entry || !Array.isArray(entry.ids) || !entry.ids.length) return null

  const index = Number(entry.current) || 0
  return entry.ids[index] ?? entry.ids[0] ?? null
}
