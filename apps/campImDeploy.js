/**
 * 营地消息服务端的**一键部署**：#营地消息部署 / #营地消息服务。
 *
 * ## 服务端代码从哪来
 *
 * **不在 master 上** —— 单独住在仓库的 **`im-server` 分支**里。部署时把那个分支
 * 浅克隆到 `<插件>/server-im/`，`.gitignore` 把整个 `server-im/` 挡住，所以：
 *   · 客户端的插件更新（拉 master）永远碰不到服务端代码
 *   · 服务端也不用跟着插件的发版节奏走
 *
 * ⚠️ 分支名是 `im-server`。**别和另外两个搞混**：
 *   · `watch-server` → 营地观战服务（apps/watchDeploy.js，落在 `server/`）
 *   · `server`       → 营地ID共享库（apps/shareDeploy.js）
 *
 * ## 为什么部署在插件目录里
 *
 * 服务端要读 `data/AuthPool.json`。留在 `server-im/` 下，`HERE/..` 这个相对路径
 * 天然成立 —— 一行路径代码都不用改。它也自带一份零依赖的 `lib/xxtea.js`，
 * 不依赖插件本体的 utils（服务端是独立进程，import 不了那边的云崽运行时依赖）。
 *
 * ## 两条硬规矩（跟 watchDeploy / shareDeploy 同源）
 *
 * 1. **只动自己起的那个进程**：cwd 或入口脚本必须落在本插件的 server-im 目录下。
 *    光比进程名会把别人的同名进程停掉 —— 这条教训是从 meme 的卸载逻辑带过来的。
 * 2. **认不出就不动**：`server-im/` 存在、没 `.git`、里面又没有 `camp-im-server.js`
 *    （认不出是我们的目录）→ 拒绝，让主人自己确认。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { PluginPath, PluginName, Config } from '#components'
import { shouldQuote } from '#utils'
import { pm2, pm2Proc, resetPm2Cache, isOurProcess, pm2ForeignProc, launcherInfo } from '../utils/pm2.js'
import {
  installPackage, fetchPackageMeta, probeStatus, waitStatus, fmtUptime,
  normalizeBase, STATE_FILE
} from '../utils/deploy.js'
import { ensureDependencies } from '../utils/dependency.js'
import { probeRemoteStatus, reportRemoteAccounts } from '../utils/remoteAccounts.js'

/** 云崽根目录（插件住在 `<根>/plugins/<名字>`，往上两级）—— 只为把路径显示得短一点 */
const YunzaiRoot = path.resolve(PluginPath, '../..')

/** 服务端代码解到这里（在插件目录里，被 .gitignore 挡着，不跟插件本体一起提交） */
const SERVER_DIR = path.join(PluginPath, 'server-im')
const ENTRY_FILE = path.join(SERVER_DIR, 'camp-im-server.js')

/** 分发服务上的包名（对应 `im-server` 分支） */
const PKG_NAME = 'im'

const PROC_NAME = 'gok-im'
const DEFAULT_PORT = 8900

/**
 * 引导语：没配分发服务时统一用这句。
 *
 * ⚠️ 把**锅巴那条路也写上**：群里发指令要带地址和令牌，令牌是凭证、贴群里就泄了；
 * 而锅巴是网页表单，填进去更稳妥。两条路等价，写全了对方才知道可以不发指令。
 */
const GROUP_HINT =
  '进群 972915804 找主人要部署地址和令牌，然后发 #营地消息接入 <地址> <令牌>；' +
  '也可以在锅巴「王者荣耀 → 服务端接入」里填「分发服务地址」和「接入令牌」，一样能接入'

/**
 * 解下来之后必须齐活的文件。少一个服务端起不来。
 *
 * ⚠️ `lib/xxtea.js` 由**代码包**提供（服务端自带一份零依赖的），
 *    和观战那边从插件本体读 `utils/xxtea.js` 的做法不同 ——
 *    因为 IM 服务端完全不需要云崽运行时。
 */
const NEEDED = [
  'server-im/camp-im-server.js',
  'server-im/lib/xxtea.js'
]

/* ------------------------------------------------------------ 小工具 */

