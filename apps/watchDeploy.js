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
import { spawnSync } from 'node:child_process'
import { PluginPath, PluginName, Config } from '#components'
import { shouldQuote } from '#utils'
import { pm2, pm2Proc, resetPm2Cache, isOurProcess, pm2ForeignProc, launcherInfo } from '../utils/pm2.js'
import {
  installPackage, fetchPackageMeta, probeStatus, probeControlPort, waitControlPort, fmtUptime,
  normalizeBase, STATE_FILE
} from '../utils/deploy.js'
import { ensureDependencies } from '../utils/dependency.js'
import { probeRemoteStatus, probeControl, reportRemoteAccounts } from '../utils/remoteAccounts.js'

/** 云崽根目录（插件住在 `<根>/plugins/<名字>`，往上两级）—— 只为把路径显示得短一点 */
const YunzaiRoot = path.resolve(PluginPath, '../..')

/** 服务端代码解到这里（在插件目录里，被 .gitignore 挡着，不跟插件本体一起提交） */
const SERVER_DIR = path.join(PluginPath, 'server')
const ENTRY_FILE = path.join(SERVER_DIR, 'watch-server.js')

/** 分发服务上的包名（对应 `watch-server` 分支） */
const PKG_NAME = 'watch'

const PROC_NAME = 'gok-watch'
/** 配置里抠不到端口时的回退：服务地址指的是**控制面**（8898），公网播放面（8899）插件不直接用 */
const DEFAULT_PORT = 8898
/** 播放面端口（公网那个）。服务端默认 8899，可用 GOK_WATCH_PORT 覆盖 */
const PLAYBACK_PORT = 8899

/**
 * 起服务端时注入的环境变量。
 *
 * ⚠️ **控制面端口必须跟着配置一起注入**（2026-10-06 修）：
 *    插件按 `watchApiUrl` 里的端口去探健康检查（`serverPort()` → `waitControlPort`），
 *    而服务端的控制面端口来自 `GOK_WATCH_CTRL_PORT`（默认 8898）。原先这里只注入
 *    `GOK_WATCH_CDN_HTTPS`，于是主人**刻意把控制面开在别的端口**时
 *    （`healApiUrl` 的注释明确承认这是合法场景），配置与运行态就对不上：
 *    插件去探自定义端口 → 必然超时 → 部署报「进程起了但控制面接口没通」，
 *    而进程其实好端端在跑，报错文案还把用户指向错误方向。
 *
 * ⚠️ 排除播放面端口：配置万一还指着播放面（`watchApiUrl` = `…:8899`），
 *    注入它会让控制面**撞上播放面端口起不来** —— 那是引入新故障。
 *    这种配置交给 `healApiUrl()` 掰回 8898，这里保持服务端默认。
 */
