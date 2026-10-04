/**
 * 王者插件黑名单。
 *
 * 作用是把某个 QQ 从这个插件里整个摘出去：他发的任何王者指令都不再有回应，
 * 之前订阅过的战绩推送 / 上下线提醒 / 日周月报也一起停，群报和排行榜的统计里也不算他。
 * 订阅数据一个都不删，从名单里移出去就自动恢复。
 *
 * 为什么不能只靠宿主的全局黑名单（config/config/other.yaml 的 blackUser）：
 * 那份名单挡的是「用户主动发消息」这条路（loader.checkBlack 在分发前就 return 了），
 * 而定时推送是插件自己按 cron 主动发出去的，压根不经过它 —— 于是就出现「人早拉黑了，
 * 战绩推送还在往群里推」。所以这里两件事都做：插件自己维护一份名单
 * （config.yaml 的 blackList，锅巴里也能直接改），同时默认跟随宿主那份全局名单。
 *
 * 拦指令的做法见本文件末尾的 guardApps()：不去 20 多个 app 里逐个加判断，
 * 而是在 index.js 加载完模块之后统一给它们的方法套一层闸门。
 * 拦推送则是在各自遍历订阅的地方调 isBlackUser()（推送入口不走指令那条闸门）。
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { Config, PluginPath } from '#components'

/** config.yaml 里存名单的字段 */
const FIELD = 'blackList'
/** config.yaml 里「是否跟随宿主全局黑名单」的开关字段 */
const FOLLOW_FIELD = 'blackListFollowGlobal'

/**
 * 宿主的全局黑名单文件。路径按插件目录反推而不是 process.cwd()：
 * 调试脚本的 cwd 不一定在 Yunzai 根（和 components/Path.js 里同一个理由）。
 * 宿主目录结构不一样时读不到就当没有，不影响插件自己那份名单。
 */
const HOST_OTHER_YAML = path.resolve(PluginPath, '..', '..', 'config', 'config', 'other.yaml')

/** 全局名单的读盘缓存：推送轮询会逐个订阅问一遍，没必要每次都读文件 */
const HOST_CACHE_MS = 10 * 1000
let hostCache = { at: 0, list: [] }

/** ID 一律按字符串比对：官方 Bot 的 user_id 是 appid:openid 形态，不是纯数字 */
const normalize = id => String(id ?? '').trim()

function readCfg () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/** 插件自己的黑名单，去重后的字符串数组 */
export function getBlackList () {
  const raw = readCfg()[FIELD]
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : [])
  return [...new Set(arr.map(normalize).filter(Boolean))]
}

/** 是否跟随宿主全局黑名单，缺配置按开着算 */
export function followGlobalBlack () {
  return readCfg()[FOLLOW_FIELD] !== false
}

/**
 * 宿主全局黑名单里的人。
 * blackUser 是 Yunzai 自己判黑名单用的字段，blackQQ 是不少管理插件在写的另一个字段，
 * 两个都认 —— 用户往哪个里写都算拉黑。
 */
export function getHostBlackList () {
  const now = Date.now()
  if (now - hostCache.at < HOST_CACHE_MS) return hostCache.list

  let list = []
  try {
    const other = YAML.parse(fs.readFileSync(HOST_OTHER_YAML, 'utf8')) || {}
    const raw = [...(other.blackUser || []), ...(other.blackQQ || [])]
    list = [...new Set(raw.map(normalize).filter(Boolean))]
  } catch {
    list = []
  }

  hostCache = { at: now, list }
  return list
}

/**
 * 这个 QQ 是不是被拉黑了。指令和推送两条路都用它。
 * @param {string|number} userId QQ 号（或官方 Bot 的 appid:openid）
 * @returns {boolean}
 */
export function isBlackUser (userId) {
  const id = normalize(userId)
  if (!id) return false
  if (getBlackList().includes(id)) return true
  return followGlobalBlack() && getHostBlackList().includes(id)
}

