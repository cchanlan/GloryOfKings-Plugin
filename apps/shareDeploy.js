/**
 * 营地ID共享库的**令牌管理**：#发令牌 / #接入方 / #吊销 / #同步 / #查。
 *
 * ## ⚠️ 这个库不再支持自行部署（2026-09 起）
 *
 * 以前这里还有 `#营地共享库部署` / `#状态` / `#卸载` 三条指令，把 `server` 分支
 * 浅克隆到本机再 pm2 拉起。现在**共享库由主人统一提供**：服务端代码不再公开，
 * 想要用的人**进群 972915804 找主人要地址和令牌**，然后用
 * `#营地共享库地址 <地址>` + `#营地共享库令牌 <令牌>` + `#接入营地共享库` 三步接上。
 *
 * 所以这个文件从「部署 + 运维」缩成了纯「令牌管理」：
 *   · 主人用 `#营地共享库发令牌 @某人` 给别人的机器人签令牌
 *   · `#营地共享库接入方` 看谁在用、`#营地共享库吊销 <序号>` 踢人
 *   · 库跑在别的机器/Docker 上时，配 `#营地共享库管理密钥 <密钥>` 就能远程管
 *
 * ## 三条硬规矩（照旧）
 *
 * 1. **令牌只在私聊里出现**。群里执行的话结果一律走私聊，群里只回一句「已私聊」。
 * 2. **管理密钥只走私聊**（见 apps/shareBind.js 的 setAdminSecret）。
 * 3. **令牌明文只在签发那一次出现**，之后列表里只能看到前缀。
 */
import fs from 'node:fs'
import path from 'node:path'
import fetch from 'node-fetch'
import { PluginPath, PluginName } from '#components'
import {
  shouldQuote, readShareConfig, readUserData, reconcileNow, isShareReady, pushBind,
  querySharedBind, AT_HEAD,
  stripAtText, pickAtText, resolveTargetUserId, resolveMemberName
} from '#utils'
import { sendPrivate } from '../utils/privateMsg.js'

/** 云崽根目录（插件住在 `<根>/plugins/<名字>`，往上两级） */
const YunzaiRoot = path.resolve(PluginPath, '../..')

/**
 * 本机部署过的库在哪。⚠️ 现在**不再支持自行部署**，这个常量只用来读旧部署留下的
 * `.env`（主人以前在本机搭过的话，`#营地共享库发令牌` 还能直接管那个库）。
 */
const SERVER_DIR = path.join(YunzaiRoot, 'data', 'gok-share-server')
const ENV_FILE = path.join(SERVER_DIR, '.env')

const PROC_NAME = 'gok-share'
const DEFAULT_PORT = 8787

/* ------------------------------------------------------------ 小工具 */

