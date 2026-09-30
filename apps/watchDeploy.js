/**
 * 营地观战服务端的**一键部署**：#营地观战接入 / #营地观战部署 / #营地观战服务。
 *
 * ## 服务端代码从哪来
 *
 * **不在仓库里，也不在任何公开平台** —— 从**主人的分发服务**下载（凭 token）。
 * 分发服务跑在主人自己的服务器上，端口默认 6868，按 `watch-server` 分支的
 * commit sha 现打包成 tar.gz。下载完解压到 `<插件>/server/`，
 * `.gitignore` 把整个 `server/` 挡住，所以：
 *   · 客户端的插件更新（拉 master）永远碰不到服务端代码
 *   · 服务端也不用跟着插件的发版节奏走
 *
 * ## 两条硬规矩（跟 shareDeploy 同源）
 *
 * 1. **只动自己起的那个进程**：cwd 或入口脚本必须落在本插件的 server 目录下。
 *    光比进程名会把别人的同名进程停掉 —— 这条教训是从 meme 的卸载逻辑带过来的。
 * 2. **认不出就不动**：`server/` 存在、里面又没有 `watch-server.js`、也没有安装台账
 *    （认不出是我们的目录）→ 拒绝，让主人自己确认。
 *
 * ## 数据为什么不会被更新冲掉
 *
 * 观战的数据在 `<插件>/data/watch/`（录像、好友索引）和 `data/AuthPool.json`，
 * 代码在 `<插件>/server/` —— **两者不重叠**。加上解压时还有一道 exclude，
 * 怎么更新都碰不到数据。
 */
import fs from 'node:fs'
import path from 'node:path'
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
const SERVER_DIR = path.join(PluginPath, 'server')
const ENTRY_FILE = path.join(SERVER_DIR, 'watch-server.js')

/** 分发服务上的包名（对应 `watch-server` 分支） */
const PKG_NAME = 'watch'

const PROC_NAME = 'gok-watch'
const DEFAULT_PORT = 8899

function watchEnv () {
  const url = String(cfg().watchCdnHttps || '').trim().replace(/\/+$/, '')
  return { GOK_WATCH_CDN_HTTPS: url }
}

/**
 * 引导语：没配分发服务时统一用这句。
 *
 * ⚠️ 把**锅巴那条路也写上**：群里发指令要带地址和令牌，令牌是凭证、贴群里就泄了；
 * 而锅巴是网页表单，填进去更稳妥。两条路等价，写全了对方才知道可以不发指令。
 */
const GROUP_HINT =
  '进群 972915804 找主人要部署地址和令牌，然后发 #营地观战接入 <地址> <令牌>；' +
  '也可以在锅巴「王者荣耀 → 服务端接入」里填「分发服务地址」和「接入令牌」，一样能接入'

/**
 * 装完必须齐活的文件。少一个，服务端要么起不来、要么悄悄退化成简版页
 * （没有聊天室那种）。
 *
 * ⚠️ `utils/xxtea.js` 和 `utils/watchMode.js` **也在这张表里，但它们不由代码包提供** ——
 * 它们在插件本体（master）上，服务端运行时从 `../../utils/` 读。所以既要校验包解对了，
 * 也要校验插件本体的依赖在（用户只装了半个插件、或者更新把文件删了，这里会兜住）。
 */
const NEEDED = [
  'server/watch-server.js',
  'server/player.html',
  'server/player-pc.html',
  'server/lib/camp.js',
  'server/lib/ffmpeg.js',
  'server/lib/friendIndex.js',
  'utils/xxtea.js',
  'utils/watchMode.js'
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
  const m = String(cfg().watchApiUrl || '').match(/:(\d+)/)
  return m ? Number(m[1]) : DEFAULT_PORT
}

/** 「对外地址没配」是部署后最常见的坑：本机能开、群友点了是空的 */
function publicUrlHintLines () {
  if (String(cfg().watchPublicUrl || '').trim()) return []
  return [
    '',
    '⚠️ 直播间对外地址还没配 —— 现在发出去的链接只有本机能开，群友点了是白屏。',
    '去锅巴面板把「直播间对外地址」填成外网能访问的（域名或公网 IP + 端口），',
    `比如 http://你的域名:${serverPort()}`
  ]
}

/* ------------------------------------------------------------ 插件 */