function watchEnv () {
  const url = String(cfg().watchCdnHttps || '').trim().replace(/\/+$/, '')
  const env = { GOK_WATCH_CDN_HTTPS: url }

  const port = serverPort()
  if (port && port !== PLAYBACK_PORT) env.GOK_WATCH_CTRL_PORT = String(port)

  return env
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

/**
 * 服务端在哪个端口：从配置的服务地址里解析，解析不出来按默认。
 *
 * ⚠️⚠️ 必须走 URL 解析，**不能用 `/: (\d+)/` 抠**（2026-10-06 修）：那个正则取的是整串里
 *    第一个「冒号+数字」，而 IPv6 字面量本身就带冒号 —— `'http://[::1]:8898'` 会被抠成 **1**。
 *    而本文件的 `healApiUrl()` 明确把 `[::1]` 当作合法的本机回环地址（承认用户可以这么填）。
 *    一旦抠成 1，`watchEnv()` 就会把 `GOK_WATCH_CTRL_PORT=1` 注入给 pm2（非 root 绑特权端口
 *    直接起不来、root 则真的绑到 1），健康检查再去探配置里的 8898 必然超时，报出「进程起了但
 *    控制面接口没通」这种指向错误方向的假失败；重启路径上更会把一个本来正常的服务主动踢走。
 */
function serverPort () {
  const raw = String(cfg().watchApiUrl || '').trim()
  if (raw) {
    try {
      // 容错：用户可能只写了 `127.0.0.1:8898` 这种没协议的（normalizeBase 会补 http://）
      const port = Number(new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`).port)
      if (port >= 1 && port <= 65535) return port
    } catch {}
  }
  return DEFAULT_PORT
}

/**
 * ⭐ **把「指向播放面」的旧配置自动掰回控制面**。
 *
 * ⚠️⚠️ 为什么必须有（2026-10-05 修）：服务端这一天把控制面拆到了 `127.0.0.1:8898`，
 *    插件默认值也跟着改了。但**已经落盘的旧配置不会自己变** —— 老用户机器上
 *    `watchApiUrl` 还是 `http://127.0.0.1:8899`（那是播放面）。后果极其隐蔽：
 *      · `#营地观战服务` / `#营地观战部署` 的健康检查探的是 `/api/status`，
 *        而**那个接口在播放面上也通** → 面板显示「运行中」、部署报「成功」
 *      · 可真要用的 `/api/friends` `/api/start` 全是 **404** →「拿不到好友列表」
 *    自检全绿、功能全废，用户根本无从下手。
 *
 *    判据卡得很死，**宁可漏修也不能误改**（用户可能刻意把控制面开在别的端口）：
 *      ① 必须是**本机回环**地址（远程地址是用户有意填的，动它会把别人的服务顶掉）
 *      ② 当前地址必须**确实指挥不动**（`/api/rooms` 不通）
 *      ③ 而且它**确实是播放面**（`/api/status` 通、`/api/rooms` 不通）——
 *         只是「连不上」不算数：那是服务没起，等它起来就好，不该偷偷换端口
 *      ④ 同机默认控制面（8898）必须**真的能指挥**
 *    四条全中才改。这样「服务没起来 / 用户自定义端口 / 远程地址」都不会被误改。
 *
 * @returns {Promise<{migrated: boolean, from?: string, to?: string}>}
 */
async function healApiUrl () {
  const cur = normalizeBase(cfg().watchApiUrl || '')
  // 空配置交给默认值，不用管
  if (!cur) return { migrated: false }
  // ① 只修**本机回环**地址
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|::1)(:|\/|$)/i.test(cur)) return { migrated: false }
  const guess = `http://127.0.0.1:${DEFAULT_PORT}`
  if (cur === guess) return { migrated: false }

  // ② 当前地址真能指挥吗？能就不用改
  const probe = await probeControl(cur, { timeout: 3000 })
  if (probe.ok) return { migrated: false }
  // ③ 必须**明确是播放面**才动手：`/api/status` 通说明那端口上真有我们的服务，
  //    只是接口对不上（典型就是播放面）。连不上（kind 仍是 unknown 且非 404）
  //    说明只是服务没起 —— 那种情况换端口是瞎猜，等它起来就行。
  if (probe.kind !== 'playback') return { migrated: false }

  // ④ 同机默认控制面得真的能指挥
  const target = await probeControl(guess, { timeout: 3000 })
  if (!target.ok) return { migrated: false }

  Config.modify('config', 'watchApiUrl', guess)
  logger.mark(`[${PluginName}] 观战服务地址从 ${cur} 纠正为 ${guess}（原来指的是播放面，指挥不动）`)
  return { migrated: true, from: cur, to: guess }
}

/** 「对外地址没配」是部署后最常见的坑：本机能开、群友点了是空的 */
function publicUrlHintLines () {
  if (String(cfg().watchPublicUrl || '').trim()) return []
  return [
    '',
    '⚠️ 直播间对外地址还没配 —— 现在发出去的链接只有本机能开，群友点了是白屏。',
    '去锅巴面板把「直播间对外地址」填成外网能访问的（域名或公网 IP + 端口），',
    `⚠️ 对外地址指的是**播放面**端口（默认 ${PLAYBACK_PORT}），不是服务地址的控制面（${DEFAULT_PORT}）`
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
    const probe = await fetchPackageMeta({ name: PKG_NAME, url, token, logger })
    if (!probe.ok) {
      // ⚠️ 别再加「连不上分发服务：」前缀 —— probe.message 自己就带具体病因
      return e.reply(`${probe.message}\n还搞不定就${GROUP_HINT}`, shouldQuote())
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

    // ⚠️⚠️ 探的必须是**控制面**，不能用 probeRemoteStatus（2026-10-05 修）。
    //    那个探针打 `/api/status`，而它在**播放面上也通** —— 用户填了对方的播放面地址
    //    （外网唯一能填的那个），探测照样成功 → 报「✅ 已连接」并写进配置，
    //    可之后每次调用全是 404，等于把用户引进死局（实测复现）。
    //    probeControl 会去问控制面独有的 `/api/rooms`，探不通还会告诉他「你填的是播放面」。
    const probe = await probeControl(url)
    if (!probe.ok) {
      return e.reply(`${probe.message}\n地址核对一下再发一次`, shouldQuote())
    }

    Config.modify('config', 'watchApiUrl', url)
    // ⚠️ 「直播间对外地址」得跟着指到**播放面**，不是这个控制面地址 ——
    //    它才是拼给群友点的那个链接（见 watchBattle.js 的 publicBase）。
    //    控制面只绑对方本机回环，群友点过去必然连不上。
    //    只有当用户填的这个地址同时也能当播放面用时（例如对方把两个面开在同一入口、
    //    或他给的就是公网可访问的那个入口）才顺手写上；否则留空让他自己填，
    //    并在下面明确提示 —— 比无声写一个打不开的地址强。
    const playback = await probeRemoteStatus(url)
    if (playback.ok) Config.modify('config', 'watchPublicUrl', url)
    else Config.modify('config', 'watchPublicUrl', '')
    logger.mark(`[${PluginName}] 已连接远端观战控制面：${url}`)

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
    if (!playback.ok) {
      lines.push(
        '',
        '⚠️ 还差一步：上面填的是**控制面**地址（只管指挥），群友点链接要用**播放面**地址。',
        '去锅巴「王者荣耀 → 营地观战」把「直播间对外地址」填成对方外网能访问的那个，',
        `例如 http://<对方域名或公网IP>:${PLAYBACK_PORT}`
      )
    }
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
    // 直接起新的会撞端口（8899/8898 都被它占着、新进程起来就退出），所以先认出来、让主人切一下，
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

    // ⭐ 先纠正「指向播放面」的旧配置（老用户升级上来的那种），
    //    否则下面 serverPort() 会去探播放面、waitStatus 照样通过，部署报成功却指挥不动。
    const healed = await healApiUrl()

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
        // installed.message 已经是具体病因，别再套「如果地址令牌没问题」
        throw new Error(`${installed.message}\n还搞不定就${GROUP_HINT}`)
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

      // ⚠️ pm2 save 只管「daemon 记得起哪些进程」，**机器重启后要真起来**还得 systemd 里的
      //    pm2-<用户> 单元是 enabled —— 那是 `pm2 startup` 装的，两条是独立的东西。
      //    没装的话服务器一重启观战服务就静默没了，群里的现象是「观战服务没在跑」。
      //    只在 Linux 上查（Windows 没有 systemd；lpm2 那边也用不到这层）。
      if (process.platform !== 'win32') {
        try {
          const user = String(process.env.USER || process.env.LOGNAME || 'root')
          const r = spawnSync('systemctl', ['is-enabled', `pm2-${user}`], { encoding: 'utf-8', timeout: 10000 })
          const out = String(r.stdout || '').trim()
          if (out !== 'enabled') {
            logger.warn(`[${PluginName}] systemctl is-enabled pm2-${user} = ${out || r.stderr || '查不到'}，` +
              '服务器重启后观战服务不会自启 —— 请在服务器执行 pm2 startup，并按提示粘贴它给出的那条 sudo 命令')
          }
        } catch (error) {
          logger.debug(`[${PluginName}] 查 pm2 开机自启状态失败（不影响部署）：${error?.message || error}`)
        }
      }

      const port = serverPort()
      // ⚠️ 探的必须是**控制面独有**的接口：/api/status 两个面都有，拿它当健康检查
      //    会在「配置指向播放面」时假阳性通过（见 probeControlPort 的注释）
      const status = await waitControlPort(port)
      if (!status) {
        const logs = pm2(['logs', PROC_NAME, '--lines', '15', '--nostream'], { timeout: 20000 })
        logger.error(`[${PluginName}] 观战服务起了但控制面接口不通：${logs.out || logs.err}`)
        throw new Error('进程起了但控制面接口没通，日志在 pm2 里，先发 #营地观战服务 看看')
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
        `端口：控制面 127.0.0.1:${port}（公网播放面默认 8899,GOK_WATCH_PORT 可调）`,
        `账号：${status.accounts ?? 0} 个，还能开 ${status.free ?? 0} 路`
      ]

      if (!installed.updated && restarting) {
        lines.push('', '代码本来就是最新的，只重启了一遍。')
      }

      // ⚠️ 纠正过配置就得说出来：不然用户下次看到地址变了会以为是错的
      if (healed.migrated) {
        lines.push(
          '',
          `⚠️ 顺手把「观战服务地址」从 ${healed.from} 改成了 ${healed.to}`,
          '（原来那个填的是播放面端口，插件指挥不动它 —— 之前会表现为「拿不到好友列表」）'
        )
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
    // ⭐ 查状态先顺手纠一次配置：用户遇到「拿不到好友列表」时第一反应就是发这条，
    //    自愈要发生在**他看到「运行中」之前**，否则面板一切正常、他却什么都干不了。
    const healed = await healApiUrl()
    const proc = pm2Proc(PROC_NAME)
    const port = serverPort()
    const launcher = launcherInfo()
    const lines = ['🛰 营地观战服务']
    if (healed.migrated) {
      lines.push(
        `⚠️ 服务地址已从 ${healed.from} 纠正为 ${healed.to}（原来填的是播放面，指挥不动）`
      )
    }

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
    lines.push(`端口：控制面 127.0.0.1:${port}（公网播放面默认 8899）`)

    const restarts = Number(proc.pm2_env?.restart_time || 0)
    if (restarts > 0) lines.push(`重启次数：${restarts}${restarts > 5 ? '（有点多，看看 pm2 日志）' : ''}`)

    // ⚠️ 探控制面独有接口（/api/rooms），别用 /api/status —— 那个在播放面上也通，
    //    配置指错面时会假阳性通过，面板显示「运行中」可实际指挥不动（2026-10-05 修）
    const status = await probeControlPort(port)
    if (!status) {
      const byStatus = await probeStatus(port)
      lines.push(byStatus
        ? `状态接口：${port} 端口上有服务，但它**不接控制接口**（多半是播放面端口）—— 服务地址要填控制面（默认 ${DEFAULT_PORT}）`
        : '状态接口：没响应（进程在但连不上，日志在 pm2 里）')
      return e.reply(lines.join('\n'), shouldQuote())
    }

    lines.push(`ffmpeg：${status.ffmpeg ? '就绪' : '没找到（装好再发 #营地观战部署）'}`)
    lines.push(`账号：${status.accounts ?? 0} 个，还能开 ${status.free ?? 0} 路`)
    lines.push(`在播：${(status.rooms || []).length} 路${status.recording ? '（有在录）' : ''}`)

    lines.push(...publicUrlHintLines())

    return e.reply(lines.join('\n'), shouldQuote())
  }
}
