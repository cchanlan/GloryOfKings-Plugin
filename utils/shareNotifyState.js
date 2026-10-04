/**
 * 「首次安装 / 更新后提醒主人接入共享库」的状态。
 *
 * 单独一个文件是因为两个 app 都要碰它：`apps/shareNotify.js` 负责发，
 * `apps/shareBind.js` 在主人发 `#关闭营地共享库` 时要记一笔「他明确不要」。
 */
import path from 'node:path'
import { PluginData } from '#components'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'

const FILE = path.join(PluginData, 'share', 'notify.yaml')
const SCHEMA = 1

function defaults () {
  return {
    schema: SCHEMA,
    /** 已经确认送达过的版本号 */
    lastNotifiedVersion: '',
    /** 需要发但还没送达的版本号。用来扛住「发出去了但进程被杀」 */
    pendingVersion: '',
    /** 主人明确说过不要（发过 #关闭营地共享库）。拒绝就是拒绝，之后不再主动打扰 */
    declined: false,
    attempts: 0,
    lastAttemptAt: 0
  }
}

export function readNotifyState () {
  try {
    const data = readYamlFile(FILE) || {}
    if (data.schema !== SCHEMA) return defaults()
    return { ...defaults(), ...data }
  } catch {
    return defaults()
  }
}

export function writeNotifyState (patch = {}) {
  const next = { ...readNotifyState(), ...patch, schema: SCHEMA }

  try {
    writeYamlFile(FILE, next)
  } catch (error) {
    logger?.warn?.(`[营地共享] 提醒状态落盘失败：${error.message}`)
  }

  return next
}

/** 主人说过不要了 */
export function markDeclined () {
  return writeNotifyState({ declined: true })
}

/** 主人重新接入了，把「不要」的标记撤掉，以后更新照常提醒 */
export function clearDeclined () {
  return writeNotifyState({ declined: false })
}