/**
 * 这条消息该不该被无视。
 * 主人永远放行：不然主人一旦被写进（或误写进）名单，连 #王者取消拉黑 都发不出来，
 * 只能去手改配置文件。
 * @param {object} e 消息事件
 * @returns {boolean}
 */
export function isBlockedEvent (e) {
  if (!e) return false
  if (e.isMaster) return false
  return isBlackUser(e.user_id)
}

/**
 * 加入黑名单。
 * @returns {'ok'|'exists'|'invalid'}
 */
export function addBlackUser (userId) {
  const id = normalize(userId)
  if (!id) return 'invalid'

  const list = getBlackList()
  if (list.includes(id)) return 'exists'

  Config.modify('config', FIELD, [...list, id])
  return 'ok'
}

/**
 * 移出黑名单。只动插件自己那份名单，宿主的全局名单不碰
 * （那是别的功能在用的，插件无权替用户改）。
 * @returns {'ok'|'absent'|'invalid'}
 */
export function removeBlackUser (userId) {
  const id = normalize(userId)
  if (!id) return 'invalid'

  const list = getBlackList()
  if (!list.includes(id)) return 'absent'

  Config.modify('config', FIELD, list.filter(item => item !== id))
  return 'ok'
}

/* ------------------------------------------------------------- 指令闸门 */

/**
 * 判断某个方法的第一个参数是不是消息事件。
 * 消息事件一定同时带 user_id 和 reply()，而 app 里那些内部方法的首参是
 * 字符串（qq / campId）或普通对象（view），不会同时满足这两条。
 */
function pickEvent (arg) {
  if (!arg || typeof arg !== 'object') return null
  if (arg.user_id == null || typeof arg.reply !== 'function') return null
  return arg
}

/** 已套过闸门的 prototype，重复调用 guardApps 不会叠几层壳 */
const guarded = new WeakSet()

/**
 * 给所有 app 类的方法套一层黑名单闸门。
 *
 * 命中黑名单时返回 false —— 这是 Yunzai loader 约定的「本处理器不处理」信号
 * （`if (res === false) continue`），于是这条消息继续往后找别的插件，
 * 王者插件这边一个字都不会回，日志也只有 debug 一行。
 *
 * 为什么包 prototype 上的**全部**方法而不是只包 rule 里那几个 fnc：
 * 要拿到 rule 得先 new 一个实例，而这些类的 constructor 会注册定时任务，
 * 白 new 一个出来有副作用。全包住则只需靠首参识别消息事件，顺带把
 * 「fnc 签名不带 e、只读 this.e」的写法也一起兜住。
 *
 * @param {Record<string, Function>} apps index.js 收集到的 app 类
 * @returns {number} 套上闸门的方法数，只用于日志
 */
export function guardApps (apps = {}) {
  let count = 0

  for (const cls of Object.values(apps)) {
    if (typeof cls !== 'function' || !cls.prototype) continue
    // 管名单的那个 app 自己不能被自己挡住（主人本来就豁免，这里是双保险）
    if (cls.skipBlackGuard) continue
    if (guarded.has(cls.prototype)) continue
    guarded.add(cls.prototype)

    for (const key of Object.getOwnPropertyNames(cls.prototype)) {
      if (key === 'constructor') continue

      const desc = Object.getOwnPropertyDescriptor(cls.prototype, key)
      // 只包函数。getter/setter 一律跳过：光取值就可能有副作用
      if (!desc || typeof desc.value !== 'function' || !desc.writable || !desc.configurable) continue

      const original = desc.value
      Object.defineProperty(cls.prototype, key, {
        ...desc,
        value: function (...args) {
          const e = pickEvent(args[0]) || pickEvent(this?.e)
          if (e && isBlockedEvent(e)) {
            globalThis.logger?.debug?.(`[王者黑名单] 已忽略 ${e.user_id} 触发的 ${cls.name}.${key}`)
            return false
          }
          // 同步方法必须原样同步返回，不能包成 async：
          // 内部工具方法（拼文案、算数据）也在这里面，包成 Promise 会把调用方全弄坏
          return original.apply(this, args)
        }
      })
      count++
    }
  }

  return count
}
