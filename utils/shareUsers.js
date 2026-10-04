/**
 * 用户级的「我愿意共享」开关，以及绑定变动后的自动同步。
 *
 * ## 为什么开关要单独落盘
 *
 * 不能拿「共享库里有没有我的记录」当开关用——共享库是别人搭的外部依赖，
 * 它连不上的时候，用户看到的应该还是「我开着共享」，而不是状态突然变成一团未知。
 * 本地有一份确定的意图，才能把「开着但同步失败」和「我根本没开」区分开。
 *
 * ## 默认关闭
 *
 * 用户不发指令开启就永远不上传。这是上传个人信息的功能，默认必须是关的。
 */
import path from 'node:path'
import { PluginData } from '#components'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'
import { getBoundIds, getCurrentId } from './localBind.js'
import { pushBind, revokeBind, isShareReady, isKnownShared, dropAdoptedBind } from './shareStore.js'

const USERS_FILE = path.join(PluginData, 'share', 'users.yaml')
const USERS_SCHEMA = 1

function normalize (userId) {
  return String(userId ?? '').trim()
}

/**
 * 读某个用户的共享开关。
 * @returns {{enabled: boolean, campIds: string[], updatedAt: number}}
 */
export function getUserShareState (userId) {
  const qq = normalize(userId)
  if (!qq) return { enabled: false, campIds: [], updatedAt: 0 }

  try {
    const data = readYamlFile(USERS_FILE) || {}
    if (data.schema !== USERS_SCHEMA) return { enabled: false, campIds: [], updatedAt: 0 }

    const entry = data.users?.[qq]
    return {
      enabled: entry?.enabled === true,
      campIds: Array.isArray(entry?.campIds) ? entry.campIds.map(String) : [],
      updatedAt: Number(entry?.updatedAt) || 0
    }
  } catch {
    return { enabled: false, campIds: [], updatedAt: 0 }
  }
}

export function isUserSharing (userId) {
  return getUserShareState(userId).enabled
}

function setUserShareState (userId, { enabled, campIds = [] }) {
  const qq = normalize(userId)
  if (!qq) return

  let data
  try {
    data = readYamlFile(USERS_FILE) || {}
  } catch {
    data = {}
  }
  if (data.schema !== USERS_SCHEMA || typeof data.users !== 'object' || !data.users) {
    data = { schema: USERS_SCHEMA, users: {} }
  }

  data.users[qq] = {
    enabled: Boolean(enabled),
    campIds: campIds.map(String),
    updatedAt: Date.now()
  }

  writeYamlFile(USERS_FILE, data)
}

/**
 * 开启共享：把当前绑定的全部营地ID传上去。
 *
 * **上传失败就不落盘**——本地绝不能留下「已开启」的假象，
 * 不然用户会以为自己共享好了，而库里其实什么都没有。
 *
 * @returns {Promise<{ok: boolean, message?: string, count?: number}>}
 */
export async function enableSharing (userId) {
  const qq = normalize(userId)
  if (!qq) return { ok: false, message: '缺少 QQ 号' }

  if (!isShareReady()) {
    return { ok: false, message: '本机器人还没接入营地ID共享库。进群 972915804 找主人要地址和令牌' }
  }

  const ids = getBoundIds(qq)
  if (!ids.length) {
    return { ok: false, message: '你还没有绑定营地ID，先发 #绑定营地 [营地ID]' }
  }

  const result = await pushBind(qq, ids, getCurrentId(qq) || '')
  if (!result.ok) return result

  setUserShareState(qq, { enabled: true, campIds: ids })
  return { ok: true, count: ids.length }
}

/**
 * 关闭共享：**必须真的让服务端删掉**，不能只是「以后不再上传」。
 * 不然别的机器人还会一直查到你这份数据，用户以为自己已经取消了。
 *
 * 删除失败时同样不落盘，保持「还开着」的状态对用户才是诚实的。
 *
 * @returns {Promise<{ok: boolean, message?: string}>}
 */
export async function disableSharing (userId) {
  const qq = normalize(userId)
  if (!qq) return { ok: false, message: '缺少 QQ 号' }

  if (!isShareReady()) {
    return { ok: false, message: '本机器人还没接入营地ID共享库。进群 972915804 找主人要地址和令牌' }
  }

  const result = await revokeBind(qq)
  if (!result.ok) return result

  // 顺带把之前从库里落到本机的那份清掉 —— 用户都说不要共享了，
  // 本机还留着一份「来自共享库」的绑定说不过去
  dropAdoptedBind(qq)

  setUserShareState(qq, { enabled: false })
  return { ok: true }
}

/**
 * 本地绑定变动后的同步。绑定/切换/删除营地ID 之后调它一次就够了。
 *
 * @returns {Promise<{ok: boolean, skipped?: string, count?: number, message?: string}>}
 */
export async function syncUserBind (userId) {
  const qq = normalize(userId)
  if (!qq) return { ok: true, skipped: 'no-user' }

  // 两个判据任一成立就同步：
  //  - 本机开关开着：用户在这台机器上明确开过
  //  - 库里有他的记录：他在**别的机器人**上开过共享。
  //    少了后一条，用户在 A 机器人上开的共享，B 机器人上新绑的号就永远传不上去 ——
  //    「我开了共享」是跨机器人的意愿，不该看在哪儿开的
  if (!getUserShareState(qq).enabled && !isKnownShared(qq)) {
    return { ok: true, skipped: 'not-sharing' }
  }

  if (!isShareReady()) return { ok: true, skipped: 'not-connected' }

  const ids = getBoundIds(qq)

  // 本机一个号都不剩了：什么都不做。
  // **不要**在这里发 DELETE —— 那是「撤销共享」，会把别的实例贡献的记录一起删掉；
  // 而「我在本机删光了自己的绑定」和「我不想再共享了」是两件不同的事。
  if (!ids.length) return { ok: true, skipped: 'no-local-bind' }

  const result = await pushBind(qq, ids, getCurrentId(qq) || '')
  if (result.ok) setUserShareState(qq, { enabled: true, campIds: ids })
  return result
}