export class WatchDeploy extends plugin {
  constructor () {
    super({
      name: '王者营地观战运维',
      dsc: '部署 / 查看营地观战服务端',
      event: 'message',
      // ⚠️ 必须是负的：apps/watchBattle.js 那条宽匹配是 `#(?:营地)?观战\s*(.*)$`，
      //    `#营地观战接入 …` 也会被它吃掉、掉进序号解析里报一句「编号不对」。
      //    云崽按 priority **从小到大**依次执行 fnc，这里抢在它前面 return true，
      //    它就不会再跑。（watchBattle 那边另有一道放行兜底，防 priority 语义变化。）
      priority: -1,
      rule: [
        // 一步到位：写配置 + 立刻部署。主人和群友用的是同一条
        // （群友装了这个插件之后，在他自己那台机器人上就是主人）
        { reg: '^#营地观战接入\\s+(\\S+)\\s+(\\S+)$', fnc: 'connect', permission: 'master' },
        // ⭐ 连**别人已经部署好的**观战服务：只填地址，本机不下载、不部署。
        //    ⚠️ 和上面那条是两条完全不同的路，别混：
        //      · 接入 = 在自己机器上装一套（地址是**分发服务**）
        //      · 连接 = 用别人跑着的那一套（地址是**观战服务**本身）
        { reg: '^#营地观战连接\\s+(\\S+)$', fnc: 'connectRemote', permission: 'master' },
        { reg: '^#营地观战部署$', fnc: 'deploy', permission: 'master' },
        { reg: '^#营地观战服务$', fnc: 'status', permission: 'master' }
      ]
    })
  }

  /* -------------------------------------------------------- 接入 */

  /**
   * 一步接入：`#营地观战接入 <地址> <令牌>`。
   *
   * **先试连再落盘** —— 地址或令牌写错了要当场知道，而不是等发部署指令时才报错
   * （这条经验是从 shareBind 的 masterEnable 带过来的）。
   */
  async connect (e) {
    const m = /^#营地观战接入\s+(\S+)\s+(\S+)$/.exec(String(e.msg || '').trim())
    if (!m) return e.reply('格式：#营地观战接入 <地址> <令牌>', shouldQuote())

    const url = normalizeBase(m[1])
    const token = m[2].trim()

    if (!/^https?:\/\//i.test(url)) {
      return e.reply('地址要以 http:// 或 https:// 开头', shouldQuote())
    }
    if (token.length < 20) {
      return e.reply('令牌看着不对（太短了）。' + GROUP_HINT, shouldQuote())
    }

    // 试连：问一次版本。失败就不写配置
    const probe = await fetchPackageMeta({ name: PKG_NAME, url, token })
    if (!probe.ok) {
      return e.reply(
        `连不上分发服务：${probe.message}\n` +
        '地址和令牌都没错的话，' + GROUP_HINT,
        shouldQuote()
      )
    }

    Config.modify('config', 'distUrl', url)
    Config.modify('config', 'distToken', token)
    logger.mark(`[${PluginName}] 已接入分发服务：${url}`)

    // 落盘成功 → 直接接着部署，群友不用再发一条
    return this.deploy(e, { adopted: true })
  }

  /* -------------------------------------------------------- 连远端 */

