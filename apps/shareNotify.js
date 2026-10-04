/**
 * 首次安装 / 每次更新后，私聊主人问一句要不要接入营地ID共享库。
 *
 * ## 触发时机为什么是「模块顶层的 setTimeout」
 *
 * - **不能放 constructor**：`lib/plugins/loader.js` 会对同一个插件类 new 两次实例，
 *   构造函数会跑两遍，等于提醒发两条。
 * - **不能放 cron**：loader 的 startTask 没有重入保护，node-schedule 不等回调跑完
 *   就排下一次。
 * - **顶层不能做网络 I/O**：loader 有 plugin_load_timeout 上限，超时整个插件加载失败。
 *   读本地的 package.json 是同步 fs，安全；发消息必须推迟到定时器里。
 *
 * 推迟 60 秒（而不是 cacheManager 的 30 秒）是为了等适配器连上——
 * Bot.sendMasterMsg 最终走 sendFriendMsg，适配器没连上就是白发。
 *
 * ## 什么样的版本才提醒
 *
 *   已接入            → 不提醒（人家已经在用了）
 *   说过不要（declined）→ 不提醒（拒绝就是拒绝，别每次更新都骚扰一遍）
 *   版本变了且没接入   → 提醒一次
 *
 * 「说过不要」的唯一入口是主人主动发 `#关闭营地共享库`。想反悔就自己发
 * `#营地共享库` 看状态，那条路径一直都在。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PluginPath, PluginName } from '#components'
import { shouldQuote, isShareReady } from '#utils'
import { readNotifyState, writeNotifyState } from '../utils/shareNotifyState.js'
import { sendMaster } from '../utils/masterMsg.js'

/** 发送失败后的重试间隔。3 次之后就放弃，免得变成每次启动都骚扰一遍 */
const RETRY_DELAYS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000]
const MAX_ATTEMPTS = 3

/** 启动后多久跑第一次。见文件头关于「等适配器」的说明 */
const FIRST_RUN_DELAY_MS = 60 * 1000

function readVersion () {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PluginPath, 'package.json'), 'utf8'))
    return String(pkg.version || '')
  } catch {
    return ''
  }
}

function buildMessage () {
  return [
    '📢 王者插件更新：新增「营地ID 共享库」',
    '',
    '它解决什么：你在别的机器人上绑过的营地ID，换一个机器人不用重新绑定。',
    '',
    '怎么开：进群 972915804 找主人要共享库地址和令牌，然后：',
    '  #营地共享库地址 <地址>',
    '  #营地共享库令牌 <令牌>',
    '  #接入营地共享库',
    '',
    '两点要先知道：',
    '· 用户默认不共享，要他们自己发 #开启营地ID共享 才传',
    '· 接上后本机得有全局账号（#营地wx全局登录 / #营地QQ全局登录）才查得动别人的号',
    '',
    '不想用就发 #关闭营地共享库，以后不再问。',
    '详情：#营地共享库 看状态，README 里有完整说明。'
  ].join('\n')
}

/**
 * @param {{force?: boolean}} [options] force=true 时跳过「已接入/已拒绝」的判断（手动触发用）
 */
async function runNotify (options = {}) {
  const version = readVersion()
  if (!version) return { sent: false, reason: 'no-version' }

  const state = readNotifyState()

  if (!options.force) {
    // 已经在用了，没什么好问的
    if (isShareReady()) {
      if (state.lastNotifiedVersion !== version) {
        writeNotifyState({ lastNotifiedVersion: version, pendingVersion: '', attempts: 0 })
      }
      return { sent: false, reason: 'already-connected' }
    }

    if (state.declined) return { sent: false, reason: 'declined' }

    const retrying = state.pendingVersion === version
    if (!retrying && state.lastNotifiedVersion === version) {
      return { sent: false, reason: 'already-notified' }
    }

    if (retrying && state.attempts >= MAX_ATTEMPTS) {
      logger.warn(
        `[${PluginName}] 共享库接入提醒已重试 ${state.attempts} 次仍未送达，放弃。` +
        '想接入的话发 #营地共享库'
      )
      return { sent: false, reason: 'gave-up' }
    }
  }

  const attempts = (state.pendingVersion === version ? state.attempts : 0) + 1
  if (!options.force) {
    // 先落盘「该发」这件事：发到一半被 pm2 restart 打断也不会丢掉这个意图
    writeNotifyState({ pendingVersion: version, attempts, lastAttemptAt: Date.now() })
  }

  const delivered = await sendMaster(buildMessage())

  if (delivered) {
    if (!options.force) {
      writeNotifyState({ lastNotifiedVersion: version, pendingVersion: '', attempts: 0 })
    }
    logger.mark(`[${PluginName}] 已向主人发送营地ID共享库的接入提醒（v${version}）`)
    return { sent: true }
  }

  if (!options.force && RETRY_DELAYS[attempts - 1]) {
    const timer = setTimeout(
      () => runNotify().catch(() => {}),
      RETRY_DELAYS[attempts - 1]
    )
    timer.unref?.()
  }

  return { sent: false, reason: 'undelivered' }
}

export default class ShareNotify extends plugin {
  constructor () {
    super({
      name: '王者营地ID共享提醒',
      dsc: '首次安装/更新后提醒主人接入共享库',
      event: 'message',
      priority: 0,
      rule: [
        // 手动补发一次。排查「我到底能不能收到私聊」时很有用
        { reg: '^#营地共享库提醒$', fnc: 'remind', permission: 'master' }
      ]
    })
  }

  async remind (e) {
    const result = await runNotify({ force: true })
    const text = result.sent
      ? '已私聊发送，去私聊里看看收到没有'
      : '没发出去，先确认机器人是主人的好友'

    return e.reply(text, shouldQuote())
  }
}

// 模块顶层排一次。unref 保证它不会吊住事件循环
const bootTimer = setTimeout(() => runNotify().catch(() => {}), FIRST_RUN_DELAY_MS)
bootTimer.unref?.()