function readEnvFile () {
  try {
    const out = {}
    for (const rawLine of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue

      const eq = line.indexOf('=')
      if (eq <= 0) continue
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 管理接口的调用统一走 base（如 http://127.0.0.1:8787 或已接入的共享库地址）：
 * 本机部署和远程部署（另一台机器 / Docker）用的是同一套端点，只有 base 不同。
 */
async function issueToken (base, adminSecret, name) {
  const res = await fetch(`${base}/api/v1/admin/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': adminSecret },
    body: JSON.stringify({ name: name || '本机机器人' }),
    signal: AbortSignal.timeout(8000)
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`签发令牌失败（HTTP ${res.status}${text ? `：${text.slice(0, 120)}` : ''}）`)
  }
  return res.json()
}

/**
 * 探一次库的统计（多少人、多少条绑定、几个接入方在用）。
 * 导出给 apps/shareBind.js 的 `#营地共享库` 面板用 —— 库跑在别的机器上时，
 * 这是主人唯一的「看一眼」入口。连不上返回 null。
 */
export async function probeAdmin (base, adminSecret) {
  try {
    const res = await fetch(`${base}/api/v1/admin/stats`, {
      headers: { 'X-Admin-Secret': adminSecret },
      signal: AbortSignal.timeout(5000)
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/** 列出已签发的接入方。返回 null 表示连不上服务端 */
async function listClients (base, adminSecret) {
  try {
    const res = await fetch(`${base}/api/v1/admin/tokens`, {
      headers: { 'X-Admin-Secret': adminSecret },
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return null
    return (await res.json()).clients || []
  } catch {
    return null
  }
}

/** 吊销一个接入方。返回 false 表示没这个 id 或者连不上 */
async function revokeClient (base, adminSecret, id) {
  try {
    const res = await fetch(`${base}/api/v1/admin/tokens/${id}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Secret': adminSecret },
      signal: AbortSignal.timeout(5000)
    })
    return res.ok
  } catch {
    return false
  }
}

/* ------------------------------------------------ 服务端代码的拉取与迁移 */

/** 08-27 21:43 */
function fmtTime (ts) {
  const n = Number(ts)
  if (!n) return '—'
  const d = new Date(n)
  const p = v => String(v).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ------------------------------------------------------------ 插件 */

export class ShareDeploy extends plugin {
  constructor () {
    super({
      name: '王者营地ID共享库令牌管理',
      dsc: '给别人的机器人签令牌 / 看接入方 / 吊销（共享库由主人统一提供，不再支持自行部署）',
      event: 'message',
      priority: 0,
      rule: [
        // ⚠️ 这里**没有**部署/状态/卸载三条 —— 共享库改成只能接入了，
        //    想要用的人进群 972915804 找主人要地址和令牌。
        //    「营地共享库X」和「营地共享X」两种叫法都收 —— 主人自己就打过
        //    `#营地共享接入方`，少了中间那个「库」字。
        // 「发令牌」是给**别人**的机器人签的（部署时那条是给自己用的）。
        // 刻意不叫 `#营地共享库令牌列表` 之类：既有那条 `#营地共享库令牌 <值>`
        // 是「设置我自己要用的令牌」，两者只差一个字，用户会搞混。
        // - 备注是 `(.*)` 而不是 `(.+)`：@ 了人的话不写备注也说得通（拿 TA 的昵称当备注）
        // - 加 AT_HEAD 是为了认「先 @ 人再发指令」这种写法（群里最常见的顺序）
        { reg: `${AT_HEAD}#营地共享库?发令牌\\s*(.*)$`, fnc: 'issue', permission: 'master' },
        { reg: '^#营地共享库?接入方$', fnc: 'clients', permission: 'master' },
        { reg: '^#营地共享库?吊销\\s*(\\d+)$', fnc: 'revoke', permission: 'master' },
        // 全量对账。自动对账是「用户发指令时后台顺手做」、还带一小时节流，
        // 这条是人工兜底：刚接入完、或者怀疑某些人没传上去时手动推一遍
        { reg: '^#营地共享库?同步$', fnc: 'syncAll', permission: 'master' },
        // 直接问库。排查「两台都同步了、对面还说我没绑定」的第一站
        { reg: '^#营地共享库?查\\s*(\\d{5,12})$', fnc: 'lookup', permission: 'master' }
      ]
    })
  }

  /**
   * 结果里可能有令牌或者别人的 QQ，不能往群里发。
   * 群里执行时把详情走私聊，群里只留一句「发你私聊了」。
   *
   * @param {string} [hint] 群里那句提示。默认按「内容敏感」写，
   *   发令牌那种要显式传一句更贴切的，不然会张冠李戴（同步结果说成「带令牌」）
   */
  async replySafely (e, text, { hint } = {}) {
    if (!e.isGroup) return e.reply(text, shouldQuote())

    const { ok: delivered } = await sendPrivate(e.user_id, text, { bot: e.bot, groupId: e.group_id })
    await e.reply(
      delivered
        ? (hint || '结果不太方便发在群里，已经私聊发你了')
        : '请私聊我再发一次这条指令',
      shouldQuote()
    )
    return undefined
  }

  /* -------------------------------------------------- 给别人发令牌 */

  /**
   * 找管理接口的入口（发令牌 / 接入方 / 吊销都走它）。两种来源，本机优先：
   *  - 本机部署：读 `.env` 里的管理密钥，base 用 127.0.0.1:端口
   *  - 远程部署：另一台机器 / Docker 跑的库，管理密钥走配置（#营地共享库管理密钥），
   *    base 就用已接入的共享库地址 —— 管理接口和接入接口本来就是同一个服务端
   * 都没有返回 null
   */
  readServerEnv () {
    const env = readEnvFile()
    if (env.GOK_ADMIN_SECRET) {
      const port = Number(env.GOK_PORT) || DEFAULT_PORT
      return { base: `http://127.0.0.1:${port}`, port, adminSecret: env.GOK_ADMIN_SECRET, remote: false }
    }

    // 远程时地址必然来自已接入的配置（没有地址就进不了这个分支），
    // 不存在「没配地址要拼占位符」的情况
    const cfg = readShareConfig()
    if (cfg.adminSecret && cfg.apiUrl) {
      return { base: cfg.apiUrl, port: null, adminSecret: cfg.adminSecret, remote: true }
    }

    return null
  }

  /**
   * 给**别人**的机器人签一个令牌。两种发法：
   *
   *  - `#营地共享库发令牌 某某的机器人` —— 把「让对方发的三行」拼好回给主人，主人自己转
   *  - `#营地共享库发令牌 @某某`        —— 直接私聊发给 TA，省掉主人转这一手
   *
   * ⚠️ 令牌**任何情况下都不出现在群里**（文件头第 1 条规矩）：@ 的那个人收不到时，
   * 令牌退回私聊给主人，群里只说一句「没发出去」。
   */
  async issue (e) {
    const note = stripAtText(e.msg).replace(/^#营地共享库?发令牌\s*/, '').trim()

    // @ 的是谁。点选出来的 @ 带 e.at（QQ 号）；手打的「@昵称」消息里没有 at 段，
    // 只能按名字去群成员里找（resolveTargetUserId 内部就是这么兜的）
    let target = null
    const atName = pickAtText(e.msg)
    if ((e.at && !e.atme) || atName) {
      let userId = e.at && !e.atme ? String(e.at) : ''
      if (!userId) {
        const resolved = await resolveTargetUserId(e)
        if (resolved.hint) return e.reply(resolved.hint, shouldQuote())
        userId = resolved.userId
      }
      target = { userId, name: (await resolveMemberName(e.group, userId)) || userId }
    }

    // 没写备注就拿被 @ 的人顶替，省得主人再想一个名字
    const label = note || (target ? `${target.name} 的机器人` : '')
    if (!label) {
      return e.reply('加个备注（比如「某某的机器人」），或者 @ 一下要发给谁', shouldQuote())
    }

    const server = this.readServerEnv()
    if (!server) {
      return e.reply(
        '这台管不了共享库：还没接入，或者没配远程管理密钥。' +
        '进群 972915804 找主人要地址和令牌，接入后发 #营地共享库管理密钥 <密钥>',
        shouldQuote()
      )
    }

    try {
      const created = await issueToken(server.base, server.adminSecret, label)
      const configured = readShareConfig().apiUrl
      const apiUrl = configured || `http://你的服务器IP:${server.port}`

      const steps = [
        `#营地共享库地址 ${apiUrl}`,
        `#营地共享库令牌 ${created.token}`,
        '#接入营地共享库',
        '',
        '也可发 #锅巴登录，打开登录链接，进入「插件配置 → 王者荣耀 → 服务端接入」，填写「接入令牌」；填写「共享库地址」，打开「营地ID共享库」开关并保存。'
      ]

      const ownerText = [
        `📮 给「${label}」的令牌（只显示这一次，别弄丢）`,
        '',
        created.token,
        '',
        '把下面三行整段发给对方，让 TA 私聊自己的机器人依次发送：',
        ...steps,
        '',
        configured
          ? '地址用的是你已经配好的那个。'
          : `⚠️ 你还没配过共享库地址，上面那行里的「你的服务器IP」要换成真实的（带 ${server.port} 端口）。`,
        '想看谁在用、或者踢掉谁：#营地共享库接入方'
      ].join('\n')

      // 地址还没配过时，「三行」里的地址是个占位符，直接甩给对方只会让 TA 更迷糊 ——
      // 所以这种情况不管 @ 没 @，都按老路子把结果留给主人
      if (target && configured) {
        const sent = await sendPrivate(target.userId, [
          `🔑 「${label}」的营地ID共享库接入信息（只发这一次，别弄丢）`,
          '',
          '私聊你的机器人，依次发这三行：',
          ...steps
        ].join('\n'), { bot: e.bot, groupId: e.group_id })

        if (sent.ok) {
          logger.mark(`[${PluginName}] 共享库令牌已私聊给 ${target.userId}（${sent.via}）：${label}`)
          return e.reply(`已经把「${label}」的令牌私聊发给 ${target.name} 了`, shouldQuote())
        }

        logger.mark(`[${PluginName}] 私聊 ${target.userId} 失败（${sent.reason}），令牌改发主人：${label}`)
        const { ok: delivered } = await sendPrivate(e.user_id, ownerText, { bot: e.bot, groupId: e.group_id })
        return e.reply(
          delivered
            ? `私聊给 ${target.name} 未确认发送成功，令牌已经私聊发给你了，你转给 TA 吧`
            : `私聊给 ${target.name} 发不出去，你的私聊也没成功。你私聊我发一次这条指令，我把令牌发你`,
          shouldQuote()
        )
      }

      logger.mark(`[${PluginName}] 已签发共享库令牌：${label}`)

      return this.replySafely(e, ownerText, {
        hint: target
          ? '地址还没配好，结果里带令牌，先私聊发你了'
          : '结果里带令牌，已经私聊发你了'
      })
    } catch (error) {
      logger.error(`[${PluginName}] 签发共享库令牌失败：${error?.message || error}`)
      return e.reply('签发或发送失败，请私聊我再试一次', shouldQuote())
    }
  }

  /** 列出已签发的接入方。令牌明文只在签发那一次出现，这里只能看到前缀 */
  async clients (e) {
    const server = this.readServerEnv()
    if (!server) {
      return e.reply(
        '这台管不了共享库：还没接入，或者没配远程管理密钥。' +
        '进群 972915804 找主人要地址和令牌，接入后发 #营地共享库管理密钥 <密钥>',
        shouldQuote()
      )
    }

    const list = await listClients(server.base, server.adminSecret)
    if (list === null) {
      return e.reply('连不上共享库，检查一下地址和网络', shouldQuote())
    }

    const active = list.filter(row => row.enabled).length
    const lines = [`👥 已签发的接入方（${active} 个在用，共 ${list.length} 个）`, '']

    if (!list.length) {
      lines.push('还一个都没发过')
    } else {
      for (const row of list) {
        lines.push(`${row.id}. ${row.name}${row.enabled ? '' : '（已吊销）'}`)
        lines.push(
          `   令牌 ${row.tokenPrefix}… · 最后请求 ${Number(row.lastSeenAt) ? fmtTime(row.lastSeenAt) : '从没请求过'}`
        )
      }
    }

    lines.push('', '发给别人：#营地共享库发令牌 <备注>（@一下群友就直接私聊发给 TA）')
    lines.push('踢掉一个：#营地共享库吊销 <序号>')

    return e.reply(lines.join('\n'), shouldQuote())
  }

  /** 吊销。对方那边的机器人再请求会直接连不上（403） */  async revoke (e) {
    const id = Number(e.msg.match(/^#营地共享库吊销\s*(\d+)$/)?.[1])

    const server = this.readServerEnv()
    if (!server) {
      return e.reply(
        '这台管不了共享库：还没接入，或者没配远程管理密钥。' +
        '进群 972915804 找主人要地址和令牌，接入后发 #营地共享库管理密钥 <密钥>',
        shouldQuote()
      )
    }

    const ok = await revokeClient(server.base, server.adminSecret, id)
    if (!ok) {
      return e.reply(`没找到 ${id} 号接入方，发 #营地共享库接入方 看看列表`, shouldQuote())
    }

    logger.mark(`[${PluginName}] 已吊销共享库接入方 #${id}`)
    return e.reply(
      `已吊销 ${id} 号。对方的机器人下次请求共享库会被拒（他自己的其他功能不受影响）。`,
      shouldQuote()
    )
  }

  /**
   * 把本机**所有**绑定过的用户全量对一遍账。
   *
   * ⚠️ 用的是**客户端配置**（`shareApiUrl` / `shareToken`），不是 `server/.env` ——
   * 所以**接入别人库的机器人一样能用**，不是只有搭库那台才能跑。
   * 这里以前读的是 readServerEnv()，把接入方全挡在外面了。
   *
   * 自动对账是「用户发指令时后台顺手做」、还带一小时节流；这条是人工兜底 ——
   * 刚接入完共享库、或者怀疑某些人的数据没传上去时手动推一遍。
   *
   * 只处理「库里本来就有他记录」的人。库里没有说明他没开共享，不该替他传 ——
   * 这是「共享」而不是「上传所有人的数据」，边界必须守住。
   */
  async syncAll (e) {
    if (!isShareReady()) {
      return e.reply('这台还没接入营地ID共享库。进群 972915804 找主人要地址和令牌', shouldQuote())
    }

    const store = readUserData()
    const users = Object.keys(store).filter(qq => Array.isArray(store[qq]?.ids) && store[qq].ids.length)
    if (!users.length) {
      return e.reply('本机还没有人绑定过营地ID', shouldQuote())
    }

    // 每人至少一次请求，串行做完要一会儿；先给回执，不然以为指令死了
    await e.reply(
      `正在对账本机 ${users.length} 个绑定用户，大约 ${Math.ceil(users.length * 0.3)} 秒…`,
      shouldQuote()
    )

    let pushed = 0
    let notShared = 0
    let failed = 0
    // 记下具体是谁同步上去了。只有主人看得到，而且这条结果走私聊 ——
    // 「谁开过共享」是别人的隐私，不该跟着发进群里
    const pushedList = []

    // 先把自己传上去：按下这条指令的**就是主人本人**，这个动作本身就是授权，
    // 不该因为他「没发过 #开启营地ID共享」而把自己漏在外头 ——
    // 主人踩过的就是这个坑：两台都同步了，对方还是说他没绑定
    const selfQQ = String(e.user_id || '')
    const selfIds = Array.isArray(store[selfQQ]?.ids) ? store[selfQQ].ids : []
    if (selfQQ && selfIds.length) {
      const own = await pushBind(selfQQ, selfIds, selfIds[store[selfQQ].current] || '')
      if (own.ok) {
        pushed += 1
        pushedList.push(selfQQ)
      } else {
        failed += 1
      }
    }

    for (const qq of users) {
      if (qq === selfQQ) continue // 自己上面已经传过

      const result = await reconcileNow(qq)
      if (result === 'shared') {
        pushed += 1
        pushedList.push(qq)
      } else if (result === 'not-shared') notShared += 1
      else failed += 1

      // 串行 + 小间隔，别把自己打出一串 429
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    logger.mark(`[${PluginName}] 共享库全量对账完成：同步 ${pushed}、未共享 ${notShared}、失败 ${failed}`)

    const lines = [
      '全量对账完成：',
      `· 同步上去：${pushed} 人`,
      `· 没开共享、跳过：${notShared} 人`
    ]
    if (failed) lines.push(`· 失败：${failed} 人（连不上或者额度用完，稍后再试）`)
    if (pushedList.length) lines.push('', `同步上去的是：${pushedList.join('、')}`)

    if (notShared) lines.push('', '没传的让他们自己发一次 #开启营地ID共享。')

    // 结果里有别人的 QQ，群里执行时走私聊
    return this.replySafely(e, lines.join('\n'))
  }

  /**
   * 直接问库：这个 QQ 在库里有没有记录、有哪些营地ID。
   *
   * 排查「两台都同步了、对面还是说我没绑定」的第一站 —— 先确认库里到底有没有，
   * 比来回猜「是不是缓存」「要不要重启」快得多。
   */
  async lookup (e) {
    if (!isShareReady()) {
      return e.reply('这台还没接入营地ID共享库。进群 972915804 找主人要地址和令牌', shouldQuote())
    }

    const qq = String(e.msg.match(/(\d{5,12})\s*$/)?.[1] || '')
    const result = await querySharedBind(qq)

    if (result.error) return e.reply(`查不了：${result.error}`, shouldQuote())

    if (!result.found) {
      return e.reply(`库里没有 ${qq}，让 TA 自己发一次 #开启营地ID共享`, shouldQuote())
    }

    return e.reply([
      `库里 ${qq} 的记录：`,
      `营地ID：${result.campIds.length ? result.campIds.join('、') : '（空）'}`,
      `当前号：${result.current || '—'}`
    ].join('\n'), shouldQuote())
  }
}