  /**
   * `#营地观战连接 <地址>` —— 用**别人已经部署好的**观战服务。
   *
   * 和「接入」是两条完全不同的路：
   *   · `#营地观战接入 <分发地址> <令牌>` = 从分发服务下代码，在**本机**装一套
   *   · `#营地观战连接 <观战地址>` = 直接用别人跑着的那一套，本机什么都不装
   *
   * ⚠️ 连远端之后本机**不需要** pm2 / ffmpeg / 开端口，也不会有任何本机进程：
   *    取流、轮询、转码全在对方那台机器上跑（代价是画面要经对方中转，且对方能看到
   *    你的营地账号 —— 只连信得过的部署方）。
   *
   * ⚠️ 对方的服务端必须能**收下你的账号**：观战取流认的是「加了这个好友的那个号」，
   *    而登录态只在**你这台机器**上（对方的 AuthPool.json 里没有）。
   *    所以这里会把你的全局账号递过去（只进对方内存、**不在对方落盘**）。
   *    对方要是老版本、没这个口子，这里会明确提示要更新。
   */
  async connectRemote (e) {
    const m = /^#营地观战连接\s+(\S+)$/.exec(String(e.msg || '').trim())
    if (!m) return e.reply('格式：#营地观战连接 <地址>', shouldQuote())

    const url = normalizeBase(m[1])

    if (!/^https?:\/\//i.test(url)) {
      return e.reply('地址要以 http:// 或 https:// 开头', shouldQuote())
    }

    // 先试连再落盘 —— 地址写错了要当场知道
    const probe = await probeRemoteStatus(url)
    if (!probe.ok) {
      return e.reply(`${probe.message}\n地址核对一下再发一次`, shouldQuote())
    }

    Config.modify('config', 'watchApiUrl', url)
    // ⚠️ 「直播间对外地址」也得跟着指过去 —— 它才是拼给群友点的那个链接
    //    （见 watchBattle.js 的 publicBase，空时回退到服务地址）。
    //    不一起改的话，链接还指着本机/上一个服务：本机根本没在播对方那台机器上的那一场，
    //    群友点开就是白屏。这是「切了服务端但链接没跟过去」最容易踩的一个坑。
    Config.modify('config', 'watchPublicUrl', url)
    logger.mark(`[${PluginName}] 已连接远端观战服务：${url}`)

    // 把自己的账号递过去：对方池子里还没有它们，不递就是「登录成功却查不到好友」
    const report = await reportRemoteAccounts(url, { force: true })

    const lines = ['✅ 已连接这个观战服务', '', `对方池子里的账号：${probe.accounts} 个`]
    if (!report.ok) {
      lines.push(
        '',
        '⚠️ 你的登录态没送过去 —— 对方的服务端可能还没更新。',
        '让那台机器的主人发一次 #营地观战部署 更新后，再发一遍本条指令'
      )
    }
    lines.push(
      '',
      '⚠️ 直播间链接也跟着指到这个地址了。群友点不开的话，让对方给一个外网能访问的地址，',
      '填进锅巴「王者荣耀 → 营地观战」里的「直播间对外地址」'
    )
    lines.push('', '看谁在打：发 #营地观战')
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

    await e.reply('正在检查部署依赖（pm2 / ffmpeg），缺少时会自动安装…', shouldQuote())
    const dependency = await ensureDependencies({ needFfmpeg: true, cfg: cfg(), logger })
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
        `有个叫 ${PROC_NAME} 的 pm2 进程，但跑的不是本插件的观战服务，没有动它。`,
        `（它的目录是 ${running.pm2_env?.pm_cwd || '未知'}）`
      ].join('\n'), shouldQuote())
    }

    // 老版本部署的进程可能还挂在**机器原本的 pm2** 上（本插件现在跑自己的，见 utils/pm2.js）。
    // 直接起新的会撞端口（8899 被它占着、新进程起来就退出），所以先认出来、让主人切一下，
    // 不静默去停它 —— 它这会儿可能正在给人看观战。
    const outside = pm2ForeignProc(PROC_NAME)
    if (!running && outside && isOurProcess(outside, SERVER_DIR)) {
      return e.reply([
        '先停掉旧的那个观战进程（它还挂在系统 pm2 上）：',
        '',
        `在机器人所在设备执行：pm2 delete ${PROC_NAME}`,
        '执行完再发一次 #营地观战部署'
      ].join('\n'), shouldQuote())
    }

    // 认不出是我们的目录 → 拒绝动它（见文件头第 2 条规矩）
    const hasState = fs.existsSync(path.join(SERVER_DIR, STATE_FILE))
    if (fs.existsSync(SERVER_DIR) && !fs.existsSync(ENTRY_FILE) && !hasState) {
      return e.reply([
        `${path.relative(YunzaiRoot, SERVER_DIR)} 已经存在，但里面没有 watch-server.js —— `,
        '看不出是本插件的目录，不敢动它。确认没用了就手动删掉再部署'
      ].join(''), shouldQuote())
    }

    const restarting = Boolean(running)
    await e.reply(
      restarting
        ? '正在更新观战服务…'
        : '正在部署观战服务（要从分发服务下载代码），几十秒就好…',
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
        entry: 'watch-server.js',
        logger
      })
      if (!installed.ok) {
        throw new Error(`${installed.message}\n如果地址令牌没问题，${GROUP_HINT}`)
      }

      // 解完再校验一遍：文件不齐就别硬起，免得半死不活
      const missing = NEEDED.filter(f => !fs.existsSync(path.join(PluginPath, f)))
      if (missing.length) {
        throw new Error(`服务端文件不齐，缺：${missing.join('、')}`)
      }

      // 已经在跑 = 大概率是更新完代码要重启才生效，所以这里是 restart 而不是拒绝
      const startup = restarting
        ? pm2(['restart', PROC_NAME, '--update-env'], { timeout: 60000, env: { ...watchEnv(), GOK_FFMPEG: dependency.ffmpeg } })
        : pm2([
            'start', ENTRY_FILE,
            '--name', PROC_NAME,
            '--interpreter', 'node',
            '--cwd', SERVER_DIR
          ], { timeout: 60000, env: { ...watchEnv(), GOK_FFMPEG: dependency.ffmpeg } })

      if (!startup.ok) {
        throw new Error(`pm2 ${restarting ? '重启' : '启动'}失败：${startup.err || startup.out || '未知原因'}`)
      }

      // ⚠️ 不 save 的话，pm2 自己重启（或机器重启）时这个服务不会跟着起来。
      //    失败只记日志、不当成部署失败 —— 服务这会儿已经跑起来了，别因为这一步回滚整套。
      const saved = pm2(['save'], { timeout: 30000 })
      if (!saved.ok) logger.warn(`[${PluginName}] pm2 save 失败，开机自启可能没生效：${saved.err || saved.out}`)

      const port = serverPort()
      const status = await waitStatus(port)
      if (!status) {
        const logs = pm2(['logs', PROC_NAME, '--lines', '15', '--nostream'], { timeout: 20000 })
        logger.error(`[${PluginName}] 观战服务起了但状态接口不通：${logs.out || logs.err}`)
        throw new Error('进程起了但状态接口没通，日志在 pm2 里，先发 #营地观战服务 看看')
      }

      resetPm2Cache()
      logger.mark(
        `[${PluginName}] 观战服务已${restarting ? '重启' : '部署'}：127.0.0.1:${port}` +
        `（${SERVER_DIR}，版本 ${String(installed.sha).slice(0, 8)}${installed.updated ? '' : '，已是最新'}）`
      )

      const lines = [
        `✅ 观战服务${restarting ? '已更新' : '部署好了'}`,
        '',
        `进程：${PROC_NAME}（pm2 托管，开机自启）`,
        `端口：${port}`,
        `账号：${status.accounts ?? 0} 个，还能开 ${status.free ?? 0} 路`
      ]

      if (!installed.updated && restarting) {
        lines.push('', '代码本来就是最新的，只重启了一遍。')
      }

      if (!status.ffmpeg) {
        lines.push('', '⚠️ 这台机器上没找到 ffmpeg，取流会失败。装好之后发一次 #营地观战部署')
      }

      lines.push(...publicUrlHintLines())
      lines.push('', '看谁在打：发 #营地观战')

      return e.reply(lines.join('\n'), shouldQuote())
    } catch (error) {
      logger.error(`[${PluginName}] 部署观战服务失败：${error?.stack || error}`)
      return e.reply(`❌ 部署失败：${error?.message || error}`, shouldQuote())
    }
  }

  /* -------------------------------------------------------- 状态 */

  async status (e) {
    const proc = pm2Proc(PROC_NAME)
    const port = serverPort()
    const launcher = launcherInfo()
    const lines = ['🛰 营地观战服务']

    if (!proc) {
      // 本插件管的进程里没有，但旧进程可能还在系统 pm2 上跑着 —— 说清楚怎么切
      const outside = pm2ForeignProc(PROC_NAME)
      if (outside && isOurProcess(outside, SERVER_DIR)) {
        return e.reply([
          '🛰 营地观战服务',
          '进程：没在跑（本插件管的进程里没有）',
          '',
          `旧进程还挂在系统 pm2 上，先执行：pm2 delete ${PROC_NAME}`,
          '再发一次 #营地观战部署'
        ].join('\n'), shouldQuote())
      }
      lines.push('进程：没在跑', '', `发 #营地观战部署 装一个（${GROUP_HINT}）`)
      return e.reply(lines.join('\n'), shouldQuote())
    }

    if (!isOurProcess(proc, SERVER_DIR)) {
      lines.push('进程：有个同名的，但不是本插件起的，没有动它')
      lines.push(`（它的目录是 ${proc.pm2_env?.pm_cwd || '未知'}）`)
      return e.reply(lines.join('\n'), shouldQuote())
    }

    const state = proc.pm2_env?.status || 'unknown'
    const uptime = state === 'online' ? Date.now() - Number(proc.pm2_env?.pm_uptime || 0) : 0
    lines.push(`进程：${state === 'online' ? '运行中' : state}${uptime ? `（已跑 ${fmtUptime(uptime)}）` : ''}`)
    lines.push(`进程管理：${launcher.kind === 'lpm2' ? 'lpm2（独立运行，不占系统 pm2）' : '系统 pm2'}`)
    lines.push(`端口：${port}`)

    const restarts = Number(proc.pm2_env?.restart_time || 0)
    if (restarts > 0) lines.push(`重启次数：${restarts}${restarts > 5 ? '（有点多，看看 pm2 日志）' : ''}`)

    const status = await probeStatus(port)
    if (!status) {
      lines.push('状态接口：没响应（进程在但连不上，日志在 pm2 里）')
      return e.reply(lines.join('\n'), shouldQuote())
    }

    lines.push(`ffmpeg：${status.ffmpeg ? '就绪' : '没找到（装好再发 #营地观战部署）'}`)
    lines.push(`账号：${status.accounts ?? 0} 个，还能开 ${status.free ?? 0} 路`)
    lines.push(`在播：${(status.rooms || []).length} 路${status.recording ? '（有在录）' : ''}`)

    lines.push(...publicUrlHintLines())

    return e.reply(lines.join('\n'), shouldQuote())
  }
}
