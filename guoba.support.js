import { Config, PluginPath, PluginName } from '#components'
// 只用 get / isEqual 两个函数，走 components 里的自带实现（lodash 从没写进 package.json）
import { get, isEqual } from './components/objectUtils.js'
import authStore from './utils/authStore.js'
// ⚠️ 用具名导入，**不要用 `import * as`** —— 锅巴重新扫描时用带 query 的动态 import 加载本文件，
//    那个上下文里命名空间导入会报 `does not provide an export named 'default'`，整个 support 载入失败
//    （2026-09-20 实测：锅巴「插件配置」页里那一堆开关全没了）。用具名导入没有这个问题。
import { getAccountSwitches, setAccountEnabled, invalidate, pruneAccounts } from './utils/campImStore.js'
import { ownerOf } from './utils/campImPush.js'
import { listMasterQQ } from './utils/masterMsg.js'
// 「刚开启自动签到 → 当场签一次」用。⚠️ 用具名导入（本文件顶部的注释解释过：
// 锅巴用带 query 的动态 import 加载本文件，命名空间导入会整个 support 载入失败）
import { currentCampSignInstance } from './apps/signIn.js'
// 锅巴面板打开时，把「接入那一刻写进配置、但面板还显示为空」的那几格补齐
import { fillDefaultShareUrl, migrateLegacyShareToken } from './utils/shareDefaults.js'

/**
 * 出给锅巴面板前要脱敏的账号字段。InputPassword 组件只遮前端输入框的显示，
 * 「查看已保存的配置」走 HTTP 拿到的仍是原文 —— 不挡的话面板上一个能看到
 * 插件配置页的人就能把整套营地登录态（token / userKey 能直接发请求）抄走
 * （2026-10-05 修）。
 */
const SECRET_FIELDS = ['token', 'userKey', 'userSig', 'encodeRes', 'accessToken', 'refreshToken']

/**
 * ⚠️⚠️ 掩码格式必须和 utils/authStore.js 里的 maskSecret **完全一致**（头 6 位 + `...` + 尾 4 位）——
 * 保存侧靠「提交回来的值 === mask（库里的原文）」认出「主人没碰过这一格」，格式一旦分叉，
 * 一次锅巴保存把所有凭证覆写成掩码串，整个账号池当场报废。那边是模块私有函数引不进来
 * （本文件被锅巴用带 query 的动态 import 加载，跨模块依赖已踩过坑，见上面的 import 注释），
 * 这里照抄一份 —— 谁改那边，必须同步改这里。
 */
function maskSecret (value, keepStart = 6, keepEnd = 4) {
  const text = value === null || typeof value === 'undefined' ? '' : String(value)
  if (!text) return ''
  if (text.length <= keepStart + keepEnd) return text
  return `${text.slice(0, keepStart)}...${text.slice(-keepEnd)}`
}

/** 快照出面板前把凭证字段打码，其余字段原样透传 */
function maskAccountsForGuoba (accounts) {
  return accounts.map(account => {
    const masked = { ...account }
    for (const field of SECRET_FIELDS) {
      masked[field] = maskSecret(account[field])
    }
    return masked
  })
}

/**
 * 面板存回来时的反向操作：把「没改过的掩码值」换回库里的原文。
 *
 * 判定第一看「提交值 === mask(当前库里值）」这一条等值比较 ——
 * 主人真去手改了一格的话，提交值必然不等于 mask（原文），会按新值正常写入；
 * 库里本来就是短值（mask 会原样返回）的字段，换回原文也等价不动。
 * 库里查不到这个 userId 的条目（面板新加的号）原样放行 —— 新号本来就是手填的明文。
 *
 * 等值比较失配但提交值里带 `...` 的：不当新值写回（那是面板打开期间凭证被后台换过、
 * 表单里残留的旧掩码串），保留库值并告警，见函数内注释（2026-10-05 修）。
 */