function cfg () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/** 分发服务的地址 + 令牌（观战和营地消息共用同一套） */
function distConfig () {
  const c = cfg()
  return {
    url: normalizeBase(c.distUrl),
    token: String(c.distToken || '').trim()
  }
}

/** 服务端在哪个端口：从配置的服务地址里抠，抠不到按默认 */
function serverPort () {
  const m = String(cfg().campImApiUrl || '').match(/:(\d+)/)
  return m ? Number(m[1]) : DEFAULT_PORT
}

/**
 * 「pm2 save 了、机器一重启服务却没起来」的兜底检查。
 *
 * `pm2 save` 只是把进程写进 dump，机器重启时要靠 systemd 里的 `pm2-<user>` 服务
 * 去 resurrect —— 那个服务是 `pm2 startup` 打出来的命令装的，没装的话 save 也白搭。
 * 这里不能替主人跑（要 sudo、提示语还随发行版变），查出来没 enabled 就打 warning 指条路。
 * Windows（lpm2）没有 systemd 这一层，直接跳过。
 */
function warnIfStartupDisabled (procName) {
  if (process.platform === 'win32') return
  try {
    const user = os.userInfo().username || 'root'
    const r = spawnSync('systemctl', ['is-enabled', `pm2-${user}`], { encoding: 'utf-8', timeout: 10000 })
    const state = String(r.stdout || '').trim()
    if (state && state !== 'enabled') {
      logger.warn(
        `[${PluginName}] pm2-${user} 服务状态是 ${state}，机器重启后 ${procName} 不会自己起来。` +
        '在机器人所在设备执行一次：pm2 startup（按提示再跑它打出来的那条 sudo 命令）'
      )
    }
  } catch {}
}

/* ------------------------------------------------------------ 插件 */

export class CampImDeploy extends plugin {
  constructor () {
    super({
      name: '王者营地消息运维',
      dsc: '部署 / 查看营地消息服务端',
      event: 'message',
      // ⚠️ 必须是负的：`#营地消息` 那条规则是精确匹配 `^#营地消息$`，
      //    `#营地消息部署` 不会被它吃掉，但保险起见和 watchDeploy 保持一致。
      priority: -1,
      rule: [
        // 一步到位：写配置 + 立刻部署。主人和群友用的是同一条
        // （群友装了这个插件之后，在他自己那台机器人上就是主人）
        { reg: '^#营地消息接入\\s+(\\S+)\\s+(\\S+)$', fnc: 'connect', permission: 'master' },
        // ⭐ 连**别人已经部署好的**营地消息服务：只填地址，本机不下载、不部署。
        //    ⚠️ 和上面那条是两条完全不同的路：接入的地址是**分发服务**，
        //    连接的地址是**营地消息服务**本身。
        { reg: '^#营地消息连接\\s+(\\S+)$', fnc: 'connectRemote', permission: 'master' },
        { reg: '^#营地消息部署$', fnc: 'deploy', permission: 'master' },
        { reg: '^#营地消息服务$', fnc: 'status', permission: 'master' }
      ]
    })
  }

  /* -------------------------------------------------------- 接入 */

  /**
   * 一步接入：`#营地消息接入 <地址> <令牌>`。
   *
   * **先试连再落盘** —— 地址或令牌写错了要当场知道，而不是等发部署指令时才报错。
   */
  async connect (e) {
    const m = /^#营地消息接入\s+(\S+)\s+(\S+)$/.exec(String(e.msg || '').trim())
    if (!m) return e.reply('格式：#营地消息接入 <地址> <令牌>', shouldQuote())

    const url = normalizeBase(m[1])
    const token = m[2].trim()

    if (!/^https?:\/\//i.test(url)) {
      return e.reply('地址要以 http:// 或 https:// 开头', shouldQuote())
    }
    if (token.length < 20) {
      return e.reply('令牌看着不对（太短了）。' + GROUP_HINT, shouldQuote())
    }

    const probe = await fetchPackageMeta({ name: PKG_NAME, url, token, logger })
    if (!probe.ok) {
      // ⚠️ 别再加「连不上分发服务：」这个前缀 —— probe.message 现在自己就带
      //    具体病因（解析不出地址 / 端口没放行 / 令牌无效…），套上前缀反而说不通。
      //    尾巴的 GROUP_HINT 也只在「用户没法自己解决」时才有意义，所以直接跟一句
      //    「还不行就」再给群号，而不是重复「地址和令牌都没错的话」。
      return e.reply(`${probe.message}\n还搞不定就${GROUP_HINT}`, shouldQuote())
    }

    Config.modify('config', 'distUrl', url)
    Config.modify('config', 'distToken', token)
    logger.mark(`[${PluginName}] 已接入分发服务：${url}`)

    return this.deploy(e, { adopted: true })
  }

