import lodash from 'lodash'
import { Config, PluginPath, PluginName } from '#components'
import authStore from './utils/authStore.js'
// ⚠️ 用具名导入，**不要用 `import * as`** —— 锅巴重新扫描时用带 query 的动态 import 加载本文件，
//    那个上下文里命名空间导入会报 `does not provide an export named 'default'`，整个 support 载入失败
//    （2026-09-20 实测：锅巴「插件配置」页里那一堆开关全没了）。用具名导入没有这个问题。
import { getAccountSwitches, setAccountEnabled, invalidate } from './utils/campImStore.js'
import { ownerOf } from './utils/campImPush.js'

function getAuthPoolSnapshot () {
  const accounts = authStore.getGuobaAccounts().map(account => ({
    ...account,
    statusText: account.authInvalid
      ? `失效${account.lastAuthErrorMessage ? ` | ${account.lastAuthErrorMessage}` : ''}`
      : '正常'
  }))
  const invalidCount = accounts.filter(account => account.authInvalid).length
  const usableCount = accounts.length - invalidCount

  return {
    accounts,
    invalidCount,
    usableCount
  }
}

/**
 * 营地消息的账号开关快照（给锅巴配置页的 GSubForm 用）。
 *
 * ⚠️ 数据源和侧边栏那个「营地消息」页面**是同一份**（`data/campIm.yaml`）——
 *    两处改哪个都生效，不会打架。
 *    这里放一份是为了让主人不用切页面，在「插件配置」里就能顺手开关。
 */
function getCampImSnapshot () {
  const switches = getAccountSwitches()
  const all = authStore.listAccounts().filter(a => a?.userId && a?.userSig)
  const infoOf = new Map(all.map(a => [String(a.userId), a]))

  // ⚠️⚠️ **只列「收消息名单」里的号**（`campIm.yaml` 的 accounts）——
  //    这份名单跟查询/推送轮询用的全局账号池是两回事，池子里的号扫进来是为了轮询，
  //    不代表它要挂 ws 收消息。早先这里把池子里的号全列出来、默认开，
  //    账号一多就没法管（2026-09-20 主人指出）。
  //    想加号：去侧边栏「营地消息」页面，那儿有「可以加进来的号」。
  const accounts = Object.keys(switches).map(uid => {
    const a = infoOf.get(String(uid)) || {}
    return {
      userId: String(uid),
      nickname: a.nickname || a.userName || '',
      enable: true
    }
  })

  // ⭐ 「＋新增」下拉里能挑的号：登录过、但还没进收消息名单的。
  //    ⚠️ 不给人手填 —— 谁记得住营地号那一串数字（2026-09-20 主人吐槽）。
  const available = all
    .filter(a => !switches[String(a.userId)])
    .map(a => {
      const uid = String(a.userId)
      const nick = a.nickname || a.userName || '未命名'
      const owner = ownerOf(uid)
      return {
        userId: uid,
        nickname: nick,
        label: `${nick}（${uid}）${owner ? '' : ' · 无归属不推'}`,
        value: uid
      }
    })

  return { accounts, available, enabledCount: accounts.length }
}

