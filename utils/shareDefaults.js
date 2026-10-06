/**
 * 「共享库地址 / 令牌」的默认值补齐与老配置迁移。
 *
 * ## 为什么需要这个文件
 *
 * 令牌是主人**代共享库签**的 —— 观战 / 营地消息 / 共享库三套共用一个值。所以
 * 用户接入观战或营地消息之后，共享库其实**已经能用了**，只差锅巴那格地址：
 * 面板上「共享库地址」空着，他要么去发 #营地共享库地址，要么再找主人问一遍。
 * 接入那一刻顺手补上，用户打开锅巴就是齐的。
 *
 * 默认地址**读模板不硬编码**（`config/default_config/config.yaml` 的
 * `shareApiUrl`）—— 将来换地址只改模板一处，所有下游自动跟上。
 *
 * ## 老配置的令牌有一段时间写在 `shareToken` 里
 *
 * 合并之前，接入指令写的是 `shareToken`，而锅巴面板那一格的字段是 `distToken`
 * —— 于是老用户的面板上「接入令牌」一直是空的，可他其实配好了。读取侧
 * （`utils/shareStore.js`）早就做了 `distToken || shareToken` 回退，但**面板不认**
 * 这个回退，显示的就是空。这里把那批老值显式搬过去，让面板和读取侧看到同一份。
 */
import { Config } from '#components'

/** 读用户配置里的某个键（读不到返回空串，绝不抛） */
function userValue (key) {
  try {
    return String(Config.getDefOrConfig('config')?.[key] || '').trim()
  } catch {
    return ''
  }
}

/** 读**模板**里的某个键（换默认值只改模板一处） */
function templateValue (key) {
  try {
    return String(Config.getdefSet('config')?.[key] || '').trim()
  } catch {
    return ''
  }
}

/**
 * 用户没填过「共享库地址」时，用模板里的默认值补上。
 *
 * ⚠️ 只补**空**的那种。用户填过（哪怕是另一个地址）一律不动 —— 那是有意的选择，
 *    「留空 = 不接入共享库」也是合法状态，覆盖它等于改用户的配置。
 *
 * @returns {boolean} 真的补了才返回 true（调用方据此决定要不要告诉用户）
 */
export function fillDefaultShareUrl () {
  if (userValue('shareApiUrl')) return false
  const fallback = templateValue('shareApiUrl')
  if (!fallback) return false
  Config.modify('config', 'shareApiUrl', fallback)
  return true
}

/**
 * 把老的 `shareToken` 搬到 `distToken`（只在 `distToken` 还是空的时候）。
 *
 * 两个值语义完全一样（合并后是同一个令牌），搬过去只是让锅巴面板显示得出来。
 * `distToken` 已经有值就什么都不做 —— 新值一定比老的准。
 *
 * @returns {boolean} 真的搬了才返回 true
 */
export function migrateLegacyShareToken () {
  if (userValue('distToken')) return false
  const legacy = userValue('shareToken')
  if (!legacy) return false
  Config.modify('config', 'distToken', legacy)
  return true
}