  /* -------------------------------------------------------- 连远端 */

  /**
   * `#营地消息连接 <地址>` —— 用**别人已经部署好的**营地消息服务。
   *
   * 和「接入」是两条完全不同的路：
   *   · `#营地消息接入 <分发地址> <令牌>` = 从分发服务下代码，在**本机**装一套
   *   · `#营地消息连接 <消息地址>` = 直接用别人跑着的那一套，本机什么都不装
   *
   * ⚠️ 连远端之后本机**不需要** pm2，也不会有任何本机进程：每个号的 ws 长连接都由
   *    对方那台机器挂着（代价是对方能看到你的营地账号凭证 —— 只连信得过的部署方）。
   *
   * ⚠️ 对方的服务端必须能**收下你的账号**：登录态（userSig / userKey）只在**你这台机器**上
   *    （对方的 AuthPool.json 里没有）。所以这里会把你的全局账号递过去
   *    （只进对方内存、**不在对方落盘**）。对方要是老版本，这里会明确提示要更新。
   */
  async connectRemote (e) {
    const m = /^#营地消息连接\s+(\S+)$/.exec(String(e.msg || '').trim())
    if (!m) return e.reply('格式：#营地消息连接 <地址>', shouldQuote())

    const url = normalizeBase(m[1])

    if (!/^https?:\/\//i.test(url)) {
      return e.reply('地址要以 http:// 或 https:// 开头', shouldQuote())
    }

    // 先试连再落盘 —— 地址写错了要当场知道
    const probe = await probeRemoteStatus(url)
    if (!probe.ok) {
      return e.reply(`${probe.message}\n地址核对一下再发一次`, shouldQuote())
    }

    Config.modify('config', 'campImApiUrl', url)
    logger.mark(`[${PluginName}] 已连接远端营地消息服务：${url}`)

    // 把自己的账号递过去：对方池子里还没有它们，不递就是「登录成功却收不到消息」
    const report = await reportRemoteAccounts(url, { force: true })

    const lines = ['✅ 已连接这个营地消息服务', '', `对方池子里的账号：${probe.accounts} 个`]
    if (!report.ok) {
      lines.push(
        '',
        '⚠️ 你的登录态没送过去 —— 对方的服务端可能还没更新。',
        '让那台机器的主人发一次 #营地消息部署 更新后，再发一遍本条指令'
      )
    }
    lines.push('', '开始收消息：发 #营地消息开')
    return e.reply(lines.join('\n'), shouldQuote())
  }

  /* -------------------------------------------------------- 部署 */