export function supportGuoba () {
  const {
    accounts: authPoolAccounts,
    invalidCount,
    usableCount
  } = getAuthPoolSnapshot()
  const campIm = getCampImSnapshot()

  return {
    pluginInfo: {
      name: '王者插件',
      title: '王者插件',
      author: '@cchanlan',
      authorLink: 'https://github.com/cchanlan',
      link: 'https://github.com/cchanlan/GloryOfKings-Plugin',
      isV3: true,
      isV2: false,
      description: '提供王者荣耀相关功能',
      iconPath: `${PluginPath}/resources/th.png`
    },
    configInfo: {
      schemas: [
        {
          component: 'Divider',
          label: '插件设置'
        },
        {
          field: 'config.onlineReminder',
          label: '推送总开关',
          bottomHelpMessage: '战绩推送 / 开局提醒 / 上下线提醒的总开关。打开后用户还需各自在群里发送 #开启战绩推送 或 #开启上下线提醒 订阅，只有订阅过的人会被轮询。打完一局推送的是和 #查询战绩N 同一张全场详情图。三条播报（打完 / 开局 / 上下线）都不 @ 本人，玩家名写在文案里，群里照样认得出是谁。',
          component: 'Switch'
        },
        {
          field: 'config.quoteReply',
          label: '引用触发消息',
          bottomHelpMessage: '默认开启。开启时回复会引用触发指令那条消息；关闭后直接发送，不带引用。',
          component: 'Switch'
        },
        {
          field: 'config.battleResultCron',
          label: '推送检查间隔',
          bottomHelpMessage: '战绩推送、开局提醒、上下线提醒共用这一个轮询，这里定的是「最快多久看一次」。每个订阅串行拉接口（间隔 800 毫秒）；真打完一局时会再拉一次详情并渲染图（约 1.3 秒）。玩家离线时实际间隔会按下面的退避倍数自动拉长，不会一直按这个频率打接口。设太短仍会触发营地频控 -30107，不建议低于 2 分钟。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '请输入Cron表达式'
          }
        },
        {
          field: 'config.idleBackoffMax',
          label: '离线退避倍数',
          bottomHelpMessage: '玩家离线时把检查间隔拉长到几倍上面的轮询间隔。离线的号既不会开局也不会出新战绩，照高频查纯属白耗配额、更容易撞上 -30107。默认 5，即 2 分钟的间隔在离线满 3 小时后退到 10 分钟一次（不活跃 1 小时内 2 倍、1~3 小时 3 倍）。代价是上线播报最坏晚这么久，期间「上线又下线」的短会话可能整段漏掉。填 1 = 关闭自适应，恒定按上面的间隔轮询。',
          component: 'InputNumber',
          componentProps: {
            placeholder: '默认 5'
          }
        },
        {
          field: 'config.dailyReportCron',
          label: '战绩日报推送时间',
          bottomHelpMessage: '每天到点给订阅者发一张当日战绩总结图（#开启日报推送 订阅）。数据读的是本地归档，正常不额外请求营地接口。当天没有对局就不推送。留空 = 关掉自动推送，只保留 #王者日报 指令。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每晚 23:47'
          }
        },
        {
          field: 'config.weeklyReportCron',
          label: '战绩周报推送时间',
          bottomHelpMessage: '同上，按「本周（周一 00:00 起）」汇总，默认周日晚推送。首次推送时本地归档可能还不全，图上会标明数据覆盖到哪天。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认周日 22:07'
          }
        },
        {
          field: 'config.monthlyReportCron',
          label: '战绩月报推送时间',
          bottomHelpMessage: '同上，按「本月（1 号 00:00 起）」汇总。cron 没法表达「每月最后一天」（各月天数不同），所以默认写成 28-31 号每晚触发，插件只在真正的月末那天推，不会连推四天。本地归档保留 35 天，刚好够一个月。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每月最后一晚 23:41'
          }
        },
        {
          field: 'config.groupDailyReportCron',
          label: '群日报推送时间',
          bottomHelpMessage: '给开过 #开启群日报推送 的群发一张全群战绩排行榜。和个人日报不同，群报要逐个扫本群绑定营地ID的成员，每人至少一次营地请求（最多 25 个活跃账号，约 30 秒），所以默认时间和个人日报错开。全群当天没人打就不推送。留空 = 关掉自动推送，只保留 #群日报 指令。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每晚 23:22'
          }
        },
        {
          field: 'config.groupWeeklyReportCron',
          label: '群周报推送时间',
          bottomHelpMessage: '同上，按「本周（周一 00:00 起）」汇总全群。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认周日 21:34'
          }
        },
        {
          field: 'config.groupMonthlyReportCron',
          label: '群月报推送时间',
          bottomHelpMessage: '同上，按「本月（1 号 00:00 起）」汇总全群。和个人月报一样是 28-31 号触发、只在真正的月末那天推。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每月最后一晚 23:18'
          }
        },
        {
          component: 'Divider',
          label: '服务端接入'
        },
        {
          field: 'config.distUrl',
          label: '分发服务地址',
          bottomHelpMessage: '观战和营地消息的服务端代码从主人服务器上的「分发服务」下载（默认端口 6868），不再从 git 仓库拉。装观战/消息时发 #营地观战接入 <地址> <令牌> 会自动写这里。留空 = 还没接入，进群 972915804 找主人要。',
          component: 'Input',
          componentProps: {
            placeholder: 'http://你的域名:6868'
          }
        },
        {
          field: 'config.distToken',
          label: '接入令牌',
          bottomHelpMessage:
            '主人签发的令牌，**观战 / 营地消息 / 共享库 三套共用这一个** —— ' +
            '主人签发时是「代共享库签」的，所以一个值三边都认，不用分别填。' +
            '⚠️ 是凭证，等同密码，别往群里贴、也别把带它的配置截图发出去。' +
            '等价指令：#营地共享库令牌 <令牌>。',
          component: 'Input',
          componentProps: {
            placeholder: 'gok_1_xxxxxxxx'
          }
        },
        {
          field: 'config.dependencyRegistry',
          label: '依赖 npm 镜像',
          bottomHelpMessage: '接入观战/营地消息时自动安装缺失依赖，默认使用国内 npm 镜像；留空也会使用默认镜像。',
          component: 'Input',
          componentProps: {
            placeholder: 'https://registry.npmmirror.com'
          }
        },
        {
          field: 'config.dependencyProxy',
          label: '依赖安装代理',
          bottomHelpMessage: '外网安装依赖时使用的 HTTP(S) 代理，例如 http://127.0.0.1:7890；不需要就留空。',
          component: 'Input',
          componentProps: {
            placeholder: 'http://127.0.0.1:7890'
          }
        },
        {
          field: 'config.shareEnabled',
          label: '营地ID共享库',
          bottomHelpMessage:
            '接入一个「QQ → 营地ID」共享池，让用户在别的机器人上绑过的营地ID 在本机也能直接用，不用重新绑定。' +
            '共享库由主人统一提供，地址进群 972915804 找主人要（不再支持自行部署）。' +
            '默认关闭：不接入时本插件所有功能都不受影响。' +
            '用户默认**不共享**，要他们自己发 #开启营地ID共享 才会把自己的营地ID传上去。' +
            '只有当场发的查询指令认共享数据，推送/排行榜/#谁在打游戏 仍只认本机绑定。' +
            '本机还需要有一个可用的全局账号，共享来的营地ID 才查得动（#营地wx全局登录）。',
          component: 'Switch'
        },
        {
          field: 'config.shareApiUrl',
          label: '共享库地址',
          bottomHelpMessage:
            '共享库服务端的地址，要带 http:// 或 https://。留空 = 不接入。' +
            '等价指令：#营地共享库地址 <地址>。',
          component: 'Input',
          componentProps: {
            placeholder: 'https://your-share.example.com'
          }
        },
        {
          field: 'config.shareAdminSecret',
          label: '共享库管理密钥（远程管理）',
          bottomHelpMessage:
            '服务端 .env 里的 GOK_ADMIN_SECRET。库跑在别的机器或 Docker 上时，' +
            '配上它就能用 #营地共享库发令牌 / 接入方 / 吊销 远程管库。' +
            '这个密钥能签发、吊销令牌，权限很大，别往群里贴。',
          component: 'Input',
          componentProps: {
            placeholder: '64 位十六进制（openssl rand -hex 32 生成）'
          }
        },
        {
          field: 'config.distAdminSecret',
          label: '分发服务管理密钥（主人用）',
          bottomHelpMessage: '签令牌 / 看接入方 / 吊销要用它。本机部署了分发服务时插件会自动读它的 .env，不用填；分发服务跑在别的机器上时才填。用 #营地分发管理密钥 <密钥> 设置（只收私聊）。',
          component: 'Input',
          componentProps: {
            placeholder: '64 位十六进制'
          }
        },
        {
          field: 'config.distRepoUrl',
          label: '分发服务代码仓库',
          bottomHelpMessage: '部署分发服务时从哪个仓库拉代码（它的 dist 分支）。一般不用改，换成自己的私库时才要。',
          component: 'Input',
          componentProps: {
            placeholder: '留空 = 用默认的私库'
          }
        },
        {
          component: 'Divider',
          label: '营地观战'
        },
        {
          field: 'config.watchApiUrl',
          label: '观战服务地址',
          bottomHelpMessage: '观战要另跑一个后端进程（负责取直播流、录像），插件通过这个地址指挥它。自己部署：先接入分发服务（见上面「服务端接入」），再发 #营地观战部署；用别人部署好的：直接发 #营地观战连接 <地址>，本机什么都不用装。换地址改这里也行，不用重启云崽。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 http://127.0.0.1:8899'
          }
        },
        {
          field: 'config.watchPublicUrl',
          label: '直播间对外地址',
          bottomHelpMessage: '填写群友能访问的地址（域名或公网 IP）和端口，如 http://abc.com:8899，并放行防火墙/安全组对应端口。使用 https 时先配置 HTTPS 反向代理；需要 CDN 直连时，再配置下方「观战 CDN（https）」。',
          component: 'Input',
          componentProps: {
            placeholder: '留空 = 用上面的地址'
          }
        },
        {
          field: 'config.watchCdnHttps',
          label: '观战 CDN（https）',
          bottomHelpMessage: '先按 server/README-CDN-HTTPS.md 部署 Cloudflare Worker，再填 https://cdn.example.com；保存后发 #营地观战部署 生效，清空后也要保存并部署。留空时 https 观众使用本机转发，http 观众仍直连营地 CDN。',
          component: 'Input',
          componentProps: {
            placeholder: 'https://cdn.example.com'
          }
        },
        {
          component: 'Divider',
          label: '营地消息'
        },
        {
          field: 'config.campImApiUrl',
          label: '营地消息服务地址',
          bottomHelpMessage: '营地消息要另跑一个后端进程（给每个营地号挂长连接收消息），插件通过这个地址指挥它。自己部署：先接入分发服务（见上面「服务端接入」），再发 #营地消息部署；用别人部署好的：直接发 #营地消息连接 <地址>，本机什么都不用装。换地址改这里也行，不用重启云崽。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 http://127.0.0.1:8900'
          }
        },
        {
          field: 'config.campImEnabled',
          label: '营地消息总开关',
          bottomHelpMessage: '关掉后插件不再拉消息、也不再推私信（服务端照常收）。每个营地号的收发只推给它的归属人 —— 没有归属人的号一律不推。哪个号要收消息、哪个不要，去侧边栏的「营地消息」页面一个个开关。',
          component: 'Switch'
        },
        {
          field: 'config.campImPollMs',
          label: '拉消息间隔（毫秒）',
          bottomHelpMessage: '插件多久去服务端取一次新消息。走本机回环、没有风控，只影响推送延迟。别调太小（下限 1000）。',
          component: 'InputNumber',
          componentProps: {
            min: 1000,
            step: 1000
          }
        },
        {
          field: 'config.campImPushImage',
          label: '推送带对方头像',
          bottomHelpMessage: '开着的话推送会带对方在游戏里的头像。头像加载慢或发图失败时会自动降级成纯文字，不会丢消息。',
          component: 'Switch'
        },
        {
          field: 'campIm.accounts',
          label: `哪些营地号收消息（共 ${campIm.accounts.length} 个）`,
          helpMessage: '只对「有归属人」的号生效 —— 没有归属人的号一律不推，加了也没用。',
          bottomHelpMessage:
            '⚠️ 这是**收消息专用**的名单，跟查询/推送轮询用的账号池是两回事 —— ' +
            '扫进来的全局账号默认**不**收消息，只拿来轮询查数据；要收消息的才加到这里。' +
            '「删除」= 移出名单（立刻停掉它的长连接），删了不会再自动冒出来。' +
            '想加号去侧边栏「营地消息」页面（那儿列着「可以加进来的号」）。' +
            '归属人是扫码登录时记下的，想换人去「账号列表」改「归属 QQ」。',
          component: 'GSubForm',
          componentProps: {
            multiple: true,
            modalProps: { title: '营地号' },
            schemas: [
              {
                field: 'userId',
                label: '营地号',
                component: 'Select',
                required: true,
                componentProps: {
                  // ⚠️ 下拉挑，不给人手填营地号那串数字（主人 2026-09-20 吐槽「谁记得id」）
                  options: campIm.available,
                  placeholder: campIm.available.length ? '挑一个登录过的营地号' : '没有可加的号了（都已在名单里）',
                  filterable: true
                }
              },
              {
                field: 'enable',
                label: '收消息',
                component: 'Switch',
                // 新增一行时默认就是「收」—— 加进来当然是为了收消息
                defaultValue: true,
                componentProps: { defaultValue: true }
              }
            ]
          }
        },
        {
          field: 'config.watchHintEnabled',
          label: '开播引导',
          bottomHelpMessage: '开了之后：订阅上下线提醒的人一上线，后台会盯着他进对局；进对局满设定分钟数、且确认这一局能看（是全局账号好友 + 排位/巅峰赛 + 没关战绩）时，往他订阅的群里发一条「要不要开播」的提示。群里任何人发 #营地开播 就能开这一路。',
          component: 'Switch'
        },
        {
          field: 'config.watchHintAfterMin',
          label: '开局多少分钟后提示',
          bottomHelpMessage: '进对局满这么多分钟才发开播提示。太早发的话营地那边可能还没把流推起来，点开要等；3 分钟是实测比较稳的值。',
          component: 'InputNumber',
          componentProps: {
            min: 1,
            max: 30,
            placeholder: '默认 3'
          }
        },
        {
          field: 'config.watchHintPollMs',
          label: '盯梢轮询间隔（毫秒）',
          bottomHelpMessage: '盯梢期间多久查一次对局状态，默认 15000（15 秒）。别调太小 —— 营地接口有频控，命中一次该账号要静默 12 小时。下限 5000。',
          component: 'InputNumber',
          componentProps: {
            min: 5000,
            step: 1000,
            placeholder: '默认 15000'
          }
        },
        {
          field: 'config.campRenewCron',
          label: '登录态保活时间（cron）',
          bottomHelpMessage: '营地的 token 不给过期时间、也没有刷新接口 —— 是「用则续命、闲置才死」（闲置久了会报登录态失效）。这里配个时间，插件会定期给每个号戳一下把它保住，QQ 和微信都适用。默认每天 5:13 跑一次。留空 = 关掉定时（还能手发 #营地续期）。QQ 号万一还是失效了能自动重登救回；微信失效只能重新扫码。',
          component: 'Input',
          componentProps: {
            placeholder: "默认 0 13 5 * * *（秒 分 时 日 月 周）"
          }
        },
        {
          component: 'Divider',
          label: '出图'
        },
        {
          field: 'config.imgType',
          label: '输出图片类型',
          helpMessage: '插件所有出图指令（战绩 / 主页 / 皮肤墙 / 帮助面板 / 营地消息卡片…）统一用这个格式',
          bottomHelpMessage:
            '插件 37 处出图统一读这一项，改完下次出图就生效，不用重启。' +
            '⚠️ 选 WebP 之前先看你的适配器：微信（ComWeChat）的图片接口不认 webp，' +
            '会把图降级成「文件」发出去 —— 群友收到的是 xxx.webp 文件卡片而不是图（2026-09-24 实测）。' +
            'QQ / OneBot 等平台用 webp 能省三成左右体积。拿不准就保持 JPEG。',
          component: 'Select',
          componentProps: {
            options: [
              { label: 'JPEG（推荐，全平台通用）', value: 'jpeg' },
              { label: 'PNG（无损，体积最大）', value: 'png' },
              { label: 'WebP（体积小，微信下会变成文件）', value: 'webp' }
            ]
          }
        },
        {
          component: 'Divider',
          label: '图片缓存'
        },
        {
          field: 'config.imgCacheMaxMB',
          label: '图片缓存上限',
          bottomHelpMessage: '插件下载的远程图片（英雄头像、皮肤图）缓存在 data/imgCache，单张平均 490KB。#皮肤墙 / #全部皮肤 一次会拉几百张，几个人轮着查就能堆到几百 MB —— 7 天过期只管时间管不住量，所以这里再加一道按体积削的兜底：超出上限时按下载时间从旧到新删。填 0 = 不限量。用 #王者缓存状态 看当前占用。',
          component: 'InputNumber',
          componentProps: {
            min: 0,
            max: 10240,
            placeholder: '默认 200（MB）'
          }
        },
        {
          field: 'config.imgCacheCleanCron',
          label: '缓存清理时间',
          bottomHelpMessage: '每天按上面的上限清一次图片缓存。默认凌晨 4 点，避开白天出图高峰。插件启动 30 秒后也会清一次（pm2 下 Yunzai 可以连着跑几个月不重启，只靠启动清理等于永不清理）。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每天 04:12'
          }
        },
        {
          component: 'Divider',
          label: '皮肤上新'
        },
        {
          field: 'config.skinNewsCron',
          label: '皮肤上新检查时间',
          bottomHelpMessage: '每天按这个时间查一次官网资料库，把「今天上线」和「新进清单（还没上线）」的皮肤推给已 #开启皮肤上新推送 的群。数据是官网公开 JSON，不占营地请求配额。留空 = 不自动推送，只保留 #皮肤上新 指令。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每天 12:26'
          }
        },
        {
          component: 'Divider',
          label: '黑名单'
        },
        {
          field: 'config.blackList',
          label: '插件黑名单',
          helpMessage: '命令：#王者拉黑@某人 / #王者取消拉黑@某人 / #王者黑名单',
          bottomHelpMessage: '填 QQ 号，可以填多个。名单里的人发任何王者指令都不会有回应，之前订阅的战绩推送、上下线提醒、日报周报月报也不再推，群报和排行榜里也不统计他。订阅和绑定数据都不会被删，从名单里移出去就自动恢复。主人不受影响。',
          component: 'GTags',
          componentProps: {
            placeholder: '请输入要拉黑的 QQ 号',
            allowAdd: true,
            allowDel: true
          }
        },
        {
          field: 'config.blackListFollowGlobal',
          label: '跟随机器人全局黑名单',
          bottomHelpMessage: '默认开启。开启后，机器人自身黑名单（Yunzai 的 config/config/other.yaml，blackUser / blackQQ 两个字段）里的人也一样不响应。全局黑名单只挡用户主动发的指令，挡不住插件按时间主动发的推送，所以开着它才能把「人已经拉黑了、战绩推送还在推」一起停掉。这里只是跟随，不会去改动全局名单。',
          component: 'Switch'
        },
        {
          component: 'SOFT_GROUP_BEGIN',
          label: '账号鉴权管理'
        },
        {
          component: 'Divider',
          label: '请求默认值'
        },
        {
          field: 'auth.gameAreaId',
          label: '游戏 AreaId',
          bottomHelpMessage: '请求默认值。账号本身未携带该字段时，默认使用这里的值，通常保持 1。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 1'
          }
        },
        {
          field: 'auth.gameUserSex',
          label: '游戏性别',
          bottomHelpMessage: '请求默认值。账号本身未携带该字段时，默认使用这里的值，通常保持 1。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 1'
          }
        },
        {
          field: 'auth.kohDimGender',
          label: '营地性别',
          bottomHelpMessage: '请求默认值。账号本身未携带该字段时，默认使用这里的值，通常保持 2。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 2'
          }
        },
        {
          field: 'auth.serverTimeOffsetMs',
          label: '时间偏移毫秒',
          bottomHelpMessage: '请求默认值。只有本机时间和服务端时间存在明显偏差时才需要填写，通常保持 0。',
          component: 'InputNumber',
          componentProps: {
            placeholder: '默认 0'
          }
        },
        {
          component: 'Divider',
          label: '账号列表'
        },
        {
          component: 'Divider',
          label: '命令入口：#营地wx全局登录 / #王者帮助 / #王者设置 / #营地观战 / #王者用户统计 / #清理失效营地账号 / #开启战绩推送 / #关闭战绩推送 / #开启上下线提醒 / #关闭上下线提醒 / #战绩推送状态 / #清空王者战绩推送'
        },
        {
          field: 'authPool.accounts',
          label: `营地账号列表（共 ${authPoolAccounts.length} 个，可用 ${usableCount} 个，失效 ${invalidCount} 个）`,
          helpMessage: '管理 AuthPool.json 中的完整账号信息。字段名已尽量按实际代码名标注；手动录入时，至少需要 userId、token、userKey 这三个核心字段。',
          bottomHelpMessage: '删除条目会从账号池移除该账号；敏感字段支持直接编辑；全局账号和优先级都直接在这里维护（“全局账号”可以勾选多个，请求会在它们之间轮询）。',
          component: 'GSubForm',
          componentProps: {
            multiple: true,
            schemas: [
              {
                field: 'userId',
                label: '营地用户ID',
                component: 'Input',
                required: true,
                helpMessage: '核心字段；请求时会映射到 userid。',
                componentProps: {
                  placeholder: 'userId，例如 2119017299'
                }
              },
              {
                field: 'statusText',
                label: '当前状态',
                component: 'Input',
                componentProps: {
                  readonly: true,
                  placeholder: 'statusText'
                }
              },
              {
                field: 'ownerBotUserId',
                label: '归属 QQ',
                component: 'Input',
                componentProps: {
                  placeholder: 'ownerBotUserId，留空表示不归属任何 QQ'
                }
              },
              {
                field: 'isGlobalDefault',
                label: '全局账号（可多选，自动轮询）',
                component: 'Switch'
              },
              {
                field: 'priority',
                label: '优先级',
                component: 'InputNumber',
                componentProps: {
                  placeholder: '数值越小越优先，默认 100'
                }
              },
              {
                field: 'authInvalid',
                label: '标记失效',
                component: 'Switch'
              },
              {
                field: 'nickname',
                label: '昵称',
                component: 'Input',
                componentProps: {
                  placeholder: 'nickname'
                }
              },
              {
                field: 'userName',
                label: '用户名称',
                component: 'Input',
                componentProps: {
                  placeholder: 'userName'
                }
              },
              {
                field: 'snsnickname',
                label: '社交昵称',
                component: 'Input',
                componentProps: {
                  placeholder: 'snsnickname'
                }
              },
              {
                field: 'remark',
                label: '备注',
                component: 'Input',
                componentProps: {
                  placeholder: 'remark'
                }
              },
              {
                field: 'token',
                label: 'Token',
                component: 'InputPassword',
                required: true,
                helpMessage: '核心字段；请求头 token。',
                componentProps: {
                  placeholder: 'token'
                }
              },
              {
                field: 'userKey',
                label: 'UserKey',
                component: 'InputPassword',
                required: true,
                helpMessage: '核心字段；用于生成 encodeParam。',
                componentProps: {
                  placeholder: 'userKey'
                }
              },
              {
                field: 'encodeRes',
                label: 'EncodeRes',
                component: 'InputPassword',
                helpMessage: '可选补充；若存在可用于解出 userKey。',
                componentProps: {
                  placeholder: 'encodeRes'
                }
              },
              {
                field: 'accessToken',
                label: 'AccessToken',
                component: 'InputPassword',
                componentProps: {
                  placeholder: 'accessToken'
                }
              },
              {
                field: 'refreshToken',
                label: 'RefreshToken',
                component: 'InputPassword',
                componentProps: {
                  placeholder: 'refreshToken'
                }
              },
              {
                field: 'appOpenid',
                label: 'App OpenId',
                component: 'Input',
                componentProps: {
                  placeholder: 'appOpenid'
                }
              },
              {
                field: 'openId',
                label: '营地 OpenId',
                component: 'Input',
                componentProps: {
                  placeholder: 'openId'
                }
              },
              {
                field: 'gameOpenId',
                label: '游戏 OpenId',
                component: 'Input',
                componentProps: {
                  placeholder: 'gameOpenId'
                }
              },
              {
                field: 'gameRoleId',
                label: '游戏 RoleId',
                component: 'Input',
                componentProps: {
                  placeholder: 'gameRoleId'
                }
              },
              {
                field: 'gameServerId',
                label: '游戏 ServerId',
                component: 'Input',
                componentProps: {
                  placeholder: 'gameServerId'
                }
              },
              {
                field: 'gameAreaId',
                label: '游戏 AreaId',
                component: 'Input',
                componentProps: {
                  placeholder: 'gameAreaId，默认 1'
                }
              },
              {
                field: 'gameUserSex',
                label: '游戏性别',
                component: 'Input',
                componentProps: {
                  placeholder: 'gameUserSex，默认 1'
                }
              },
              {
                field: 'kohDimGender',
                label: '营地性别',
                component: 'Input',
                componentProps: {
                  placeholder: 'kohDimGender，默认 2'
                }
              },
              {
                field: 'avatar',
                label: '头像',
                component: 'Input',
                componentProps: {
                  placeholder: 'avatar'
                }
              },
              {
                field: 'bigAvatar',
                label: '大头像',
                component: 'Input',
                componentProps: {
                  placeholder: 'bigAvatar'
                }
              },
              {
                field: 'icon',
                label: '图标',
                component: 'Input',
                componentProps: {
                  placeholder: 'icon'
                }
              },
              {
                field: 'sex',
                label: '账号性别',
                component: 'Input',
                componentProps: {
                  placeholder: 'sex'
                }
              },
              {
                field: 'expires',
                label: 'Expires',
                component: 'Input',
                componentProps: {
                  placeholder: 'expires'
                }
              },
              {
                field: 'uin',
                label: 'Uin',
                component: 'Input',
                componentProps: {
                  placeholder: 'uin'
                }
              },
              {
                field: 'userSig',
                label: 'UserSig',
                component: 'InputPassword',
                componentProps: {
                  placeholder: 'userSig'
                }
              },
              {
                field: 'realRegisterTime',
                label: '注册时间',
                component: 'Input',
                componentProps: {
                  placeholder: 'realRegisterTime'
                }
              },
              {
                field: 'loginPlatform',
                label: '登录来源',
                component: 'Input',
                componentProps: {
                  placeholder: 'loginPlatform，例如 wechat'
                }
              },
              {
                field: 'authErrorCount',
                label: '失败次数',
                component: 'InputNumber',
                componentProps: {
                  placeholder: '默认 0'
                }
              },
              {
                field: 'updatedAt',
                label: '更新时间',
                component: 'Input',
                componentProps: {
                  placeholder: 'updatedAt'
                }
              },
              {
                field: 'lastLoginAt',
                label: '最近登录',
                component: 'Input',
                componentProps: {
                  placeholder: 'lastLoginAt'
                }
              },
              {
                field: 'lastSuccessAt',
                label: '最近成功',
                component: 'Input',
                componentProps: {
                  placeholder: 'lastSuccessAt'
                }
              },
              {
                field: 'lastAuthErrorAt',
                label: '最近失败',
                component: 'Input',
                componentProps: {
                  placeholder: 'lastAuthErrorAt'
                }
              },
              {
                field: 'lastAuthErrorMessage',
                label: '失败原因',
                component: 'Input',
                componentProps: {
                  placeholder: 'lastAuthErrorMessage'
                }
              }
            ]
          }
        }
      ],
      getConfigData () {
        const { accounts } = getAuthPoolSnapshot()
        const campIm = getCampImSnapshot()

        return {
          config: Config.getDefOrConfig('config'),
          auth: Config.getDefOrConfig('auth'),
          authPool: { accounts },
          campIm: { accounts: campIm.accounts }
        }
      },
      setConfigData (data, { Result }) {
        const configMap = {
          config: Config.getDefOrConfig('config'),
          auth: Config.getDefOrConfig('auth')
        }

        if (Object.prototype.hasOwnProperty.call(data, 'authPool.accounts')) {
          const { accounts: currentAccounts } = getAuthPoolSnapshot()
          authStore.replaceAccountsFromGuoba(data['authPool.accounts'] || currentAccounts)
        }

        // 营地消息的账号开关：写进 data/campIm.yaml（和侧边栏那个页面同一份）
        if (Object.prototype.hasOwnProperty.call(data, 'campIm.accounts')) {
          for (const item of (data['campIm.accounts'] || [])) {
            const userId = String(item?.userId || '').trim()
            if (!userId) continue
            setAccountEnabled(userId, item.enable === true)
          }
          invalidate()
        }

        for (const key in data) {
          if (key.startsWith('authPool.') || key.startsWith('campIm.')) {
            continue
          }

          const split = key.split('.')
          const configName = split.shift()
          const configPath = split.join('.')

          if (!configName || !configPath || !configMap[configName]) {
            continue
          }

          const currentValue = lodash.get(configMap[configName], configPath)
          if (!lodash.isEqual(currentValue, data[key])) {
            Config.modify(configName, configPath, data[key])
          }
        }

        return Result.ok({}, '𝑪𝒊𝒂𝒍𝒍𝒐～(∠・ω< )⌒★')
      }

    }
  }
}