function restoreMaskedAccounts (accounts) {
  const stored = new Map(
    authStore.getGuobaAccounts().map(account => [String(account.userId), account])
  )
  return accounts.map(item => {
    const original = stored.get(String(item?.userId || ''))
    if (!original) return item
    const restored = { ...item }
    for (const field of SECRET_FIELDS) {
      // ⚠️ `item[field]` 也会随表单缺字段变 undefined，等值比较天然挡掉（undefined !== 任何串）
      if (item[field] && item[field] === maskSecret(original[field])) {
        restored[field] = original[field]
        continue
      }
      // ⚠️ 提交值里带 `...` 却又对不上库值的掩码：这是「面板打开期间凭证被后台换过」
      //    （campRenew 换 token、扫码换 userSig）—— 表单里还是打开那一刻的旧掩码串，
      //    等值比较自然失配。把它当真值写回会把凭证整个覆写成一串掩码、账号当场报废。
      //    这种保留库里的现值并告警；只有不带省略号的真正手填新值才会走到下面放行。
      //    ⚠️ 还要求**库里有值**（maskSecret 非空）：库里是空串时 maskSecret 也是空串，
      //       这个条件会退化成「只要提交值带省略号就保留库值」，把用户手填的新值静默丢掉，
      //       而打出的告警文案（「面板打开期间凭证被换过」）还是错的（2026-10-06 修）。
      if (typeof item[field] === 'string' && item[field].includes('...') &&
          maskSecret(original[field]) !== '' && item[field] !== original[field]) {
        restored[field] = original[field]
        logger.warn(`[王者锅巴] 账号 ${item.userId} 的 ${field} 提交值是过期掩码串（面板打开期间凭证可能已被后台更换），已保留库中现值`)
      }
    }
    return restored
  })
}

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
  // ⚠️⚠️ 「账号池里的号」和「能收营地消息的号」是**两个集合**，必须分开（2026-10-06 修）：
  //    · pool —— 池子里**所有**有 userId 的号。这是 pruneAccounts 的 keep 集合，
  //      语义是「在不在池子里」。
  //    · all  —— 池子里**能收营地消息**的号（有 userSig，微信区那条路）。这是
  //      「＋新增」下拉的候选集合。
  //    原先两处共用 `filter(a => a?.userId && a?.userSig)`，等于拿「有 userSig 的号」
  //    去喂删除语义的 pruneAccounts —— 营地消息是微信区走 userSig，QQ 区的号可能只有
  //    token/userKey，这类号只要进过名单，主人打开一次锅巴「插件配置」页就会被
  //    **从 campIm.yaml 里真删掉**，而保存侧同样过滤了 userSig、在面板上也加不回来。
  //    实测线上 5 个号都有 userSig，所以目前不触发；但这是「传错集合」而非有意取舍。
  const pool = authStore.listAccounts().filter(a => a?.userId)
  const all = pool.filter(a => a?.userSig)
  // ⚠️⚠️ **先跟账号池对账，再读名单**（2026-10-05 修）。原先直接
  //    `Object.keys(switches).map(...)` 遍历白名单，池子里查不到就退回空对象、
  //    条目照样列出来 —— 「账号管理页 1 个号、收消息名单 4 个」就是这么来的。
  //    详见 utils/campImStore.js 的 pruneAccounts。
  pruneAccounts(pool.map(a => a.userId))
  const switches = getAccountSwitches()
  const infoOf = new Map(all.map(a => [String(a.userId), a]))

  // ⚠️⚠️ **只列「收消息名单」里的号**（`campIm.yaml` 的 accounts）——
  //    这份名单跟查询/推送轮询用的全局账号池是两回事，池子里的号扫进来是为了轮询，
  //    不代表它要挂 ws 收消息。早先这里把池子里的号全列出来、默认开，
  //    账号一多就没法管（2026-09-20 主人指出）。
  //    想加号：去侧边栏「营地消息」页面，那儿有「可以加进来的号」。
  // ⚠️ 再 filter 一道兜底（同 webadapter/index.js 的理由）：宁可少列，
  //    也不能把池子里没有的号显示成「在收消息」
  const accounts = Object.keys(switches)
    .filter(uid => infoOf.has(String(uid)))
    .map(uid => {
      const a = infoOf.get(String(uid)) || {}
      return {
        userId: String(uid),
        nickname: a.nickname || a.userName || '',
        // ⚠️ 照实反映名单里的值，不要硬编码 true（2026-10-06 修）：
        //    `false` 也是「不在名单」的合法写法（老数据 / 手工编辑过 campIm.yaml），
        //    硬编码 true 会让面板把它显示成「收消息」，而用户随便点一次保存
        //    就会经 setConfigData 把它真的刷回收消息、挂上 ws 推私信。
        enable: switches[uid] === true
      }
    })

  // ⭐ 「＋新增」下拉里能挑的号：登录过、但还没进收消息名单的。
  //    ⚠️ 不给人手填 —— 谁记得住营地号那一串数字（2026-09-20 主人吐槽）。
  const available = all
    // ⚠️ 判据必须与 isAccountEnabled / setAccountEnabled 一致（严格等于 true）：
    //    用 `!switches[uid]` 的话，残留的 `false` 会让**同一个号既出现在名单里、
    //    又出现在「＋新增」下拉里**（2026-10-06 修）。
    .filter(a => switches[String(a.userId)] !== true)
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

  // 主人通知收件人的下拉候选：就是主人列表（锅巴里勾谁，运维提醒就只发给谁）
  const masterOptions = listMasterQQ().map(qq => ({ label: qq, value: qq }))

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
          bottomHelpMessage: '战绩推送、开局提醒、上下线提醒的总开关。用户还要各自发 #开启战绩推送 订阅。',
          component: 'Switch'
        },
        {
          field: 'config.quoteReply',
          label: '引用触发消息',
          bottomHelpMessage: '开启后回复会引用触发指令那条消息。',
          component: 'Switch'
        },
        {
          field: 'config.masterNotify',
          label: '主人通知收件人',
          bottomHelpMessage: '运维提醒（登录态失效、被限流、保活结果等）发给谁。留空 = 只发第一个主人。',
          // ⚠️ 用 `Select` 而不是 `GTags`（2026-10-06 修）：锅巴把 GTags 归进
          //    BLOCK_COMPONENTS（「整行大组件」），label 会改成**竖排**、说明文字
          //    （bottomHelpMessage）跟着顶到表单最左边 —— 实测左边缘 24px，
          //    而别的项是 184px（让开 label 的 160px），这一段明显突出来一截。
          //    而 GTags 在**有 options 时内部渲染的就是这个 Select**
          //    （mode="multiple"），所以换过来行为完全一样，只是 label 回了横排、
          //    宽度也跟着回到表单统一的 900px（GTags 自己另写了 560px 上限）。
          component: 'Select',
          componentProps: {
            mode: 'multiple',
            allowClear: true,
            options: masterOptions,
            placeholder: '留空 = 只发给第一个主人'
          }
        },
        {
          field: 'config.battleResultCron',
          label: '推送检查间隔',
          bottomHelpMessage: '多久查一次战绩。太快会被营地限流，不建议低于 2 分钟。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '请输入Cron表达式'
          }
        },
        {
          field: 'config.idleBackoffMax',
          label: '离线退避倍数',
          bottomHelpMessage: '玩家离线时把检查间隔拉长几倍。填 1 = 不拉长。',
          component: 'InputNumber',
          componentProps: {
            placeholder: '默认 5'
          }
        },
        {
          field: 'config.dailyReportCron',
          label: '战绩日报推送时间',
          bottomHelpMessage: '每天到点给订阅者发一张当日战绩总结图。留空 = 不自动推。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每晚 23:47'
          }
        },
        {
          field: 'config.weeklyReportCron',
          label: '战绩周报推送时间',
          bottomHelpMessage: '同上，按本周（周一起）汇总。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认周日 22:07'
          }
        },
        {
          field: 'config.monthlyReportCron',
          label: '战绩月报推送时间',
          bottomHelpMessage: '同上，按本月（1 号起）汇总，只在真正的月末那天推。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每月最后一晚 23:41'
          }
        },
        {
          field: 'config.groupDailyReportCron',
          label: '群日报推送时间',
          bottomHelpMessage: '给开过 #开启群日报推送 的群发全群战绩排行。留空 = 不自动推。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每晚 23:22'
          }
        },
        {
          field: 'config.groupWeeklyReportCron',
          label: '群周报推送时间',
          bottomHelpMessage: '同上，按本周（周一起）汇总全群。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认周日 21:34'
          }
        },
        {
          field: 'config.groupMonthlyReportCron',
          label: '群月报推送时间',
          bottomHelpMessage: '同上，按本月（1 号起）汇总全群。',
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
          bottomHelpMessage: '观战和营地消息的服务端从这里下载。留空 = 还没接入，进群 972915804 找主人要。',
          component: 'Input',
          componentProps: {
            placeholder: 'http://你的域名:6868'
          }
        },
        {
          field: 'config.distToken',
          label: '接入令牌',
          bottomHelpMessage:
            '观战、营地消息、共享库三套共用这一个。是凭证，别往群里贴。',
          component: 'Input',
          componentProps: {
            placeholder: 'gok_1_xxxxxxxx'
          }
        },
        {
          field: 'config.dependencyRegistry',
          label: '依赖 npm 镜像',
          bottomHelpMessage: '装观战/营地消息的依赖时用哪个 npm 镜像。',
          component: 'Input',
          componentProps: {
            placeholder: 'https://registry.npmmirror.com'
          }
        },
        {
          field: 'config.dependencyProxy',
          label: '依赖安装代理',
          bottomHelpMessage: '装依赖时走的 HTTP 代理，不需要就留空。',
          component: 'Input',
          componentProps: {
            placeholder: 'http://127.0.0.1:7890'
          }
        },
        {
          field: 'config.ffmpegPath',
          label: 'ffmpeg 路径',
          bottomHelpMessage:
            '留空 = 自动查找。提示「没找到 ffmpeg」时手填完整路径。',
          component: 'Input',
          componentProps: {
            placeholder: '留空 = 自动查找'
          }
        },
        {
          field: 'config.shareEnabled',
          label: '营地ID共享库',
          bottomHelpMessage:
            '接入「QQ → 营地ID」共享池，用户在别的机器人绑过的营地ID 这边能直接用。',
          component: 'Switch'
        },
        {
          field: 'config.shareApiUrl',
          label: '共享库地址',
          bottomHelpMessage:
            '共享库地址，要带 http:// 或 https://。留空 = 不接入。',
          component: 'Input',
          componentProps: {
            placeholder: 'https://your-share.example.com'
          }
        },
        {
          field: 'config.shareAdminSecret',
          label: '共享库管理密钥（远程管理）',
          bottomHelpMessage:
            '服务端的 GOK_ADMIN_SECRET，用来远程管库。别往群里贴。',
          component: 'Input',
          componentProps: {
            placeholder: '64 位十六进制（openssl rand -hex 32 生成）'
          }
        },
        {
          field: 'config.distAdminSecret',
          label: '分发服务管理密钥（主人用）',
          bottomHelpMessage: '签令牌、看接入方、吊销要用它。本机部署了分发服务时不用填。',
          component: 'Input',
          componentProps: {
            placeholder: '64 位十六进制'
          }
        },
        {
          field: 'config.distRepoUrl',
          label: '分发服务代码仓库',
          bottomHelpMessage: '部署分发服务时从哪个仓库拉代码。一般不用改。',
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
          bottomHelpMessage: '观战后端进程的地址。自己部署发 #营地观战部署，用别人的发 #营地观战连接。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 http://127.0.0.1:8898'
          }
        },
        {
          field: 'config.watchPublicUrl',
          label: '直播间对外地址',
          bottomHelpMessage: '群友看直播用的地址，填域名或公网 IP 加端口。',
          component: 'Input',
          componentProps: {
            placeholder: '留空 = 用上面的地址'
          }
        },
        {
          field: 'config.watchCdnHttps',
          label: '观战 CDN（https）',
          bottomHelpMessage: '配了 CDN 就填 https 地址，改完发一次 #营地观战部署。',
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
          bottomHelpMessage: '营地消息后端进程的地址。自己部署发 #营地消息部署，用别人的发 #营地消息连接。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 http://127.0.0.1:8900'
          }
        },
        {
          field: 'config.campImEnabled',
          label: '营地消息总开关',
          bottomHelpMessage: '关掉就不再拉消息、也不推私信。哪些号收消息去侧边栏「营地消息」页面勾。',
          component: 'Switch'
        },
        {
          field: 'config.campImPollMs',
          label: '拉消息间隔（毫秒）',
          bottomHelpMessage: '多久去服务端取一次新消息，别低于 1000。',
          component: 'InputNumber',
          componentProps: {
            min: 1000,
            step: 1000
          }
        },
        {
          field: 'config.campImPushImage',
          label: '推送带对方头像',
          bottomHelpMessage: '推送时带上对方在游戏里的头像。',
          component: 'Switch'
        },
        {
          field: 'campIm.accounts',
          label: `哪些营地号收消息（共 ${campIm.accounts.length} 个）`,
          // ⚠️ 这两段解释**必须放在问号里**，不能留 bottomHelpMessage（2026-10-06 修）。
          //    锅巴把 GSubForm 归进 BLOCK_COMPONENTS（「整行大组件」），这一项的
          //    label 竖排独占一行 —— 于是 bottomHelpMessage 会被渲染到表单**最左边**
          //    （实测 24px），而别的项都在 184px，突出来一截很难看。
          //    偏偏那段文字挂在锅巴的 FormItem 上、**不在组件内部**，componentProps
          //    够不着它（只有控件本身挪得动，见下面 componentProps.style）。
          //    收进 helpMessage 就没有这个位置问题了：它渲染在 label 旁边的问号里。
          //    锅巴的 helpMessage 支持数组，两段会分行显示，信息一条不丢。
          helpMessage: [
            '只对「有归属人」的号生效 —— 没有归属人的号不推。',
            '这是**收消息专用**的名单，跟查询/推送轮询的账号池是两回事。' +
            '「删除」= 移出名单并停掉它的长连接；想加号去侧边栏「营地消息」页面。'
          ],
          component: 'GSubForm',
          componentProps: {
            multiple: true,
            modalProps: { title: '营地号' },
            // ⚠️ 把表格右移，让它跟别的项**左边缘对齐**（2026-10-06 修）。
            //    锅巴把 GSubForm 归进 BLOCK_COMPONENTS（「整行大组件」），这一项的
            //    label 会改成竖排独占一行，表格就顶到了表单最左边（实测 24px），
            //    而别的项都在 184px（让开 label 那 160px）—— 表格突出来一截很难看。
            //    componentProps 会透传到 GSubForm 的根元素，所以这一条能把表格挪回去。
            //
            // ⚠️ 160px 是**硬编码**的，对应锅巴 SchemaForm 的 labelWidth 默认值
            //    （web/src/components/schema-form/SchemaForm.vue 的 `labelWidth: 160`）。
            //    那个值插件侧读不到，锅巴也没开放给 schema 指定，只能照着写。
            //    将来锅巴改了默认 labelWidth，这里要跟着改。
            //
            // ⚠️ 只挪得了表格本身：下面那段说明文字（bottomHelpMessage）挂在 FormItem
            //    上、不在组件里，够不着，仍会留在最左边。
            style: 'margin-left: 160px',
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
          bottomHelpMessage: '订阅上下线提醒的人进对局后，往群里发一条「要不要开播」的提示。',
          component: 'Switch'
        },
        {
          field: 'config.watchHintAfterMin',
          label: '开局多少分钟后提示',
          bottomHelpMessage: '进对局满这么多分钟才发提示。',
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
          bottomHelpMessage: '盯梢时多久查一次对局状态。别调太小，会被营地限流。',
          component: 'InputNumber',
          componentProps: {
            min: 5000,
            step: 1000,
            placeholder: '默认 15000'
          }
        },
        {
          field: 'config.campSignCron',
          label: '每日签到时间（cron）',
          bottomHelpMessage: '到点给每个号签一次，结果私聊各自的号主。默认每天 7:30。留空 = 关掉定时（还能手发 #王者签到）。只推「签上了」和「失败了」，已签过和没绑角色的号不打扰。',
          component: 'Input',
          componentProps: {
            placeholder: "默认 0 30 7 * * *（秒 分 时 日 月 周）"
          }
        },
        {
          field: 'config.campRenewCron',
          label: '登录态保活时间（cron）',
          bottomHelpMessage: '定期给每个号续一下登录态，默认每天 5:13。留空 = 关掉定时。',
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
          helpMessage: '插件所有出图都用这个格式',
          bottomHelpMessage: '⚠️ 微信不认 webp，会变成文件发出去。',
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
          bottomHelpMessage: '图片缓存最多占多少 MB，超了从最旧的开始删。填 0 = 不限量。',
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
          bottomHelpMessage: '每天按上面的上限清一次图片缓存。',
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
          bottomHelpMessage: '每天按这个时间查一次皮肤上新，推给订阅的群。留空 = 只保留指令。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每天 12:26'
          }
        },
        {
          component: 'Divider',
          label: '王者公告'
        },
        {
          field: 'config.gameNewsCron',
          label: '公告检查时间',
          bottomHelpMessage: '按这个时间查一次官网公告，推给订阅的群。留空 = 只保留指令。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每 2 小时的第 53 分'
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
          bottomHelpMessage: '名单里的人发任何指令都不回应，推送也不再发。订阅和绑定不会被删。',
          // ⚠️ 用 Select 的 tags 模式而不是 GTags（2026-10-06 修）：锅巴把 GTags 归进
          //    BLOCK_COMPONENTS（「整行大组件」），label 会改成**竖排**，于是控件和
          //    下面的说明文字一起顶到表单最左边 —— 实测左边缘 22px，而别的项是 184px
          //    （让开 label 那 160px），这一段明显突出来一截。
          //    Select 不在那个名单里，label 回到横排，控件和说明就自动对齐了。
          //    功能完全等价：tags 模式照样能一条一条加/删，数据也都是字符串数组。
          component: 'Select',
          componentProps: {
            mode: 'tags',
            placeholder: '输入 QQ 号后回车',
            tokenSeparators: [',', '，', ' '],
            allowClear: true
          }
        },
        {
          field: 'config.blackListFollowGlobal',
          label: '跟随机器人全局黑名单',
          bottomHelpMessage: '跟着机器人自己的黑名单一起挡。',
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
          bottomHelpMessage: '账号本身没带该字段时用这个值，通常保持 1。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 1'
          }
        },
        {
          field: 'auth.gameUserSex',
          label: '游戏性别',
          bottomHelpMessage: '账号本身没带该字段时用这个值，通常保持 1。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 1'
          }
        },
        {
          field: 'auth.kohDimGender',
          label: '营地性别',
          bottomHelpMessage: '账号本身没带该字段时用这个值，通常保持 2。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 2'
          }
        },
        {
          field: 'auth.serverTimeOffsetMs',
          label: '时间偏移毫秒',
          bottomHelpMessage: '本机时间跟服务端差得多时才填，通常保持 0。',
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
          helpMessage: '手动录入时至少要有 userId、token、userKey 三个字段',
          bottomHelpMessage: '删除条目会把账号移出账号池。Token/UserKey 等敏感字段展示时已打码，粘贴新值即可覆盖。',
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
        // ⭐ 打开面板时先把手填的那几格补齐（2026-10-06 修）。
        //
        // ⚠️⚠️ 为什么非得在**读**的时候自愈：`#营地观战接入 <地址> <令牌>` /
        //    `#营地消息接入 …` 落盘的是 `distUrl` / `distToken`，而这一页上
        //    「共享库地址」（`shareApiUrl`）和「接入令牌」（`distToken`）是**另外两格** ——
        //    用户接完观战回面板一看，令牌那格空的、共享库地址也是空的，只能再找主人
        //    问一遍地址。令牌本来就三套共用（主人代共享库签的），地址也有模板默认值，
        //    这两格不该留白。
        //    放在读侧而不是只放在接入侧，是因为**升级上来的老用户不会重发接入指令**：
        //    他们的 `shareToken` 里躺着值，而面板认的是 `distToken`，只能靠这里补。
        //    两个函数都只在目标键**为空**时才写，用户填过的值一律不动。
        fillDefaultShareUrl()
        migrateLegacyShareToken()

        const { accounts } = getAuthPoolSnapshot()
        const campIm = getCampImSnapshot()

        return {
          config: Config.getDefOrConfig('config'),
          auth: Config.getDefOrConfig('auth'),
          // ⚠️ 凭证字段出面板必须打码（见 SECRET_FIELDS），保存侧会用
          //    restoreMaskedAccounts 把没改过的掩码值换回原文
          authPool: { accounts: maskAccountsForGuoba(accounts) },
          campIm: { accounts: campIm.accounts }
        }
      },
      setConfigData (data, { Result }) {
        const configMap = {
          config: Config.getDefOrConfig('config'),
          auth: Config.getDefOrConfig('auth')
        }

        /**
         * ⭐「刚打开自动签到 → 当场签一次」（2026-10-10 主人要求）。
         *
         * ⚠️⚠️ 判据必须**窄**：不能「保存了就签」。这个面板有二十多个配置项，
         *    主人改任何一格都触发一轮签到的话，每保存一次就打十几个营地请求，
         *    十有八九撞 -30107（命中一次静默 12 小时）。
         *
         * 只在「这一格真的从旧值变成非空」时才签 = 「刚把自动签到打开」那一刻。
         * 三个条件缺一不可：
         *   ① 提交里**有** `config.campSignCron`（没提交 = 主人根本没碰这格）
         *   ② 新值**非空**（空 = 他是来关掉的，不该签）
         *   ③ 与旧值**不同**（保存了但没改，不该重复签）
         */
        const signCronKey = 'config.campSignCron'
        let turnedOnSign = false
        /** 提交里带了 cron 就记下新值，保存完之后用它重排 job（null = 这次没碰这格） */
        let nextSignCron = null
        if (Object.prototype.hasOwnProperty.call(data, signCronKey)) {
          const nextValue = String(data[signCronKey] ?? '').trim()
          const prevValue = String(get(configMap.config, 'campSignCron') ?? '').trim()
          turnedOnSign = Boolean(nextValue) && nextValue !== prevValue
          nextSignCron = nextValue
        }

        if (Object.prototype.hasOwnProperty.call(data, 'authPool.accounts')) {
          const payload = data['authPool.accounts']
          // ⚠️ 快照现在带掩码：payload 缺了/不是数组就**别动池子**。
          //    原来的 `|| currentAccounts` 兜底在带掩码的世界里等于「把掩码串当真值写回」，
          //    一次保存报废整个池子。真正的删号是传空数组 []（Array.isArray 过得了）。
          if (Array.isArray(payload)) {
            authStore.replaceAccountsFromGuoba(restoreMaskedAccounts(payload))
          }
        }

        // 营地消息的账号开关：写进 data/campIm.yaml（和侧边栏那个页面同一份）
        if (Object.prototype.hasOwnProperty.call(data, 'campIm.accounts')) {
          const payload = data['campIm.accounts']
          // ⚠️⚠️ 前端是**全量提交**当前名单的，删掉一行 = 那一项压根不出现在 payload 里。
          //    只逐个 set 的话，被删掉的那一行从来没被遍历到，于是永远留在名单里 ——
          //    而 apps/campIm.js 照样给它挂长连接、照样往归属人推私信（2026-10-06 修）。
          //    正确做法见同仓库 webadapter/index.js 的 /gok-camp-im/accounts：先做差集移出，再加入。
          // ⚠️ 同时补 Array.isArray 守卫（照上面 authPool 那半边的写法）：payload 不是数组就
          //    **别动名单** —— `|| []` 兜不住普通对象，`for...of` 抛 TypeError 会把后面
          //    config / auth 的写回整批带崩，用户看到的是「点了保存但什么都没变」。
          if (Array.isArray(payload)) {
            const wanted = new Set(
              payload
                .filter(item => item?.enable === true)
                .map(item => String(item?.userId || '').trim())
                .filter(Boolean)
            )
            // 先移出：名单里有、但这次没提交的
            for (const uid of Object.keys(getAccountSwitches())) {
              if (!wanted.has(uid)) setAccountEnabled(uid, false)
            }
            // 再加入
            for (const uid of wanted) setAccountEnabled(uid, true)
            invalidate()
          }
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

          const currentValue = get(configMap[configName], configPath)
          if (!isEqual(currentValue, data[key])) {
            Config.modify(configName, configPath, data[key])
          }
        }

        // ⚠️ 放在**所有写回之后**：这会儿配置才真的落盘。
        //    即时签到是异步跑的（见 signNowAfterEnable），保存接口立刻返回。
        if (turnedOnSign) {
          try {
            const inst = currentCampSignInstance()
            if (inst) {
              const started = inst.signNowAfterEnable()
              logger.info(
                started
                  ? `[${PluginName}] 自动签到已开启，先当场签一次（结果会私聊各号主）`
                  : `[${PluginName}] 自动签到已开启，但已有一轮在跑，这次没即时签`
              )
            } else {
              logger.warn(`[${PluginName}] 自动签到已开启，但取不到签到实例，这次没即时签`)
            }
          } catch (error) {
            // 即时签到失败**不能**让保存失败 —— 配置已经存好了，那才是主诉求
            logger.warn(`[${PluginName}] 开启自动签到后的即时签到触发失败：${error?.message || error}`)
          }
        }

        /**
         * ⭐⭐「面板改了签到时间 → 让 job 跟上」（2026-10-10 补的缺口）。
         *
         * ⚠️⚠️ 这一段**不能省**，而且跟上面那段是**两件事**：
         *   · 上面只管「刚开启 → 当场签一次」（要签，但只管这一次）
         *   · 这里管「job 有没有按新 cron 排上」（不签，但管以后每天）
         *
         * 少了它会怎样：主人原本关着自动签到（配置为空 → `collectTask` 压根没注册 job），
         * 然后在面板里填上 `0 30 7 * * *` 保存 —— 配置是对的、面板显示开着，
         * **但 job 从来没注册过，第二天早上什么都不发生**。
         * 而 `autoSign` 开头那道闸门只挡「配置空」，挡不住「配置非空但没 job」。
         *
         * 判据比上面宽一点：**只要提交里带了这一格**就重排（不要求「值变了」）——
         * 重排是幂等的（框架会先 cancel 再重建），多排一次没有任何副作用；
         * 而「值没变就不排」会在「配置被别的途径改过、job 没跟上」时漏掉。
         */
        if (nextSignCron !== null) {
          try {
            const inst = currentCampSignInstance()
            if (inst) {
              await inst.syncTaskCron(nextSignCron)
            } else {
              logger.warn(`[${PluginName}] 签到时间已保存，但取不到签到实例，job 没能重排`)
            }
          } catch (error) {
            // 同上：重排失败不能让保存失败（配置已经落盘了）
            logger.warn(`[${PluginName}] 签到时间保存后重排 job 失败：${error?.message || error}`)
          }
        }

        return Result.ok({}, '𝑪𝒊𝒂𝒍𝒍𝒐～(∠・ω< )⌒★')
      }

    }
  }
}