  async deploy (e, { adopted = false } = {}) {
    const { url, token } = distConfig()
    if (!url || !token) {
      return e.reply(
        adopted
          ? '配置没写进去，重发一次试试'
          : `还没接入分发服务。${GROUP_HINT}`,
        shouldQuote()
      )
    }

    await e.reply('正在检查部署依赖（pm2），缺少时会自动安装…', shouldQuote())
    const dependency = await ensureDependencies({ cfg: cfg(), logger })
    if (!dependency.ok) {
      return e.reply(
        `依赖环境没准备好：${dependency.messages.join('；')}\n` +
        '也可以在锅巴「王者荣耀 → 服务端接入」里配置依赖镜像/代理后重试',
        shouldQuote()
      )
    }

    // 同名进程但不是我们起的 —— 别去碰它，只说清楚（见文件头第 1 条规矩）
    const running = pm2Proc(PROC_NAME)
    if (running && !isOurProcess(running, SERVER_DIR)) {
      return e.reply([
        `有个叫 ${PROC_NAME} 的 pm2 进程，但跑的不是本插件的营地消息服务，没有动它。`,
        `（它的目录是 ${running.pm2_env?.pm_cwd || '未知'}）`
      ].join('\n'), shouldQuote())
    }

    // 老版本部署的进程可能还挂在**机器原本的 pm2** 上（本插件现在跑自己的，见 utils/pm2.js）。
    // 直接起新的会撞端口，所以先认出来、让主人切一下，不静默去停它。
    const outside = pm2ForeignProc(PROC_NAME)
    if (!running && outside && isOurProcess(outside, SERVER_DIR)) {
      return e.reply([
        '先停掉旧的那个营地消息进程（它还挂在系统 pm2 上）：',
        '',
        `在机器人所在设备执行：pm2 delete ${PROC_NAME}`,
        '执行完再发一次 #营地消息部署'
      ].join('\n'), shouldQuote())
    }

    // 认不出是我们的目录 → 拒绝动它（见文件头第 2 条规矩）
    const hasState = fs.existsSync(path.join(SERVER_DIR, STATE_FILE))
    if (fs.existsSync(SERVER_DIR) && !fs.existsSync(ENTRY_FILE) && !hasState) {
      return e.reply(
        `${path.relative(YunzaiRoot, SERVER_DIR)} 已经存在，但里面没有 camp-im-server.js —— ` +
        '看不出是本插件的目录，不敢动它。确认没用了就手动删掉再部署',
        shouldQuote()
      )
    }

    const restarting = Boolean(running)
    await e.reply(
      restarting
        ? '正在更新营地消息服务…'
        : '正在部署营地消息服务（要从分发服务下载代码），几十秒就好…',
      shouldQuote()
    )

    try {
      // 老布局遗留：以前是 git 浅克隆，现在不用 git 了，把 .git 清掉免得困惑
      const oldGit = path.join(SERVER_DIR, '.git')
      if (fs.existsSync(oldGit)) {
        try {
          fs.rmSync(oldGit, { recursive: true, force: true })
          logger.mark(`[${PluginName}] 清掉旧的 .git（服务端代码现在从分发服务下载）`)
        } catch (error) {
          logger.warn(`[${PluginName}] 清旧 .git 失败（不影响部署）：${error?.message || error}`)
        }
      }

      const installed = await installPackage({
        name: PKG_NAME,
        url,
        token,
        destDir: SERVER_DIR,
        entry: 'camp-im-server.js',
        logger
      })
      if (!installed.ok) {
        // installed.message 已经是具体病因（含 HTTP 状态 / 网络错误码翻译），
        // 别再套「如果地址令牌没问题」—— 那句话对 401/404 这种明确错误是误导
        throw new Error(`${installed.message}\n还搞不定就${GROUP_HINT}`)
      }

      const missing = NEEDED.filter(f => !fs.existsSync(path.join(PluginPath, f)))
      if (missing.length) {
        throw new Error(`服务端文件不齐，缺：${missing.join('、')}`)
      }

      // 先校验目录并解包，再安装服务端依赖，避免新建目录被误认为外来目录。
      const nodeDependencies = await ensureDependencies({ needWs: true, nodeDir: SERVER_DIR, cfg: cfg(), logger })
      if (!nodeDependencies.ok) throw new Error(nodeDependencies.messages.join('；'))

      const startup = restarting
        ? pm2(['restart', PROC_NAME, '--update-env'], { timeout: 60000 })
        : pm2([
            'start', ENTRY_FILE,
            '--name', PROC_NAME,
            '--interpreter', 'node',
            '--cwd', SERVER_DIR
          ], { timeout: 60000 })

      if (!startup.ok) {
        throw new Error(`pm2 ${restarting ? '重启' : '启动'}失败：${startup.err || startup.out || '未知原因'}`)
      }

      const saved = pm2(['save'], { timeout: 30000 })
      if (!saved.ok) logger.warn(`[${PluginName}] pm2 save 失败，开机自启可能没生效：${saved.err || saved.out}`)
      // save 只写 dump，机器重启还得靠 pm2-<user> 的 systemd 服务 resurrect —— 没装就提醒
      warnIfStartupDisabled(PROC_NAME)

      const port = serverPort()
      const status = await waitStatus(port)
      if (!status) {
        const logs = pm2(['logs', PROC_NAME, '--lines', '15', '--nostream'], { timeout: 20000 })
        logger.error(`[${PluginName}] 营地消息服务起了但状态接口不通：${logs.out || logs.err}`)
        throw new Error('进程起了但状态接口没通，日志在 pm2 里，先发 #营地消息服务 看看')
      }

      resetPm2Cache()
      logger.mark(
        `[${PluginName}] 营地消息服务已${restarting ? '重启' : '部署'}：127.0.0.1:${port}` +
        `（${SERVER_DIR}，版本 ${String(installed.sha).slice(0, 8)}${installed.updated ? '' : '，已是最新'}）`
      )

      const online = (status.clients || []).filter(c => c.state === 'online').length
      const total = (status.clients || []).length
      const lines = [
        `✅ 营地消息服务${restarting ? '已更新' : '部署好了'}`,
        '',
        `进程：${PROC_NAME}（pm2 托管，开机自启）`,
        `端口：${port}`,
        `账号：${online}/${total} 在线`
      ]

      if (!total) {
        lines.push('', '还没有可用的营地账号\n发 #营地wx全局登录 扫码添加')
      }

      if (!installed.updated && restarting) {
        lines.push('', '代码本来就是最新的，只重启了一遍。')
      }

      lines.push('', '看状态：发 #营地消息')

      return e.reply(lines.join('\n'), shouldQuote())
    } catch (error) {
      logger.error(`[${PluginName}] 部署营地消息服务失败：${error?.stack || error}`)
      return e.reply(`❌ 部署失败：${error?.message || error}`, shouldQuote())
    }
  }

  /* -------------------------------------------------------- 状态 */

  async status (e) {
    const proc = pm2Proc(PROC_NAME)
    const port = serverPort()
    const launcher = launcherInfo()
    const lines = ['📨 营地消息服务']

    if (!proc) {
      // 本插件管的进程里没有，但旧进程可能还在系统 pm2 上跑着 —— 说清楚怎么切
      const outside = pm2ForeignProc(PROC_NAME)
      if (outside && isOurProcess(outside, SERVER_DIR)) {
        return e.reply([
          '📨 营地消息服务',
          '没在跑（本插件管的进程里没有）',
          '',
          `旧进程还挂在系统 pm2 上，先执行：pm2 delete ${PROC_NAME}`,
          '再发一次 #营地消息部署'
        ], shouldQuote())
      }
      lines.push('', '没在跑', `发 #营地消息部署 装一个（${GROUP_HINT}）`)
      return e.reply(lines, shouldQuote())
    }
    if (!isOurProcess(proc, SERVER_DIR)) {
      lines.push('', `有个叫 ${PROC_NAME} 的进程，但不是本插件起的，没有动它`)
      return e.reply(lines, shouldQuote())
    }

    lines.push('', `进程：${proc.pm2_env?.status || '未知'}`)
    lines.push(`进程管理：${launcher.kind === 'lpm2' ? 'lpm2（独立运行，不占系统 pm2）' : '系统 pm2'}`)
    lines.push(`已跑：${fmtUptime(Date.now() - (proc.pm2_env?.pm_uptime || 0))}`)
    const restarts = proc.pm2_env?.restart_time
    if (restarts) lines.push(`重启次数：${restarts}`)
    lines.push(`端口：${port}`)

    const status = await probeStatus(port)
    if (!status) {
      lines.push('', '⚠️ 状态接口不通，先看看 pm2 日志')
    } else {
      const clients = status.clients || []
      const online = clients.filter(c => c.state === 'online').length
      lines.push(`账号：${online}/${clients.length} 在线`)
      // ⚠️ 待处理条数用 `queue.length`，**不是** `queue.lastId`。
      //    lastId 是服务端的消息序号（从毫秒时间戳起步、每条 ++），跟条数不是一个量纲：
      //    实测队列空着时 lastId 是 1791220064781，照它显示就是「有 1.7 万亿条待处理」。
      //    apps/campIm.js 的面板早就改用 queue.length 了（那里注释记过这个坑），
      //    这条是同一处逻辑的另一份拷贝，漏改了 —— 两处必须保持一致。
      const pending = Number(status.queue?.length || 0)
      if (pending > 0) lines.push(`待处理：${pending} 条`)
    }

    return e.reply(lines, shouldQuote())
  }
}
