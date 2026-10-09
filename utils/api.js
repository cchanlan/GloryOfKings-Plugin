import crypto from 'node:crypto'
import fetch from 'node-fetch'
import { Config } from '#components'
import { decrypt as xxteaDecrypt, encrypt as xxteaEncrypt } from './xxtea.js'
import authStore, { isUsableAuth } from './authStore.js'
import { notifyAccountRateLimited } from './rateLimitNotice.js'
import { markProfileHidden } from './hiddenProfiles.js'
import { sendMaster } from './masterMsg.js'

/**
 * 王者营地接口客户端。
 *
 * ## 分层
 *
 * 这个文件按职责分成五层，每层一个类，`ApiService` 是唯一对外的门面：
 *
 * | 层 | 类 | 管什么 |
 * |---|---|---|
 * | 频控与队列 | `CampRateLimiter` | 按账号记的 -30107 冷却、按账号分的发车队列 |
 * | 签名与请求头 | `CampRequestSigner` | encodeParam、traceparent、主站 / 表单两套 header |
 * | 响应解析 | `CampResponseReader` | 响应头业务码、campencrypt 解密、JSON 解析 |
 * | 鉴权会话 | `CampAuthSession` | auth.yaml 默认值、候选账号轮转、失效标记、对用户文案 |
 * | 请求编排 | `CampTransport` | 候选账号循环 + 重试 + 两种请求形态（JSON / form） |
 * | 门面 | `ApiService` | 全部业务接口 + 上层要用的公开方法 |
 *
 * ⚠️ **改这个文件前先读这一段**：对着王者营地的私有 API 写代码，
 * 协议层（URL、header 名、body 字段名、加密方式、业务码）是**不能动的**——
 * 硬改 = 调不通。`CampRequestSigner` 和 `CampResponseReader` 里那些看着
 * 「啰嗦、可以合并」的字段名，绝大多数就是协议本身，合并了就废。
 *
 * 旧版是一个 1900 行的 `ApiService` 扛下所有事，私有方法名（`#gatedFetch`、
 * `#acquireSlot`、`#runWithCandidates`、`#markRateLimited`、`#getAuthCandidates`
 * 等）被仓库里其它文件的注释引用着，搬走时在每个方法上都标了原名。
 */

/* ============================================================== 常量 */

/**
 * 营地接口公钥的缺省值。auth.yaml 里配了 `publicKey` 就用配的，没配用这个。
 * 用途：`encodeRes` 解密、`specialEncodeParam` 加密。
 */
const DEFAULT_PUBLIC_KEY = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC0h62mV/zjJtFsNdfFNlxksfUOpjDI2KCcBrPiA8T7szABT4InLDTrdXAW84QyGNiazB0i7pgPCNGSAYbiJrCRutZ5jQsVS0Wg/RnXfwVQDJcAHJDjP5IXyroeLX7NUxDai8nPcpfRsvq6sneobyPexZSH0TlVSnecsJZTj5wu/wIDAQAB'

/** 营地接口域名：主站（JSON 接口）与游戏侧（form 接口）分开 */
const BASE_URLS = {
  main: 'https://kohcamp.qq.com',
  game: 'https://ssl.kohsocialapp.qq.com:10001'
}

/** 主站 Host 头。判断依据是「url 里含不含主站域名」，不是端点前缀 */
const HOST_MAIN = 'kohcamp.qq.com'

/** 游戏侧 Host 头（不带端口那一个，主站响应里用） */
const HOST_GAME = 'ssl.kohsocialapp.qq.com'

/** 游戏侧 form 接口的 Host 头，**带端口** —— 和上面那个不是一个值，别合并 */
const HOST_GAME_FORM = 'ssl.kohsocialapp.qq.com:10001'

/** 业务码：成功 */
const CODE_SUCCESS = 0

/** 营地频控错误码：操作频繁 */
const CODE_RATE_LIMITED = -30107

/**
 * 营地确定性「账号登录态失效」错误码（实测闲置 29 天的号回的就是它）。
 * 只有这类确定性信号才允许给账号打 authInvalid 标记，见 isDefiniteAuthFailure。
 */
const CODE_ACCOUNT_INVALID = -30003

/** 对方隐藏了主页：数据永远拿不到，标注后 24 小时内不再主动查（见 utils/hiddenProfiles.js） */
const CODE_PROFILE_HIDDEN = -10107

/** 主页接口。只有它返回的 -10107 才代表「这个玩家隐藏了主页」 */
const PROFILE_ENDPOINT = '/game/koh/profile'

/**
 * 营地业务码归类。所有端点的判定都从这一张表走，避免出现
 * 「这个端点认 -30107、那个不认」的漂移。
 *
 * ⚠️ `NONE`（响应里没给 returnCode，或给的不是数字）与 `SUCCESS`（0）
 * 都算「正常」，分开只是为了让日志与排障能看出是哪种。
 */
const BUSINESS_CODE = {
  /** 响应里没有 returnCode，或它不是有限数字 */
  NONE: 'none',
  /** 0：成功 */
  SUCCESS: 'success',
  /** -30107：操作频繁 */
  RATE_LIMITED: 'rate-limited',
  /** -10107：对方隐藏了主页 */
  PROFILE_HIDDEN: 'profile-hidden',
  /** 其余非 0 业务码 */
  ERROR: 'error'
}

/**
 * 相邻两次真实 HTTP 请求的最小间隔。营地接口按请求方账号限频，
 * 排行榜一次 19 连发、推送轮询和用户查询叠加时就触发 -30107，
 * 全局串行队列把所有端点的请求拉平到这个节奏。
 *
 * 导出给上层估算耗时用（如排行榜「约需 N 秒」的提示）：批量请求的实际节奏
 * 由这一个值决定，上层再各自写一份就会和真实节奏对不上。
 */
export const MIN_REQUEST_GAP_MS = 1200

/**
 * 命中 -30107 后这个账号**静默多久**：12 小时，不做指数退避。
 *
 * 短冷却试过，没用。60s 起步、连续命中翻倍、封顶 30 分钟那套，实测表现是
 * 「冷却一过打出去的第一发**必然**再中」——2026-09-13 那个号连续 5 个多小时卡在
 * 「连续第 10 次、恒 600s」下不来（13:44~19:14 一直没恢复），说明营地的惩罚期
 * 远长于 30 分钟，而且被反复试探还会续期。既然短时间内怎么试都是失败，
 * 就一次安静够：12 小时里这个号一个请求都不发，期间其他全局账号照常轮询顶上。
 *
 * 主人 2026-09-13 拍板：命中即静默 12 小时，并私信主人（见 utils/rateLimitNotice.js）。
 */
const RATE_LIMIT_SILENCE_MS = 12 * 60 * 60 * 1000

/**
 * 单次营地请求的超时。**只计「发车之后」**，不含排队等待——
 * 这两件事早先是混在一起算的：计时器建在 `#gatedFetch` 之前，而 `#gatedFetch`
 * 第一件事是排 MIN_REQUEST_GAP_MS 的全局队列，于是并发请求里排在后面的那些
 * 一律被自己的排队时间耗光额度。#排位表现 一次并发 7 个请求（6 路 getFightData
 * + seasonpage 串行两跳），队列放行时刻是 0/1.2/2.4/…/7.2 秒，最后几个必然
 * 在还没发出去时就 abort，重试又排到队尾、再超时。计时改到领到名额之后才起。
 */
const REQUEST_TIMEOUT_MS = 10000

/** 重试退避的基数：第 n 次重试等 `1000 * 2^n` 毫秒（1s、2s、4s…） */
const RETRY_BASE_DELAY_MS = 1000

/** 外站公开 JSON（官网资料库 / sapi.run）的超时。这些接口不进队列，但也不能不设表 */
const EXTERNAL_TIMEOUT_MS = 12000

/**
 * 外站公开数据地址。
 *
 * ⚠️ 拼 query 的地方都直接用这些常量 + `?`，别在别处再写一遍字面量——
 * 官网改版时改一处就够（`getPvpNewsList` / `getPvpNewsDetail` 就是这么踩过的）。
 */
const EXTERNAL_URLS = {
  /** 官网英雄总表（ename → 英雄信息），#查战绩 的必经路径 */
  heroList: 'https://pvp.qq.com/web201605/js/herolist.json',
  /** 官网资料库皮肤总表（约 780KB / 816 条），图片覆盖率 100% 的公开图源 */
  pvpSkinList: 'https://pvp.qq.com/zlkdatasys/heroskinlist.json',
  /** 爆料站皮肤数据 */
  heroXpflby: 'https://pvp.qq.com/zlkdatasys/data_zlk_xpflby.json',
  /** 官网装备总表（121 条，UTF-8） */
  pvpItemList: 'https://pvp.qq.com/web201605/js/item.json',
  /** 英雄战力查询（sapi.run，四区各一发） */
  heroFightingCapacity: 'https://www.sapi.run/hero/select.php',
  /** 官网资讯列表（公告 / 新闻 / 赛事），零鉴权 */
  pvpNewsList: 'https://apps.game.qq.com/cmc/cross',
  /** 官网公告正文（JSONP） */
  pvpNewsDetail: 'https://apps.game.qq.com/wmp/v3.1/public/searchNews.php',
  /** 官网英雄资料页（路径是**英雄拼音**，不是英雄 ID） */
  heroDetailPage: 'https://pvp.qq.com/web201605/herodetail'
}

/**
 * 官网资讯接口的签名参数。官网前端 `newsindex.js` 里明文写死，
 * 签名算法是 `md5(token + source + serviceId + 秒级时间戳)`。
 * 缺了签名会回 `{"msg":"p0 error","status":-1}`。
 */
const PVP_NEWS_TOKEN = '234ce0aef3020cb83887883877b64869'
const PVP_NEWS_SERVICE_ID = 18
const PVP_NEWS_SOURCE = 'web_pc'

/** 英雄战力查询要跑的四个大区（安卓/苹果 × QQ/微信），键名是 sapi.run 的 `type` 参数 */
const FIGHTING_CAPACITY_REGIONS = ['aqq', 'awx', 'iqq', 'iwx']

/* ========================================================== 错误类型 */

/**
 * 插件自定义错误的基类。
 *
 * 抽出来是为了给「重试循环要不要放弃」一个统一判据（见 isFatalError）：
 * 这些错误重试多少次都是同一个结果，早退比白等 1~2 秒强。
 */
class CampError extends Error {
  constructor (message) {
    super(message)
    this.name = 'CampError'
  }
}

/** 鉴权配置不完整 / 安全参数不对。换账号、重试都没用，得让主人重新登录 */
class AuthConfigError extends CampError {
  constructor (message) {
    super(message)
    this.name = 'AuthConfigError'
  }
}

/**
 * 「确实是**这个账号**的登录态失效了」专用错误，用来和 AuthConfigError 分家。
 *
 * ⚠️ 候选账号循环**只按 AuthAccountError 给账号打 authInvalid 标记**。
 *    AuthConfigError 是配置/系统级问题（典型：encryptParamErr = 营地不认
 *    硬编码的 cClientVersionCode，和账号无关），拿它去标记会把全池一锅端——
 *    cClientVersionCode 一旦失效，N 个账号挨个撞同一个 encryptParamErr，
 *    换号逻辑一路标下来一轮全灭，而每个号本身都是好的。
 */
class AuthAccountError extends AuthConfigError {
  constructor (message) {
    super(message)
    this.name = 'AuthAccountError'
  }
}

/**
 * 频控错误。单独一个类型，是因为它和别的失败处理方式相反：
 * 不能重试（重试只会加重频控），也不能换账号（账号池通常只有一个 token），
 * 唯一有效的做法是立刻放弃、等冷却过去。重试循环和候选账号循环都靠这个类型提前退出。
 */
class RateLimitError extends CampError {
  constructor (message) {
    super(message)
    this.name = 'RateLimitError'
  }
}

/** 我们自己抛的错 = 重试没意义的错 */
function isFatalError (error) {
  return error instanceof CampError
}

/* ======================================================== 工具函数 */

/** 把「还要等多久」写成读得懂的话：超过一小时说小时，否则说秒 */
function describeWait (ms) {
  return ms >= 3600000 ? `${Math.ceil(ms / 3600000)} 小时` : `${Math.ceil(ms / 1000)} 秒`
}

/** 把 AbortError 翻译成人话，否则用户只看到 “The operation was aborted” */
function describeAbort (error, timeoutMs) {
  if (error?.name === 'AbortError' || error?.type === 'aborted') {
    return new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒无响应）`)
  }
  return error
}

/** 统一的值 → 文本转换：null / undefined 一律空串，其余 String() */
function toText (value) {
  if (value === null || typeof value === 'undefined') {
    return ''
  }

  return String(value)
}

/** 打码：头 keepStart 尾 keepEnd，中间三星（userId 用这个口径） */
function maskUserId (value, keepStart = 3, keepEnd = 3) {
  const text = toText(value)
  if (!text) {
    return ''
  }

  if (text.length <= keepStart + keepEnd) {
    return text
  }

  return `${text.slice(0, keepStart)}***${text.slice(-keepEnd)}`
}

/** 打码：头 keepStart 尾 keepEnd，中间省略号（token / userKey 用这个口径） */
function maskValue (value, keepStart = 6, keepEnd = 4) {
  const text = toText(value)
  if (!text) {
    return ''
  }

  if (text.length <= keepStart + keepEnd) {
    return text
  }

  return `${text.slice(0, keepStart)}...${text.slice(-keepEnd)}`
}

/** 日志预览：字符串原样，对象 JSON 化，超长截断并标注 */
function previewValue (value, maxLength = 1200) {
  if (value === null || typeof value === 'undefined') {
    return ''
  }

  let text = ''
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }

  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength)}...(truncated)`
}

/** 请求调试日志的载荷。两种请求形态共用同一份结构，方便对着日志排障 */
function buildRequestDebugInfo (method, url, headers, body, context = {}) {
  return {
    endpoint: context.endpoint || '',
    method,
    url,
    attemptIndex: Number(context.attemptIndex || 0),
    targetUserId: context.targetUserId || '',
    requesterBotUserId: context.requesterBotUserId || '',
    headers: maskDebugHeaders(headers),
    body: maskDebugBody(body)
  }
}

/** 日志里必须打码的键名（token / 账号标识 / 签名，全部是明文凭证或可冒用的东西） */
const DEBUG_SECRET_KEY_RE = /^(token|userid|user_id|openid|open_id|gameopenid|game_openid|gameroleid|game_roleid|gameserverid|game_serverid|encodeparam|specialencodeparam|usersig)$/i

/**
 * 调试日志用的 header 脱敏。
 *
 * ⚠️⚠️ 为什么必须有（2026-10-06 修）：请求头是 `CampRequestSigner.authHeaders()` /
 *    `gameFormHeaders()` 的返回值，里面 token / userid / encodeParam **全是明文**。
 *    原先 buildRequestDebugInfo 把它们原样交给 logger.debug —— 只要框架日志级别调到
 *    debug（排障时基本一定会调），日志文件里就落下完整 token；而云崽的日志经常被整份
 *    导出 / 贴群里 / 发给作者排障，等于把全局账号交出去（营地 token 无固定过期时间，用则续命）。
 *    同文件的 `#debugInfo` 与 authStore 都约定「令牌进日志前都要打码」，这里是唯一漏网的一处。
 */
function maskDebugHeaders (headers) {
  if (!headers || typeof headers !== 'object') return headers
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key,
    DEBUG_SECRET_KEY_RE.test(key) ? maskValue(value) : value
  ]))
}

/**
 * 调试日志用的表单体脱敏（`gameFormBody` 拼出来的是 URLSearchParams 字符串）。
 * 见 maskDebugHeaders 的注释。
 */
function maskDebugBody (body) {
  if (typeof body !== 'string' || !body) return body
  return body.replace(
    /(^|&)(token|userId|openId|gameOpenId|gameRoleId|gameServerId|userSig|encodeParam)=([^&]*)/gi,
    (_, sep, key, value) => `${sep}${key}=${maskValue(value)}`
  )
}

/** 这个业务码算不算「非 0 的业务错误」（频控不在此列，它单独处理） */
function isBusinessErrorCode (kind) {
  return kind === BUSINESS_CODE.ERROR || kind === BUSINESS_CODE.PROFILE_HIDDEN
}

/** 营地业务码归类，见 BUSINESS_CODE 的说明 */
function classifyBusinessCode (code) {
  const numeric = Number(code)
  if (!Number.isFinite(numeric)) {
    return BUSINESS_CODE.NONE
  }

  if (numeric === CODE_SUCCESS) {
    return BUSINESS_CODE.SUCCESS
  }

  if (numeric === CODE_RATE_LIMITED) {
    return BUSINESS_CODE.RATE_LIMITED
  }

  if (numeric === CODE_PROFILE_HIDDEN) {
    return BUSINESS_CODE.PROFILE_HIDDEN
  }

  return BUSINESS_CODE.ERROR
}

/**
 * 「确定是这个号的登录态失效」的**精确短语**清单。
 *
 * ⚠️ 刻意**不含**「登录 / token / 鉴权 / 安全参数 / 权限」这类宽泛词：
 *    旧正则 `/登录|登录态|token|鉴权|安全参数|重新登录|权限/i` 会把任意业务错误文案
 *    （「该用户无权限查看」「操作频繁，请稍后重试」这类）都判成登录失效，
 *    于是健康账号被误标 authInvalid 还私信主人轰炸。判定失效只认确定性信号。
 */
const ACCOUNT_INVALID_MESSAGE_RE = /-30003|登录态失效|登录已失效|登录状态已经失效|请重新登录/

/** 宽泛的疑似鉴权关键词——**只进日志**，绝不作为给账号打标记的依据 */
const SUSPECTED_AUTH_KEYWORD_RE = /登录|登录态|token|鉴权|安全参数|重新登录|权限/i

/**
 * 响应是不是「确定这个账号的登录态失效了」。
 *
 * 判据只有两个确定性信号，命中其一才算：
 *   1. returnCode 是 -30003（营地明确的登录态失效码）
 *   2. 文案精确含「登录态失效 / 登录已失效 / 请重新登录」这类短语
 *
 * （取代旧的 isAuthFailureResponse —— 名字改了是因为语义整个反过来了：
 *   旧的是「宁可错杀」，新的是「宁可不标」；误标的代价是全池团灭，见 AuthAccountError。）
 */
function isDefiniteAuthFailure (data) {
  if (Number(data?.returnCode) === CODE_ACCOUNT_INVALID) {
    return true
  }

  const returnMsg = toText(data?.returnMsg || data?.message || data?.msg)
  if (!returnMsg) {
    return false
  }

  return ACCOUNT_INVALID_MESSAGE_RE.test(returnMsg)
}

/** 响应文案只是**疑似**和鉴权沾边（宽泛关键词）。只用来决定要不要多打一条日志 */
function isSuspectedAuthFailure (data) {
  const returnMsg = toText(data?.returnMsg || data?.message || data?.msg)
  if (!returnMsg) {
    return false
  }

  return SUSPECTED_AUTH_KEYWORD_RE.test(returnMsg)
}

/** 造一个大写 UUID */
function buildUuid () {
  return crypto.randomUUID().toUpperCase()
}

/** 公钥 base64 → PEM（每 64 字符一行） */
function buildPublicKeyPem (publicKey) {
  const chunks = publicKey.match(/.{1,64}/g) || [publicKey]
  return `-----BEGIN PUBLIC KEY-----\n${chunks.join('\n')}\n-----END PUBLIC KEY-----`
}

/**
 * 响应头按 form-urlencoded 解码。
 *
 * 营地按 form-urlencoded 编码 header：空格是 `+` 而不是 %20，decodeURIComponent 不认它，
 * 直接解会得到「-30107:操作频繁,+请稍后重试」这种带加号的文案，
 * 而这段 returnMsg 会被请求层拼进错误消息透给用户。
 * 先把 `+` 还原成空格再解码；真正的加号服务端会编成 %2B，不会被误伤。
 */
function decodeHeaderValue (value) {
  if (!value) {
    return ''
  }

  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return value
  }
}

/** 空文本按空对象处理，其余交给 JSON.parse（解析失败照抛，由调用方决定怎么包装） */
function parseJson (text) {
  if (!text) {
    return {}
  }

  return JSON.parse(text)
}

/** 睡一会儿（重试退避用） */
function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/* ================================================== 频控冷却与请求队列 */

/**
 * 按账号记的频控冷却 + 按账号分的发车队列。
 *
 * 这两件事绑在一起，因为它们共享同一个「账号」维度：营地的限流是按账号记的
 * （实测 2026-09-13，同一个号怎么等都会被拒、换个号立刻通），所以冷却和节奏
 * 都必须按账号成立，而不是全池一条线。
 */
class CampRateLimiter {
  /**
   * 账号 userId -> 静默截止时间戳（ms）。
   *
   * 按**账号**记，不是全局：多个全局账号轮询时，某个号被营地限流不该把池里
   * 其他好号一起拖停——那个号单独静默、从候选里跳过，其余的照常顶上。
   * 条目只在它请求成功时才删（见 clearRateLimit），所以「静默期内一个请求都不发」
   * 对上层完全透明。
   */
  #cooldownUntilByUser = new Map()

  /**
   * 最近一次真命中 -30107 的时刻（ms），0 = 从没命中过。
   *
   * 只给定时轮询当「命中信号」用（它靠这个判断本轮是不是又撞上了）。
   * 冷却本身是按账号记的，看它是看不出「现在还能不能用」的。
   */
  #lastRateLimitAt = 0

  /**
   * 账号 userId -> 该账号的队列尾。
   *
   * **按账号分队列，不是全局一条**：分开之后多个全局账号的请求能真正并发，
   * 谁也不用替别人白等——#谁在打游戏 的现刷、排行榜那种十几连发，
   * 速度直接按账号数成倍。
   */
  #queueTailByUser = new Map()

  /** 账号 userId -> 上次实际请求发出时刻 */
  #lastRequestAtByUser = new Map()

  /**
   * 这个账号还剩多少毫秒冷却（0 = 可正常使用）。
   *
   * 冷却按账号独立记，所以调用方能把「冷却中的号」从候选里挑出来跳过，
   * 而不是让整个插件停摆。
   *
   * （原 `#rateLimitCooldownLeft`）
   */
  cooldownLeft (auth) {
    const userId = toText(auth?.userId)
    if (!userId) {
      return 0
    }

    return Math.max(0, (this.#cooldownUntilByUser.get(userId) || 0) - Date.now())
  }

  /**
   * 冷却检查：只看传进来的这个账号。
   *
   * ⚠️ 错误文案里**不能**出现「全局账号 / token / 鉴权 / 登录态 / 安全参数」这类词。
   * 频控文案会被 formatUserFacingError 原样透给用户，一旦命中它那串敏感词正则，
   * 用户看到的就是「请联系主人处理」，反而看不出是频控。
   *
   * （原 `#assertNotRateLimited`）
   */
  #assertAvailable (auth) {
    const waitMs = this.cooldownLeft(auth)
    if (waitMs <= 0) return

    throw new RateLimitError(`营地接口暂时被限流，约 ${describeWait(waitMs)}后恢复，请稍后再试`)
  }

  /**
   * 记录一次 -30107 命中：把这个号静默 12 小时，并私信主人。
   *
   * 「首次」的判据就是**冷却表里还没有它**（成功恢复时条目会被删掉，见 clearRateLimit），
   * 所以静默期内就算又被别的路径撞到，也不会反复私信；等它哪天真恢复了、
   * 以后再被限流，会重新通知一次——那是新的事故，该说。
   *
   * （原 `#markRateLimited`，被 utils/rateLimitNotice.js 的注释引用着）
   *
   * @param {object} auth 命中的账号
   * @param {number} usableAccountCount 池里当前可用账号数，写进私信让主人知道还剩几个号
   * @returns {number} 本次静默毫秒数
   */
  markRateLimited (auth, usableAccountCount = 0) {
    const userId = toText(auth?.userId)
    if (!userId) {
      return 0
    }

    const firstHit = !this.#cooldownUntilByUser.has(userId)
    this.#cooldownUntilByUser.set(userId, Date.now() + RATE_LIMIT_SILENCE_MS)
    this.#lastRateLimitAt = Date.now()

    logger.warn(`[王者接口] 账号 ${maskUserId(userId)} 命中频控 -30107，静默 ${Math.round(RATE_LIMIT_SILENCE_MS / 3600000)} 小时`)

    // 通知是 fire-and-forget：私信发不出去也不能影响请求链路（sendMaster 自己吃异常）
    if (firstHit) {
      notifyAccountRateLimited({
        userId,
        silenceMs: RATE_LIMIT_SILENCE_MS,
        accountCount: usableAccountCount
      }).catch(() => {})
    }

    return RATE_LIMIT_SILENCE_MS
  }

  /** 该账号请求成功即视为它自己恢复，清掉它的静默记录（原 `#clearRateLimit`） */
  clearRateLimit (auth) {
    const userId = toText(auth?.userId)
    if (!userId) return

    // 有记录才说明它此前被限流过，这条日志就是「静默期结束」的信号
    if (this.#cooldownUntilByUser.has(userId)) {
      logger.mark(`[王者接口] 账号 ${maskUserId(userId)} 频控已恢复，静默期结束`)
    }
    this.#cooldownUntilByUser.delete(userId)
  }

  /** 最近一次真命中 -30107 的时刻（ms），0 = 从没命中过 */
  lastRateLimitAt () {
    return this.#lastRateLimitAt
  }

  /**
   * 这批账号是不是**全**在频控冷却里——也就是「现在谁都发不出去」。
   *
   * 给定时轮询用：整轮跳过比逐个订阅去撞省事得多（冷却中的号会被
   * `CampTransport.#runWithCandidates` 一个个跳过，一个真请求都发不出去，
   * 白抛错、白写盘）。
   *
   * ⚠️ 判据是「传进来的这批账号全在冷却表里」而不是「冷却表非空」：
   * 从没被限流过的账号压根不在表里，只看表会把「池里还有个没试过的号」
   * 误判成全池停摆。**空数组一律返回 false**——那是配置问题，
   * 该让请求抛「未找到登录态」，而不是被轮询当成频控悄悄跳过。
   */
  isAllCoolingDown (accounts) {
    const now = Date.now()
    if (!accounts.length) return false

    return accounts.every(account =>
      (this.#cooldownUntilByUser.get(toText(account.userId)) || 0) > now)
  }

  /**
   * 领一个发车名额：排到**这个账号**的队尾，等够 MIN_REQUEST_GAP_MS 再放行。
   * 排行榜批量刷新、推送轮询、用户查询同时到来时在这里自动错峰，
   * 而不是叠着打同一个 token；不同账号各排各的队，互不阻塞。
   *
   * 只管**发出节奏**，不等响应回来——响应时间不该算进间隔里，
   * 更不该让一个慢请求把后面所有人堵住。等响应、重试、换账号都在名额之外做。
   *
   * （原 `#acquireSlot`，被 utils/parallel.js 的注释引用着）
   *
   * @param {object|null} auth 本次请求要用的账号，队列按它分；拿不到账号时退化成一条公共队列
   */
  #acquireSlot (auth) {
    const key = toText(auth?.userId) || '__unknown__'
    const prev = this.#queueTailByUser.get(key) || Promise.resolve()

    const slot = prev.then(async () => {
      const last = this.#lastRequestAtByUser.get(key) || 0
      const wait = last + MIN_REQUEST_GAP_MS - Date.now()
      if (wait > 0) {
        await sleep(wait)
      }
      this.#lastRequestAtByUser.set(key, Date.now())
    })

    this.#queueTailByUser.set(key, slot.then(() => {}, () => {}))
    return slot
  }

  /**
   * 发一次真实 HTTP 请求：先领名额，再打出去。
   *
   * 关键是队列的粒度只到「一次 fetch」。早先是把整条「候选账号循环 × 重试链」
   * 塞进队列跑，于是一个超时（10s）+ 两次退避（1s、2s）的请求，最坏能独占队头
   * 三十多秒，期间全群所有查询都在后面干等。现在退避和换号都发生在名额之外，
   * 别人的请求可以正常插进空出来的节奏里。
   *
   * 冷却检查放在拿到名额之后：排队期间这个账号可能已被别的请求打到限流，
   * 这时立刻快速失败，不再打到营地接口加重频控。检查是**按账号**做的，
   * 传进来的 auth 决定查谁的冷却。
   *
   * 超时表也建在名额之后（见 REQUEST_TIMEOUT_MS 的注释）。返回的 `release`
   * 必须由调用方在**读完 response body 之后**调用：body 是流式的，
   * 提前 clearTimeout 会让「连上了但一直不给完整响应」这种情况失去保护。
   *
   * （原 `#gatedFetch`）
   *
   * @param {object|null} auth  本次请求使用的账号，冷却按它来查；不传则不查冷却
   * @returns {Promise<{response: Response, release: () => void}>}
   */
  async gatedFetch (url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS, auth = null) {
    await this.#acquireSlot(auth)
    this.#assertAvailable(auth)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, { ...options, signal: controller.signal })
      return { response, release: () => clearTimeout(timer) }
    } catch (error) {
      clearTimeout(timer)
      throw describeAbort(error, timeoutMs)
    }
  }
}

/* ==================================================== 签名与请求头 */

/**
 * 营地新版接口的签名与请求头。
 *
 * ⚠️ 这一层几乎全是**协议字面量**：header 名的大小写、字段顺序、
 * encodeParam 的加密方式，都是营地服务端认的。除了抽常量，别动别的。
 */
class CampRequestSigner {
  #baseUrls

  /**
   * ⚠️ 这里**读宿主（ApiService）当前的 `generatedXLogUid`**，而不是自己存一份。
   *
   * 原版 `#getXLogUid` 读的就是 `this.generatedXLogUid`（ApiService 的实例属性），
   * 所以外部改写 `api.generatedXLogUid` 会立刻生效。自己存一份就成了
   * 「构造时快照」——现在没人这么改，但那是实打实的行为差异。
   * 传函数而不是传值，正是为了让它每次现取。
   */
  #hostXLogUid

  constructor (baseUrls, hostXLogUid) {
    this.#baseUrls = baseUrls
    this.#hostXLogUid = hostXLogUid
  }

  /** 这个账号该用哪个 x-log-uid（原 `#getXLogUid`） */
  #xLogUid (auth) {
    return auth.xLogUid || this.#hostXLogUid()
  }

  /** 链路追踪头。auth 里带了就照用，没带现造一个（原 `#buildTraceparent`） */
  #traceparent (auth) {
    if (auth.traceparent) {
      return auth.traceparent
    }

    const traceId = crypto.randomBytes(16).toString('hex')
    const spanId = crypto.randomBytes(8).toString('hex')
    return `00-${traceId}-${spanId}-01`
  }

  /** 带服务端时间偏移的「当前时间」（原 `#getTimestamp`） */
  #timestamp (auth) {
    return Date.now() + auth.serverTimeOffsetMs
  }

  /** 随机 nonce：`${prefix}${uuid去横线}:${timestamp}`（原 `#buildNonce`） */
  #nonce (prefix, timestamp) {
    const random = crypto.randomUUID().replace(/-/g, '')
    return `${prefix}${random}:${timestamp}`
  }

  /** encodeRes 用公钥解出明文（原 `#decodeEncodeRes`） */
  #decodeEncodeRes (auth) {
    if (!auth.encodeRes) {
      return null
    }

    let decrypted
    try {
      decrypted = crypto.publicDecrypt(
        {
          key: buildPublicKeyPem(auth.publicKey),
          padding: crypto.constants.RSA_PKCS1_PADDING
        },
        Buffer.from(auth.encodeRes, 'base64')
      )
    } catch (error) {
      // 坏 base64 / 坏 RSA 数据时，原生报错是 OpenSSL 的 `bad decrypt` 原文——
      // 既看不懂，也不会被当成鉴权问题换号，账号就卡在这一个错上反复撞。
      // 包成 AuthAccountError：这是「这个号的 encodeRes 本身有问题」，可标记、可换号。
      throw new AuthAccountError(`encodeRes 无法解密（公钥解 RSA 失败: ${error.message}），请重新登录该账号`)
    }

    try {
      return JSON.parse(decrypted.toString('utf8'))
    } catch (error) {
      throw new AuthAccountError(`encodeRes 无法解密（解出的内容不是 JSON: ${error.message}），请重新登录该账号`)
    }
  }

  /**
   * 拿 userKey：auth 里有就直接用，没有就从 encodeRes 里解（原 `#resolveUserKey`）。
   * 响应体解密（CampResponseReader）也要用它，所以是公开方法。
   */
  resolveUserKey (auth) {
    if (auth.userKey) {
      return auth.userKey
    }

    const encodeRes = this.#decodeEncodeRes(auth)
    return encodeRes?.userKey || ''
  }

  /**
   * 生成新版营地接口的 encodeParam。
   * 请求体为 { timestamp, nonce }，再使用 userKey 进行 XXTEA 加密并 Base64 编码。
   * userKey 拿不到时返回空串，调用方改走 specialEncodeParam（原 `#generateEncodeParam`）。
   */
  #encodeParam (auth) {
    const userKey = this.resolveUserKey(auth)
    if (!userKey) {
      return ''
    }

    const timestamp = this.#timestamp(auth)
    const payload = JSON.stringify({
      timestamp,
      nonce: this.#nonce(`${auth.userId}:`, timestamp)
    })

    return xxteaEncrypt(Buffer.from(payload, 'utf8'), Buffer.from(userKey, 'utf8')).toString('base64')
  }

  /**
   * 没有 userKey 时的兜底签名：payload 直接 RSA 公钥加密（原 `#generateSpecialEncodeParam`）。
   * ⚠️ 和 encodeParam 的 nonce 前缀不同（这里没有 userId），别统一。
   */
  #specialEncodeParam (auth) {
    const timestamp = this.#timestamp(auth)
    const payload = JSON.stringify({
      timestamp,
      nonce: this.#nonce(':', timestamp)
    })

    return crypto.publicEncrypt(
      {
        key: buildPublicKeyPem(auth.publicKey),
        padding: crypto.constants.RSA_PKCS1_PADDING
      },
      Buffer.from(payload, 'utf8')
    ).toString('base64')
  }

  /** 两个域名共用的头（原 `#getCommonHeaders`） */
  #commonHeaders (auth, url) {
    const headers = {
      Host: url.includes(this.#baseUrls.main) ? HOST_MAIN : HOST_GAME,
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': auth.userAgent,
      'Content-Encrypt': auth.contentEncrypt,
      'Accept-Encrypt': auth.acceptEncrypt,
      NOENCRYPT: auth.noEncrypt,
      'X-Client-Proto': auth.xClientProto,
      'x-log-uid': this.#xLogUid(auth)
    }

    headers.traceparent = this.#traceparent(auth)

    return headers
  }

  /**
   * 主站 JSON 接口的鉴权头（原 `#getAuthHeaders`）。
   *
   * ⚠️ 字段名全是**小写无分隔**的营地私有头，别按常规驼峰「修正」它们。
   * `...auth.extraHeaders` 放在最后，主人的自定义头可以覆盖任意一项。
   */
  authHeaders (auth, url) {
    const headers = {
      ...this.#commonHeaders(auth, url),
      istrpcrequest: auth.isTrpcRequest,
      cchannelid: auth.cChannelId,
      cclientversioncode: auth.cClientVersionCode,
      cclientversionname: auth.cClientVersionName,
      ccurrentgameid: auth.cCurrentGameId,
      cgameid: auth.cGameId,
      cgzip: auth.cGzip,
      cisarm64: auth.cIsArm64,
      crand: String(Date.now()),
      csupportarm64: auth.cSupportArm64,
      csystem: auth.cSystem,
      csystemversioncode: auth.cSystemVersionCode,
      csystemversionname: auth.cSystemVersionName,
      cpuhardware: auth.cpuHardware,
      gameareaid: auth.gameAreaId,
      gameid: auth.cGameId,
      gameusersex: auth.gameUserSex,
      tinkerid: auth.tinkerId,
      token: auth.token,
      userid: auth.userId,
      kohdimgender: auth.kohDimGender,
      ...auth.extraHeaders
    }

    if (auth.openId) {
      headers.openid = auth.openId
    }

    if (auth.gameOpenId) {
      headers.gameopenid = auth.gameOpenId
    }

    if (auth.gameRoleId) {
      headers.gameroleid = auth.gameRoleId
    }

    if (auth.gameServerId) {
      headers.gameserverid = auth.gameServerId
    }

    const encodeParam = this.#encodeParam(auth)
    if (encodeParam) {
      headers.encodeParam = encodeParam
    } else {
      headers.specialEncodeParam = this.#specialEncodeParam(auth)
    }

    return headers
  }

  /**
   * 游戏侧 form 接口的头（原 `#getGameFormHeaders`）。
   *
   * ⚠️ 和主站那套**不是同一个东西**：名字全小写、`content-encrypt` 是空串、
   * 而且没有 traceparent / crand。别为了「统一」把它们合并。
   */
  gameFormHeaders (auth) {
    return {
      Host: HOST_GAME_FORM,
      'content-encrypt': '',
      'accept-encrypt': '',
      noencrypt: '1',
      'x-client-proto': auth.xClientProto,
      'x-log-uid': this.#xLogUid(auth),
      kohdimgender: auth.kohDimGender,
      'content-type': 'application/x-www-form-urlencoded',
      'accept-encoding': 'gzip',
      'user-agent': auth.userAgent,
      token: auth.token,
      userid: auth.userId
    }
  }

  /** 游戏侧 form 接口的请求体（原 `#buildGameFormBody`）。
   *
   * ⚠️ 表单体里含 token / userId，**每个候选账号都要现建一份**，不能跨账号复用。
   * openId 缺失时用宿主的 generatedXLogUid 兜底（营地对这个字段不校验内容，只要求非空）。
   */
  gameFormBody (auth, extraFields = {}) {
    const fields = {
      cChannelId: auth.cChannelId,
      cClientVersionCode: auth.cClientVersionCode,
      cClientVersionName: auth.cClientVersionName,
      cCurrentGameId: auth.cCurrentGameId,
      cGameId: auth.cGameId,
      cGzip: auth.cGzip,
      cIsArm64: auth.cIsArm64,
      cRand: String(Date.now()),
      cSupportArm64: auth.cSupportArm64,
      cSystem: auth.cSystem,
      cSystemVersionCode: auth.cSystemVersionCode,
      cSystemVersionName: auth.cSystemVersionName,
      cpuHardware: auth.cpuHardware,
      gameAreaId: auth.gameAreaId,
      gameId: auth.cGameId,
      gameRoleId: toText(auth.gameRoleId) || '0',
      gameServerId: toText(auth.gameServerId) || '0',
      gameUserSex: auth.gameUserSex,
      openId: auth.openId || this.#hostXLogUid(),
      tinkerId: auth.tinkerId,
      token: auth.token,
      userId: auth.userId,
      ...extraFields
    }

    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(fields)) {
      params.append(key, toText(value))
    }

    return params.toString()
  }
}

/* ======================================================== 响应解析 */

/**
 * 营地响应的读取与解密。
 *
 * 主站和游戏侧 form 的响应形态不同，所以只覆盖主站那一套；
 * 表单那边是裸 JSON、没有 returnCode 包装，在 CampTransport 里单独读。
 */
class CampResponseReader {
  #signer

  constructor (signer) {
    this.#signer = signer
  }

  /**
   * 营地接口在 campencrypt=true 时，响应体会被 userKey 加密（原 `#decryptCampResponse`）。
   */
  #decryptCampResponse (text, auth) {
    const userKey = this.#signer.resolveUserKey(auth)
    if (!userKey) {
      throw new AuthConfigError('接口响应已加密，但当前登录态缺少 userKey 或 encodeRes')
    }

    const decrypted = xxteaDecrypt(
      Buffer.from(text.trim(), 'base64'),
      Buffer.from(userKey, 'utf8')
    )

    return decrypted.toString('utf8').replace(/\0+$/g, '')
  }

  /**
   * 统一解析接口响应。
   * 这里会优先识别安全层错误，再按需解密响应体。
   *
   * （原 `#parseResponse`）
   */
  async read (response, auth, context = {}) {
    const encryptParamErr = response.headers.get('encryptparamerr') || response.headers.get('encryptParamErr')
    if (encryptParamErr) {
      throw new AuthConfigError(`接口安全参数校验失败 (encryptParamErr=${encryptParamErr})，请更新当前账号的 token / userKey / encodeRes 或客户端参数`)
    }

    const returnCode = response.headers.get('returncode') || response.headers.get('returnCode')
    const returnMsg = decodeHeaderValue(response.headers.get('returnmsg') || response.headers.get('returnMsg'))

    const text = await response.text()
    const payloadText = response.headers.get('campencrypt') === 'true'
      ? this.#decryptCampResponse(text, auth)
      : text

    logger.debug('[王者接口] 原始响应调试', {
      endpoint: context.endpoint || '',
      method: context.method || '',
      status: response.status,
      ok: response.ok,
      campencrypt: response.headers.get('campencrypt') || '',
      encryptMode: response.headers.get('encryptmode') || response.headers.get('encryptMode') || '',
      returnCode,
      returnMsg,
      rawTextPreview: previewValue(text),
      payloadPreview: previewValue(payloadText)
    })

    // 业务错误（频控 -30107、主页隐藏 -10107 等）常表现为空响应体 + header 里的 returnCode。
    // headers.get 返回字符串，统一转成数字，和响应体解析出来的 returnCode 保持同类型
    if (!payloadText && returnCode) {
      return {
        returnCode: Number(returnCode),
        returnMsg
      }
    }

    try {
      const parsed = parseJson(payloadText)
      logger.debug('[王者接口] 响应解析结果', {
        endpoint: context.endpoint || '',
        method: context.method || '',
        status: response.status,
        parsedPreview: previewValue(parsed)
      })
      return parsed
    } catch (error) {
      logger.error(`[王者接口] 解析响应失败: ${error.message}`, {
        status: response.status,
        endpoint: context.endpoint || '',
        method: context.method || '',
        returnCode,
        returnMsg,
        preview: payloadText?.slice(0, 200)
      })
      throw new Error('接口返回无法解析，请检查当前使用账号的安全参数是否完整')
    }
  }
}

/* ======================================================= 鉴权会话 */

/**
 * 鉴权配置的构建、候选账号的挑选与轮转、失效标记、以及给用户看的错误文案。
 *
 * 这一层是「账号」维度的全部逻辑，不碰 HTTP。
 */
class CampAuthSession {
  /**
   * 全局账号之间的轮询游标。多个全局账号时，请求挨个换号发（见 #rotateGlobals），
   * 单号请求量降到 1/N，配合按账号分的请求队列才谈得上并发。
   */
  #globalCursor = 0

  /**
   * 读取营地鉴权配置。
   * auth.yaml 只保留策略开关和请求默认值，实际登录态统一来自 AuthPool.json。
   *
   * （原 `#getBaseAuthConfig`）
   */
  #baseConfig () {
    const auth = Config.getDefOrConfig('auth') || {}
    const extraHeaders = auth.extraHeaders && typeof auth.extraHeaders === 'object'
      ? auth.extraHeaders
      : {}

    return {
      gameAreaId: toText(auth.gameAreaId || 1),
      gameUserSex: toText(auth.gameUserSex || 1),
      kohDimGender: toText(auth.kohDimGender || 2),
      serverTimeOffsetMs: Number(auth.serverTimeOffsetMs || 0),
      userAgent: toText(auth.userAgent || 'okhttp/4.9.1'),
      xClientProto: toText(auth.xClientProto || 'https'),
      contentEncrypt: toText(auth.contentEncrypt),
      acceptEncrypt: toText(auth.acceptEncrypt),
      noEncrypt: toText(auth.noEncrypt ?? 1),
      isTrpcRequest: toText(auth.isTrpcRequest ?? true),
      cChannelId: toText(auth.cChannelId || '10003391'),
      cClientVersionCode: toText(auth.cClientVersionCode || '2057957801'),
      cClientVersionName: toText(auth.cClientVersionName || '10.111.0323'),
      cCurrentGameId: toText(auth.cCurrentGameId || '20001'),
      cGameId: toText(auth.cGameId || '20001'),
      cGzip: toText(auth.cGzip ?? 1),
      cIsArm64: toText(auth.cIsArm64 ?? true),
      cSupportArm64: toText(auth.cSupportArm64 ?? true),
      cSystem: toText(auth.cSystem || 'android'),
      cSystemVersionCode: toText(auth.cSystemVersionCode || '34'),
      cSystemVersionName: toText(auth.cSystemVersionName || '14'),
      cpuHardware: toText(auth.cpuHardware || 'qcom'),
      tinkerId: toText(auth.tinkerId || '2057957801_64_0'),
      publicKey: toText(auth.publicKey || DEFAULT_PUBLIC_KEY),
      extraHeaders
    }
  }

  /** 空值（null / undefined / 空串）取兜底，其余原样（原 `#pickAuthValue`） */
  #pickValue (value, fallback) {
    if (value === null || typeof value === 'undefined' || value === '') {
      return fallback
    }

    return value
  }

  /**
   * 把池里的账号 + auth.yaml 默认值合成一次请求真正要用的配置（原 `#buildAuthConfig`）。
   *
   * 账号自己的值优先，缺了才用默认值；`extraHeaders` 是**合并**而不是覆盖。
   */
  buildConfig (auth = {}, baseAuth = this.#baseConfig()) {
    const extraHeaders = {
      ...(baseAuth.extraHeaders && typeof baseAuth.extraHeaders === 'object' ? baseAuth.extraHeaders : {}),
      ...(auth.extraHeaders && typeof auth.extraHeaders === 'object' ? auth.extraHeaders : {})
    }

    return {
      ...baseAuth,
      ...auth,
      enabled: true,
      token: toText(auth.token),
      userId: toText(auth.userId),
      openId: toText(auth.openId),
      gameOpenId: toText(auth.gameOpenId),
      gameRoleId: toText(auth.gameRoleId),
      gameServerId: toText(auth.gameServerId),
      gameAreaId: toText(this.#pickValue(auth.gameAreaId, baseAuth.gameAreaId || 1)),
      gameUserSex: toText(this.#pickValue(auth.gameUserSex, baseAuth.gameUserSex || 1)),
      kohDimGender: toText(this.#pickValue(auth.kohDimGender, baseAuth.kohDimGender || 2)),
      userKey: toText(auth.userKey),
      encodeRes: toText(auth.encodeRes),
      serverTimeOffsetMs: Number(this.#pickValue(auth.serverTimeOffsetMs, baseAuth.serverTimeOffsetMs || 0)),
      xLogUid: toText(auth.xLogUid),
      traceparent: toText(auth.traceparent),
      userAgent: toText(this.#pickValue(auth.userAgent, baseAuth.userAgent || 'okhttp/4.9.1')),
      xClientProto: toText(this.#pickValue(auth.xClientProto, baseAuth.xClientProto || 'https')),
      contentEncrypt: toText(this.#pickValue(auth.contentEncrypt, baseAuth.contentEncrypt)),
      acceptEncrypt: toText(this.#pickValue(auth.acceptEncrypt, baseAuth.acceptEncrypt)),
      noEncrypt: toText(this.#pickValue(auth.noEncrypt, baseAuth.noEncrypt ?? 1)),
      isTrpcRequest: toText(this.#pickValue(auth.isTrpcRequest, baseAuth.isTrpcRequest ?? true)),
      cChannelId: toText(this.#pickValue(auth.cChannelId, baseAuth.cChannelId || '10003391')),
      cClientVersionCode: toText(this.#pickValue(auth.cClientVersionCode, baseAuth.cClientVersionCode || '2057957801')),
      cClientVersionName: toText(this.#pickValue(auth.cClientVersionName, baseAuth.cClientVersionName || '10.111.0323')),
      cCurrentGameId: toText(this.#pickValue(auth.cCurrentGameId, baseAuth.cCurrentGameId || '20001')),
      cGameId: toText(this.#pickValue(auth.cGameId, baseAuth.cGameId || '20001')),
      cGzip: toText(this.#pickValue(auth.cGzip, baseAuth.cGzip ?? 1)),
      cIsArm64: toText(this.#pickValue(auth.cIsArm64, baseAuth.cIsArm64 ?? true)),
      cSupportArm64: toText(this.#pickValue(auth.cSupportArm64, baseAuth.cSupportArm64 ?? true)),
      cSystem: toText(this.#pickValue(auth.cSystem, baseAuth.cSystem || 'android')),
      cSystemVersionCode: toText(this.#pickValue(auth.cSystemVersionCode, baseAuth.cSystemVersionCode || '34')),
      cSystemVersionName: toText(this.#pickValue(auth.cSystemVersionName, baseAuth.cSystemVersionName || '14')),
      cpuHardware: toText(this.#pickValue(auth.cpuHardware, baseAuth.cpuHardware || 'qcom')),
      tinkerId: toText(this.#pickValue(auth.tinkerId, baseAuth.tinkerId || '2057957801_64_0')),
      publicKey: toText(this.#pickValue(auth.publicKey, baseAuth.publicKey || DEFAULT_PUBLIC_KEY)),
      extraHeaders
    }
  }

  /** 打码后的账号快照，只进日志（原 `#buildAuthDebugInfo`） */
  #debugInfo (auth = {}, source = '', label = '') {
    return {
      source,
      label,
      userId: toText(auth.userId),
      token: maskValue(auth.token),
      userKey: maskValue(auth.userKey),
      encodeRes: maskValue(auth.encodeRes),
      openId: maskValue(auth.openId),
      gameOpenId: maskValue(auth.gameOpenId),
      gameRoleId: toText(auth.gameRoleId),
      gameServerId: toText(auth.gameServerId),
      gameAreaId: toText(auth.gameAreaId),
      gameUserSex: toText(auth.gameUserSex),
      kohDimGender: toText(auth.kohDimGender),
      isGlobalDefault: Boolean(auth.isGlobalDefault),
      priority: Number(auth.priority || 100),
      loginPlatform: toText(auth.loginPlatform),
      ownerBotUserId: toText(auth.ownerBotUserId),
      authInvalid: Boolean(auth.authInvalid),
      authErrorCount: Number(auth.authErrorCount || 0),
      lastAuthErrorAt: toText(auth.lastAuthErrorAt),
      lastAuthErrorMessage: toText(auth.lastAuthErrorMessage)
    }
  }

  /** 把错误文案里的账号 ID 打码（原 `#sanitizeAuthMessage`） */
  #sanitizeAuthMessage (message = '') {
    const text = toText(message)
    if (!text) {
      return ''
    }

    return text
      .replace(/(全局账号|目标账号)\s*(\d{5,})/g, (_, label, userId) => `${label} ${maskUserId(userId)}`)
      .replace(/(默认全局账号)\s*(\d{5,})/g, (_, label, userId) => `${label} ${maskUserId(userId)}`)
  }

  /** 这条错误涉不涉及鉴权（决定要不要「请联系主人处理」）（原 `#isSensitiveAuthError`） */
  #isSensitiveAuthError (error) {
    const message = toText(error?.message)
    if (error instanceof AuthConfigError) {
      return true
    }

    return /营地登录态|全局账号|目标账号|token|userKey|encodeRes|登录失效|重新登录|未找到可用的营地登录态|鉴权|安全参数/i.test(message)
  }

  /**
   * 把任意异常转成能直接发给用户的一段话。
   *
   * 鉴权类错误**不能原样透给群友**（里面可能带账号、带登录态线索），
   * 非主人一律只说「联系主人」；主人那边才给具体原因和处理建议。
   *
   * （原 `formatUserFacingError`，被 15 个 app 调用）
   */
  formatUserFacingError (error, options = {}) {
    const {
      isMaster = false,
      scene = '营地登录异常'
    } = options
    const rawMessage = toText(error?.message)
    const sanitizedMessage = this.#sanitizeAuthMessage(rawMessage)
    const isSensitive = this.#isSensitiveAuthError(error)

    if (!isSensitive) {
      return sanitizedMessage || `请求失败，请稍后再试。\n可发送：#联系主人 + ${scene}`
    }

    if (!isMaster) {
      return [
        '当前营地鉴权异常，请联系主人处理。',
        `可发送：#联系主人 + ${scene}`
      ].join('\n')
    }

    const lines = [
      sanitizedMessage || '当前营地鉴权异常，请检查登录态配置。'
    ]

    if (/全局账号|默认全局账号/i.test(rawMessage)) {
      lines.push('处理建议：可使用【#营地wx全局登录】或【#营地QQ全局登录】重新扫码更新全局账号。')
    } else if (/未找到可用的营地登录态/i.test(rawMessage)) {
      lines.push('处理建议：可先通过【#营地wx全局登录】或【#营地QQ全局登录】补充登录态，或在锅巴账号列表中配置可用账号。')
    } else {
      lines.push('处理建议：可使用【#营地wx全局登录】或【#营地QQ全局登录】重新登录，或在锅巴账号列表中检查相关字段。')
    }

    return lines.join('\n')
  }

  /** 鉴权字段齐不齐（原 `#assertAuthReady`） */
  assertReady (auth) {
    const requiredFields = [
      ['token', 'token'],
      ['userId', 'userId']
    ]

    const missing = requiredFields
      .filter(([key]) => !auth[key])
      .map(([, label]) => label)

    if (!auth.userKey && !auth.encodeRes) {
      missing.push('userKey / encodeRes')
    }

    if (missing.length) {
      throw new AuthConfigError(`鉴权配置不完整，缺少字段: ${missing.join(', ')}`)
    }
  }

  /**
   * 把「全局账号」那一档按游标轮转一位，其余候选保持原序跟在后面。
   *
   * 池里有多个全局账号时，每个请求换一个号发：营地的限流按账号记，分摊之后
   * 单个号的请求量降到 1/N，配合同样按账号分的请求队列，并发才真正跑得起来。
   * 没有这一步的话候选永远从 priority 最高的那个开始试，等于所有请求都压在同一个号上，
   * 队列分成几条也没用。
   *
   * 候选池里现在就只有全局账号这一类（共享账号、个人兜底都已删），
   * 所以轮转的就是全部候选，顺序即「这次按什么顺序试」。
   *
   * （原 `#rotateGlobals`）
   *
   * @param {Array<object>} candidates authStore 给的候选（已按 priority 排好）
   * @returns {Array<object>} 轮转后的候选
   */
  #rotateGlobals (candidates) {
    const globals = candidates.filter(candidate => candidate.source === 'global')
    if (globals.length <= 1) return candidates

    const rest = candidates.filter(candidate => candidate.source !== 'global')
    const start = this.#globalCursor % globals.length
    this.#globalCursor += 1

    return [...globals.slice(start), ...globals.slice(0, start), ...rest]
  }

  /**
   * 只给**指定的那一个**账号，不做轮转。
   *
   * 签到这类接口必须用它，两个理由：
   *   · `candidates()` 是**轮转**的 —— 查 `/operation/action/signinfo` 会读到
   *     **别的号**的签到状态（5 个号轮流当队首，同一条指令两次结果可能不同）；
   *   · 签到动作更是直接改状态，拿错号去签等于替别人签。
   *
   * 账号不在池里 / 被标失效 / 密钥不全时返回**空数组**，调用方按「没有登录态」处理。
   *
   * @param {string} userId 账号池里的 userId（营地ID）
   * @returns {Array<{auth: object, source: string, label: string}>}
   */
  candidatesForAccount (userId) {
    const wanted = toText(userId)
    if (!wanted) return []

    const account = authStore.getAccount(wanted)
    if (!account || account.authInvalid || !isUsableAuth(account)) return []

    return [{
      auth: this.buildConfig(account, this.#baseConfig()),
      source: 'global',
      label: `指定账号 ${account.userId}`
    }]
  }

  /**
   * 本轮请求该按什么顺序试哪些账号。
   *
   * （原 `#getAuthCandidates`，被 utils/authStore.js 的注释引用着）
   */
  candidates (targetUserId, requesterBotUserId = '') {
    const baseAuth = this.#baseConfig()
    const candidates = authStore.getAuthCandidates(targetUserId)

    const mappedCandidates = candidates.map(candidate => ({
      ...candidate,
      auth: this.buildConfig(candidate.auth, baseAuth)
    }))

    // 先轮转再打日志：日志要反映**这次实际会按什么顺序试**，打轮转前的顺序
    // 会让人以为「每次都是同一个号打头」而去找轮询为什么没生效（实测踩过）。
    const rotated = this.#rotateGlobals(mappedCandidates)

    logger.debug('[王者接口] 本次请求鉴权候选列表', {
      targetUserId: toText(targetUserId),
      requesterBotUserId: toText(requesterBotUserId),
      candidates: rotated.map(candidate => this.#debugInfo(
        candidate.auth,
        candidate.source,
        candidate.label
      ))
    })

    return rotated
  }

  /** 标记这个候选账号失效（原 `#markCandidateAuthFailure`） */
  markFailure (candidate, message = '') {
    if (candidate?.source === 'global') {
      const state = authStore.markAuthFailure(candidate?.auth?.userId, message)
      if (state?.newlyInvalid) {
        void this.#notifyGlobalAuthInvalid(message, candidate)
      }
      return
    }

    authStore.markAuthFailure(candidate?.auth?.userId, message)
  }

  /** 这个候选账号这轮能用了（原 `#markCandidateAuthSuccess`） */
  markSuccess (candidate) {
    authStore.markAuthSuccess(candidate?.auth?.userId)
  }

  /** 私信主人「某个全局账号挂了」（原 `#notifyGlobalAuthInvalid`） */
  async #notifyGlobalAuthInvalid (message = '', candidate = null) {
    // 全局账号可能有好几个（轮询池），通知必须点明是哪一个挂了，
    // 否则主人收到「某个全局账号失效」也不知道该重扫哪个码。
    const label = candidate?.label || '全局账号'
    const sanitizedMessage = this.#sanitizeAuthMessage(message)
    const lines = [
      `王者插件的${label} 登录态已失效，后续请求会自动跳过该账号。`,
      sanitizedMessage ? `失效原因：${sanitizedMessage}` : '',
      '池子里还有其它可用全局账号的话，请求会继续用它们。',
      '可使用【#营地wx全局登录】或【#营地QQ全局登录】重新扫码更新全局 token。'
    ].filter(Boolean)

    // ⚠️⚠️ 必须走 utils/masterMsg.js 的 sendMaster，**不能**直接 await Bot.sendMasterMsg
    //    （2026-10-06 修）。`Bot.sendMasterMsg` 全失败也会 resolve 成功 —— 它内部塞进
    //    返回值里的 `ret[bot_id][user_id]` 是**没 await 的 promise**，外面那层 allSettled
    //    对它无效。直接 await 的话，「主人没加机器人好友」会表现为「日志里一片正常、
    //    主人什么都没收到」，正是 masterMsg.js 注释点名的「最难查的那类问题」；
    //    那些没人接管的 promise 一旦 reject 还会变成 unhandledRejection。
    //    同文件的另一条私信路径（markRateLimited → notifyAccountRateLimited）走的就是 sendMaster。
    const delivered = await sendMaster(lines.join('\n'))
    if (!delivered) {
      logger.warn('[王者接口] 全局账号失效提醒未能送达主人（检查机器人好友关系 / 适配器连接）')
    }
  }

  /**
   * 池里没被标记失效、且密钥齐全的账号（原 `#usableAccounts`）。
   *
   * 判据和 authStore.getAuthCandidates 是同一套（`isUsableAuth`），
   * 别在调用方另写一份。
   */
  usableAccounts () {
    return authStore.listAccounts().filter(account => !account?.authInvalid && isUsableAuth(account))
  }

  /**
   * 池里现在有几个能用的账号。
   *
   * 上层拿它估耗时（请求是**按账号并发**的，N 个号就是 N 路并行，
   * 见 CampRateLimiter.#acquireSlot），也用来判断「这次操作大概要等多久」。
   */
  usableCount () {
    return this.usableAccounts().length
  }
}

/* ======================================================= 请求编排 */

/**
 * 候选账号循环 + 重试 + 两种请求形态。
 *
 * 这一层只管「怎么把请求发出去、失败了怎么办」，不知道任何具体业务端点。
 */
class CampTransport {
  #rateLimiter
  #signer
  #reader
  #auth
  /**
   * ⚠️ 和 `ApiService.baseUrls` 是**同一个对象**（不是拷贝）。
   * 原版拼 URL 用的就是实例上的 `this.baseUrls.main` / `.game`，
   * 这里如果改成读模块常量，外部改了 `api.baseUrls` 就会静默失效。
   */
  #baseUrls

  constructor ({ rateLimiter, signer, reader, auth, baseUrls }) {
    this.#rateLimiter = rateLimiter
    this.#signer = signer
    this.#reader = reader
    this.#auth = auth
    this.#baseUrls = baseUrls
  }

  /**
   * 带重试的一次请求执行。主站 JSON 和游戏侧 form 只差四件事，都用参数注入：
   * 头怎么造、体怎么造、响应怎么读、HTTP 错误怎么措辞。
   *
   * ⚠️ 两处刻意的行为，别顺手「优化」掉：
   *   1. **headers 每次尝试现算**（crand 是 Date.now()、encodeParam 的 payload 里
   *      带 timestamp + nonce，退避 1~2 秒后拿旧签名重发等于「注定失败的重试」）；
   *      而 **body 在循环外只造一次**——表单体的 cRand / openId 是随机的，
   *      每试一次换一份会让服务端看到「同一个请求体内容在变」。
   *   2. `release()` 必须在**读完 body 之后**调用，否则「连上了但一直不给完整响应」
   *      就失去超时保护（见 CampRateLimiter.gatedFetch）。为此把 `release` 也传给
   *      `readData`：**游戏侧表单原版就是读完 text 立刻 release**（早于日志与解析），
   *      这里保持一致；外层 finally 再兜一次（clearTimeout 幂等，重复调用无害）。
   *
   * （原 `#requestWithAuth` / `#fetchGameForm` 两个几乎一样的重试循环合并而来）
   */
  async #executeWithRetry ({
    url,
    auth,
    retries,
    context,
    buildHeaders,
    buildBody,
    readData,
    describeHttpError,
    logLabel
  }) {
    const body = buildBody()

    for (let attempt = 0; attempt <= retries; attempt++) {
      const headers = buildHeaders()

      try {
        logger.debug(logLabel, buildRequestDebugInfo(
          context.method,
          url,
          headers,
          body,
          {
            ...context,
            attemptIndex: attempt
          }
        ))

        const { response, release } = await this.#rateLimiter.gatedFetch(url, {
          method: context.method,
          headers,
          body
        }, REQUEST_TIMEOUT_MS, auth)

        let data
        try {
          data = await readData(response, release)
        } finally {
          release()
        }

        if (!response.ok) {
          throw new Error(describeHttpError(response, data))
        }

        return data
      } catch (error) {
        // 频控和鉴权配置错误都不该重试：前者重试只会加重频控、把冷却翻倍，
        // 后者换多少次也还是缺字段
        if (attempt === retries || isFatalError(error)) {
          throw error
        }

        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt)
      }
    }
  }

  /**
   * 候选账号循环的公共骨架。
   *
   * 依次用候选账号发请求：账号级登录失效（AuthAccountError）就标记该账号并回退到下一个，
   * 全部失败则抛出最后一个错误；配置/系统级的 AuthConfigError（如 encryptParamErr）
   * 直接抛，不标记任何账号——换号对这种错没有意义，见 AuthAccountError 的注释。
   * 真正有差异的只有两件事——**怎么发请求**、**业务错误码怎么判定**，分别由 execute 和
   * onBusinessCode 注入；循环骨架、鉴权失败回退、频控冷却、成功后的状态更新两处完全一致。
   *
   * 候选列表的顺序由 authStore.getAuthCandidates 决定：多个全局账号时它是轮询旋转过的
   * （本轮该用的号在队首），所以「换号重试」同时也是「轮换到下一个账号」。
   *
   * （原 `#runWithCandidates`）
   *
   * @param {object} opts
   * @param {string} opts.url  实际请求地址（已含 baseUrl 前缀），只用于兜底日志
   * @param {Array} opts.candidates  CampAuthSession.candidates 的结果
   * @param {object} opts.context  { endpoint, method, targetUserId, requesterBotUserId }，用于日志
   * @param {(candidate: object) => Promise<any>} opts.execute  用指定候选账号发一次请求，返回响应 data
   * @param {(data: any, candidate: object, info: { isLast: boolean }) => object} opts.onBusinessCode
   *        判定响应 data 该怎么处理，返回下面四种之一：
   *        - { action: 'success' }              正常数据，走成功路径
   *        - { action: 'return', value }        原样交还给调用方（既不算成功也不算失败）
   *        - { action: 'retry', error, mark, reason }  当失败处理，mark 为真时标记该账号失效；
   *          还有候选就继续，没有则抛出 error
   *        - { action: 'rate-limit' }           命中频控 -30107
   * @param {object} [opts.errorLogExtra]  兜底 logger.error 的附加字段
   */
  async #runWithCandidates ({ url, candidates, context = {}, execute, onBusinessCode, errorLogExtra = {} }) {
    const { endpoint, method, targetUserId = '', requesterBotUserId = '' } = context
    let lastError = null
    // 本轮给哪些账号打过失效标记（{ userId, message, definite }），
    // 给循环结束后的「全候选同错 → 判定系统性问题、撤销标记」保险用。
    // definite = 这条标记来自确定性信号（-30003 / 响应体精确短语判定），
    // 撤销保险只看它：确定性的标记不撤，非确定性的（如 encodeRes 本地解密失败）可撤。
    const markedFailures = []

    // ⚠️⚠️ 本轮**因频控冷却被跳过**的候选数（2026-10-06 修）。
    //    下面那个「全候选同错 → 撤销失效标记」的保险，判据原来是
    //    `markedFailures.length >= candidates.length`，而冷却分支只 warn + continue/break，
    //    **不往 markedFailures 里写**。于是只要池里有**任意一个**号还在冷却里
    //    （`RATE_LIMIT_SILENCE_MS` 是 12 小时，被 -30107 打中的号会留在候选池里整整半天，
    //    所以「池里至少一个号在冷却」在线上是常态），判据就恒为 false，**整段保险是死代码**。
    //    线上日志 `grep -c '撤销本轮失效标记'` 两个流都是 0，上线以来一次都没执行过。
    //    后果：整池账号因同一个系统性原因失败时（注释点名的 encodeRes 导坏场景），
    //    保险不会执行，全池被误标 authInvalid，**所有用户的查询一起失败**。
    //
    //    修法：把被冷却跳过的候选也算进「本轮参与判定的候选」。
    //    **不能**往 markedFailures 里 push 占位记录 —— 冷却文案与失败文案不同，
    //    会破坏下面 `uniform`（同因）的判定。
    let skippedByCooldown = 0

    const markCandidateFailure = (candidate, message, definite = false) => {
      markedFailures.push({ userId: toText(candidate?.auth?.userId), message: toText(message), definite: Boolean(definite) })
      this.#auth.markFailure(candidate, message)
    }

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const isLast = index >= candidates.length - 1

      // 这个号还在频控冷却里：跳过它，改用下一个候选，不占请求名额。
      //
      // 必须在 try 之前判：冷却时 gatedFetch 会抛 RateLimitError，一旦落到下面的
      // catch，会被当作「非鉴权错误」直接 break 掉整个循环，后面的候选就没机会了。
      const cooldownLeft = this.#rateLimiter.cooldownLeft(candidate.auth)
      if (cooldownLeft > 0) {
        lastError = new RateLimitError(`营地接口暂时被限流，约 ${describeWait(cooldownLeft)}后恢复，请稍后再试`)
        logger.warn(`[王者接口] ${candidate.label} 仍在频控冷却中，暂时跳过它`)

        // 记进「被跳过」计数，撤销保险的判据要把它算上（见上面的说明）
        skippedByCooldown += 1

        if (!isLast) {
          continue
        }

        break
      }

      try {
        logger.debug('[王者接口] 尝试使用鉴权账号发起请求', {
          endpoint,
          method,
          targetUserId: toText(targetUserId),
          requesterBotUserId: toText(requesterBotUserId),
          attemptIndex: index,
          auth: {
            source: candidate.source,
            label: candidate.label,
            userId: toText(candidate.auth.userId),
            isGlobalDefault: Boolean(candidate.auth.isGlobalDefault),
            priority: Number(candidate.auth.priority || 100)
          }
        })

        this.#auth.assertReady(candidate.auth)
        const data = await execute(candidate)
        const decision = onBusinessCode(data, candidate, { isLast })

        if (decision.action === 'return') {
          return decision.value
        }

        if (decision.action === 'rate-limit') {
          // 只冷却触发频控的这个号，然后换下一个候选——池子里还有好号就不该整体停摆
          const cooldown = this.#rateLimiter.markRateLimited(candidate.auth, this.#auth.usableCount())
          lastError = new RateLimitError(`营地接口操作频繁(-30107)，该账号已暂停 ${describeWait(cooldown)}，请稍后再试`)

          if (isLast) {
            break
          }

          logger.warn(`[王者接口] ${candidate.label} 命中频控，暂时禁用该账号，改用下一个`, {
            endpoint,
            targetUserId,
            requesterBotUserId,
            cooldownMs: cooldown
          })
          continue
        }

        if (decision.action === 'retry') {
          lastError = decision.error

          if (decision.mark) {
            // 业务码路径的 mark:true 只在 isDefiniteAuthFailure 命中时给出
            // （-30003 / 响应体精确短语），所以这里的标记恒为确定性（definite）
            markCandidateFailure(candidate, decision.error.message, true)
          }

          logger.warn(`[王者接口] ${candidate.label} ${decision.reason || '鉴权异常'}，${isLast ? '且没有更多可回退账号' : '尝试回退到下一个账号'}`, {
            endpoint,
            targetUserId,
            requesterBotUserId,
            error: decision.error.message
          })

          // 最后一轮刻意 break 而不是 throw：抛出去会被下面自己的 catch 接住，
          // 把同一个账号同一原因再标记一次，让 authErrorCount 白涨。
          // 直接跳出，交给循环外统一抛最后一个错误。
          if (isLast) {
            break
          }

          continue
        }

        // 成功。只清这个号自己的冷却——冷却是按账号记的，
        // 这个号能用不代表池里其他号也解除了限制。
        this.#rateLimiter.clearRateLimit(candidate.auth)
        this.#auth.markSuccess(candidate)

        logger.debug('[王者接口] 请求成功，当前使用鉴权账号', {
          endpoint,
          method,
          targetUserId: toText(targetUserId),
          requesterBotUserId: toText(requesterBotUserId),
          auth: {
            source: candidate.source,
            label: candidate.label,
            userId: toText(candidate.auth.userId)
          }
        })

        return data
      } catch (error) {
        lastError = error

        // 这个号在这轮里被标了冷却（典型是排队期间另一个请求刚把它打到限流，
        // gatedFetch 里的 #assertAvailable 于是抛了出来）：换下一个候选，
        // 别因为一个号被限流就中断整个循环。
        if (!isLast && error instanceof RateLimitError) {
          logger.warn(`[王者接口] ${candidate.label} 已被限流，改用下一个账号`, {
            endpoint,
            targetUserId,
            requesterBotUserId
          })
          continue
        }

        // 只有「确实是这个账号的登录态失效」（AuthAccountError）才标记并换号。
        // AuthConfigError 一类的配置/系统错误（如 encryptParamErr = 营地不认客户端
        // 版本号）换多少个号都是同样的错，直接抛给上层，一个账号都不标——
        // 否则 cClientVersionCode 失效一次，全池账号会挨个被撞下来团灭。
        if (!isLast && error instanceof AuthAccountError) {
          // definite=false：能抛到这儿的 AuthAccountError 来自请求**本地**预处理
          // （目前只有 #decodeEncodeRes 的 encodeRes 解密失败），不是营地服务端给的
          // 确定性失效信号——整池账号若共用同一份导坏的 encodeRes，就会被这道本地错
          // 同文案团灭，撤销保险必须能把它撤回来
          markCandidateFailure(candidate, error.message, false)
          logger.warn(`[王者接口] ${candidate.label} 登录态失效，尝试回退到下一个账号`, {
            endpoint,
            targetUserId,
            requesterBotUserId,
            error: error.message
          })
          continue
        }

        if (error instanceof AuthAccountError) {
          markCandidateFailure(candidate, error.message, false)   // 同上：本地预处理错，非确定性
        }

        break
      }
    }

    // 保险：本轮打过失效标记的账号不止一个，且**所有**候选都以（去掉账号 ID 等
    // 数字后）相同的原因失败——这种形状基本是配置/系统问题（比如客户端参数失效
    // 在每个号上表现一致），而不是一排账号恰好同时失效。
    // 把本轮新标掉的 authInvalid 撤回来，免得同一类系统错分批团灭全池。
    // ⚠️ 例外：只要有一条标记是确定性的（definite，来自 -30003 / 响应体精确短语），
    //    那是 token 真的死了，标记该留。
    // ⚠️ 判定不能用最终错误文案匹配精确短语：业务码路径（「登录态失效(returnCode=…)」）
    //    和 encodeRes 解密失败（「请重新登录该账号」）的文案都自带触发词，
    //    用文案匹配恒为 true、撤销永不执行（旧实现就是这个死代码）；必须用打标记时
    //    记下的 definite 布尔。
    // ⚠️⚠️ 判据必须把 `skippedByCooldown` 算上（2026-10-06 修）：
    //    被冷却跳过的候选不写 markedFailures，只算 markedFailures.length 的话，
    //    池里只要有一个号在冷却（线上常态），这条保险就恒不成立、永远是死代码。
    //    加上之后，只有当「失败数 + 跳过数」覆盖了全部候选时才会判定同因。
    const consideredCount = markedFailures.length + skippedByCooldown
    if (markedFailures.length > 1 && consideredCount >= candidates.length) {
      const normalized = markedFailures.map(failure => failure.message.replace(/\d+/g, ''))
      const uniform = normalized.every(text => text === normalized[0])
      const anyDefinite = markedFailures.some(failure => failure.definite)

      if (uniform && !anyDefinite) {
        logger.error('[王者接口] 全部候选账号以相同原因失败，判定为配置/系统问题，已撤销本轮失效标记', {
          endpoint,
          targetUserId: toText(targetUserId),
          requesterBotUserId: toText(requesterBotUserId),
          message: markedFailures[0].message,
          skippedByCooldown,
          markedUserIds: markedFailures.map(failure => failure.userId)
        })

        for (const failure of markedFailures) {
          authStore.unmarkAuthFailure(failure.userId, failure.message)
        }
      }
    }

    if (lastError) {
      logger.error(`API请求失败: ${lastError.message}`, {
        url,
        method,
        targetUserId,
        requesterBotUserId,
        ...errorLogExtra
      })
      throw lastError
    }
  }

  /**
   * 主站 JSON 接口（`baseUrls.main`）。
   *
   * 这里不做频控预检：冷却已经按账号记，此刻还没选账号，判断不了该查谁。
   * 冷却中的号由 #runWithCandidates 逐个跳过，而跳过发生在发请求之前，
   * 和原先「连队都不排」的效果一致。
   *
   * 真正的错峰在 CampRateLimiter.gatedFetch 里按「每次 fetch」做，而不是把整条
   * 候选账号循环 × 重试链塞进队列——那样一个慢请求会独占队头几十秒。
   *
   * （原 `#requestWithCandidates`）
   */
  async requestWithCandidates (method, endpoint, body = null, additionalHeaders = {}, retries = 2, targetUserId = '', requesterBotUserId = '', options = {}) {
    const url = `${this.#baseUrls.main}${endpoint}`
    // options.accountId：只发**指定的那一个**账号、不轮转。签到这类
    // 「状态绑在具体账号上」的接口必须走它，否则会读到 / 改到别的号。
    const candidates = options.accountId
      ? this.#auth.candidatesForAccount(options.accountId)
      : this.#auth.candidates(targetUserId, requesterBotUserId)

    if (!candidates.length) {
      throw new AuthConfigError('未找到可用的营地登录态，请先完成营地登录，或在账号池中配置一个可用的全局账号')
    }

    return this.#runWithCandidates({
      url,
      candidates,
      context: { endpoint, method, targetUserId, requesterBotUserId },
      // 主站接口的兜底日志历来带 body，保持原样
      errorLogExtra: { body: JSON.stringify(body) },
      execute: candidate => this.#executeWithRetry({
        url,
        auth: candidate.auth,
        retries,
        context: {
          endpoint,
          method,
          targetUserId: toText(targetUserId),
          requesterBotUserId: toText(requesterBotUserId)
        },
        buildHeaders: () => ({
          ...this.#signer.authHeaders(candidate.auth, url),
          ...additionalHeaders
        }),
        buildBody: () => (body ? JSON.stringify(body) : null),
        // 不收 release：主站是「解析完再 release」，由外层 finally 兜
        readData: response => this.#reader.read(response, candidate.auth, {
          endpoint,
          method,
          targetUserId: toText(targetUserId),
          requesterBotUserId: toText(requesterBotUserId)
        }),
        describeHttpError: (response, data) =>
          `HTTP ${response.status}: ${data.message || data.returnMsg || response.statusText}`,
        logLabel: '[王者接口] 请求参数调试'
      }),
      onBusinessCode: (data, candidate) => {
        const businessCode = Number(data?.returnCode)
        const kind = classifyBusinessCode(businessCode)

        // 频控必须**最先**判。它的 returnMsg 有时也带「登录」「操作频繁」这类字样，
        // 若排在失效判定后面，就会被误判成登录失效，
        // 把这个该进冷却的号错标成 authInvalid。
        if (kind === BUSINESS_CODE.RATE_LIMITED) {
          return { action: 'rate-limit' }
        }

        // 确定性登录失效（-30003 / 精确短语）：标记这个号后换下一个
        if (isDefiniteAuthFailure(data)) {
          return {
            action: 'retry',
            mark: true,
            reason: '登录态失效',
            error: new AuthAccountError(`${candidate.label} 登录态失效(returnCode=${businessCode}): ${data.returnMsg || data.message || data.msg || ''}`.trim())
          }
        }

        // 只是文案疑似和鉴权沾边（含 token/鉴权/权限 等宽泛词）：**不标记账号**——
        // 账号多半是好的，只是这句文案撞了关键词；只记日志，换下一个号试试。
        if (isSuspectedAuthFailure(data)) {
          logger.warn(`[王者接口] ${candidate.label} 返回疑似鉴权相关文案（不标记账号）: ${data.returnMsg || data.message || data.msg || ''}`.trim(), {
            endpoint,
            targetUserId: toText(targetUserId),
            requesterBotUserId: toText(requesterBotUserId),
            returnCode: businessCode
          })
          return {
            action: 'retry',
            mark: false,
            reason: '疑似鉴权相关文案（未标记）',
            error: new AuthConfigError(`${candidate.label} 返回疑似鉴权相关响应: ${data.returnMsg || data.message || data.msg}`)
          }
        }

        // 主页被隐藏：把**被查的玩家**标注下来，24 小时内主动取数不再碰它
        // （定时轮询 / 批量刷榜 / 群报都会先问 isProfileHidden，见 utils/hiddenProfiles.js）。
        // 记在这里是为了覆盖所有入口，将来新增查询路径也不会漏。
        //
        // 只认 profile 端点：其它接口的 targetUserId 可能是角色ID
        // （getFightData 传的就是 roleId），混进标注会污染。
        if (kind === BUSINESS_CODE.PROFILE_HIDDEN && endpoint === PROFILE_ENDPOINT) {
          markProfileHidden(targetUserId)
        }

        // 其余业务错误码：账号本身没问题，换账号重试没有意义，也不算「请求成功」，
        // 原样交给上层按 returnCode 自行分流（myKingHomepage 会对隐藏主页提示）。
        if (isBusinessErrorCode(kind)) {
          logger.warn(`[王者接口] ${candidate.label} 返回业务错误码 ${businessCode}: ${data.returnMsg || data.message || ''}`.trim(), {
            endpoint,
            targetUserId: toText(targetUserId),
            requesterBotUserId: toText(requesterBotUserId)
          })
          return { action: 'return', value: data }
        }

        return { action: 'success' }
      }
    })
  }

  /**
   * 游戏侧 form 接口（`baseUrls.game`）。
   *
   * 和主站那套的差别：请求体是 form-urlencoded、响应是裸 JSON（没有 returnCode 包装
   * 时也算成功）、业务码判定更严（非 0 一律当失败并换号）。
   *
   * （原 `#requestGameFormWithCandidates`）
   */
  async gameFormWithCandidates (endpoint, extraFields = {}, targetUserId = '', requesterBotUserId = '', retries = 2, options = {}) {
    const url = `${this.#baseUrls.game}${endpoint}`
    // options.accountId：只发**指定的那一个**账号、不轮转。和 requestWithCandidates
    // 那条完全同构 —— 早先只有主站那边加了，游戏侧这条漏了，于是「查 A 号的
    // 营地币」实际可能是拿 B 号的登录态发的，读回来是 **B 号的余额**
    // （2026-10-10 实测：裸探针写死账号读 25，走插件读 0）。
    //
    // ⚠️ 只给**账号级数据**（余额这种「我的」数据）用它。
    //    `getGameHeroList` 那种「看谁由参数决定、本来就该用任意登录态去查」的
    //    接口**不要**传，传了会让「查非好友」失效。
    const candidates = options.accountId
      ? this.#auth.candidatesForAccount(options.accountId)
      : this.#auth.candidates(targetUserId, requesterBotUserId)

    if (!candidates.length) {
      throw new AuthConfigError('未找到可用的营地登录态，请先完成营地登录，或在账号池中配置一个可用的全局账号')
    }

    return this.#runWithCandidates({
      url,
      candidates,
      context: { endpoint, method: 'POST', targetUserId, requesterBotUserId },
      execute: candidate => this.#executeWithRetry({
        url,
        auth: candidate.auth,
        retries,
        context: {
          endpoint,
          method: 'POST',
          targetUserId: toText(targetUserId),
          requesterBotUserId: toText(requesterBotUserId)
        },
        buildHeaders: () => this.#signer.gameFormHeaders(candidate.auth),
        // 表单体里含 token/userId/gameRoleId，每个候选账号都得现建一份
        buildBody: () => this.#signer.gameFormBody(candidate.auth, extraFields),
        // ⚠️ release 在读完 text 后**立刻**调用（早于下面的日志与解析），
        // 和原版 #fetchGameForm 的 finally 位置逐字对齐。
        // 主站那条路径反过来（读完+解析完才 release），所以它不收 release 参数，
        // 由外层 finally 兜——两处位置不同是原版就有的差异，不是笔误。
        readData: async (response, release) => {
          let text
          try {
            text = await response.text()
          } finally {
            release()
          }

          logger.debug('[王者接口] 游戏侧表单原始响应', {
            endpoint,
            status: response.status,
            ok: response.ok,
            rawTextPreview: previewValue(text)
          })

          try {
            return parseJson(text)
          } catch (error) {
            throw new Error('接口返回无法解析，请检查当前账号登录态是否有效')
          }
        },
        describeHttpError: (response, data) =>
          `HTTP ${response.status}: ${data.returnMsg || data.message || response.statusText}`,
        logLabel: '[王者接口] 游戏侧表单请求调试'
      }),
      onBusinessCode: (data, candidate) => {
        const returnCode = Number(data?.returnCode)
        const kind = classifyBusinessCode(returnCode)

        // 裸 JSON（没有 returnCode）和 0 都算成功——这个端点历史上就是这样
        if (kind === BUSINESS_CODE.NONE || kind === BUSINESS_CODE.SUCCESS) {
          return { action: 'success' }
        }

        if (kind === BUSINESS_CODE.RATE_LIMITED) {
          return { action: 'rate-limit' }
        }

        // 皮肤墙这类错误响应没有统一的「登录失效」文案，只靠 returnCode 判：
        // -30003 走确定性标记；其余文案就算疑似（含 token/鉴权 等词）也只记日志不标记。
        const isDefinite = isDefiniteAuthFailure(data)
        if (!isDefinite && isSuspectedAuthFailure(data)) {
          logger.warn(`[王者接口] ${candidate.label} 游戏侧返回疑似鉴权相关文案（不标记账号）: ${data.returnMsg || data.message || ''}`.trim(), {
            endpoint,
            targetUserId: toText(targetUserId),
            requesterBotUserId: toText(requesterBotUserId),
            returnCode
          })
        }

        return {
          action: 'retry',
          reason: isDefinite ? '登录态失效' : '皮肤墙请求返回错误码',
          error: isDefinite
            ? new AuthAccountError(`${candidate.label} 登录态失效(returnCode=${returnCode}): ${data.returnMsg || data.message || ''}`.trim())
            : new AuthConfigError(`${candidate.label} 返回错误码 ${returnCode}: ${data.returnMsg || data.message || ''}`.trim()),
          mark: isDefinite
        }
      }
    })
  }

}

/* ========================================================== 门面 */

/**
 * API 服务类，封装了王者营地相关接口请求。
 * 新版营地接口需要额外的安全参数，因此这里统一处理鉴权头、encodeParam 和响应解密。
 *
 * 分层见文件顶部；本类只做两件事：**把各层组装起来**、**暴露业务接口**。
 * 业务方法按功能分成六节，顺序只影响可读性，不影响行为。
 */
class ApiService {
  #rateLimiter
  #signer
  #reader
  #auth
  #transport

  constructor () {
    /**
     * 历史遗留的公开属性。
     *
     * ⚠️ 必须**先建这个对象、再把它交给 signer**，两边引用同一个对象：
     * 原版 `#getCommonHeaders` 读的就是实例上的 `this.baseUrls`，
     * 若 signer 自己读模块常量，外部改了 `api.baseUrls.main` 就不再生效
     * （虽然现在没有这样的调用方，但那是行为差异，不该留）。
     */
    this.baseUrls = { ...BASE_URLS }

    this.#rateLimiter = new CampRateLimiter()
    // 先赋初值再建 signer：signer 每次现取（见 CampRequestSigner 的注释），
    // 所以这里传的是 getter 而不是快照值。
    this.generatedXLogUid = buildUuid()
    this.#signer = new CampRequestSigner(this.baseUrls, () => this.generatedXLogUid)
    this.#reader = new CampResponseReader(this.#signer)
    this.#auth = new CampAuthSession()
    this.#transport = new CampTransport({
      rateLimiter: this.#rateLimiter,
      signer: this.#signer,
      reader: this.#reader,
      auth: this.#auth,
      baseUrls: this.baseUrls
    })
  }

  /* -------------------------------------------------- 上层要用的公开方法 */

  /** 最近一次真命中 -30107 的时刻（ms），0 = 从没命中过 */
  lastRateLimitAt () {
    return this.#rateLimiter.lastRateLimitAt()
  }

  /**
   * 池里所有还能用的账号是不是都在频控冷却里——也就是「现在谁都发不出去」。
   * 给定时轮询用，见 CampRateLimiter.isAllCoolingDown。
   *
   * 没有任何可用账号时返回 false —— 那是配置问题，该让请求抛「未找到登录态」，
   * 而不是被轮询当成频控悄悄跳过。
   */
  hasNoAvailableAccount () {
    return this.#rateLimiter.isAllCoolingDown(this.#auth.usableAccounts())
  }

  /** 池里现在有几个能用的账号（上层估耗时用） */
  usableAccountCount () {
    return this.#auth.usableCount()
  }

  /** 把异常转成能直接发给用户的一段话 */
  formatUserFacingError (error, options = {}) {
    return this.#auth.formatUserFacingError(error, options)
  }

  /* ------------------------------------------------------------ 请求便捷入口 */

  /**
   * 主站鉴权接口的统一入口：POST + 2 次重试。
   *
   * （原 `#makeAuthRequest`；中间那层纯转发的 `#request` 已合并掉）
   */
  async #makeAuthRequest (endpoint, body, targetUserId = '', requesterBotUserId = '') {
    return this.#transport.requestWithCandidates('POST', endpoint, body, {}, 2, targetUserId, requesterBotUserId)
  }

  /* ================================================== 一、战绩（对局记录） */

  /**
   * 获取战绩列表（单页，服务端固定一页 30 场）
   * @param {object} opts
   * @param {number} opts.option   模式筛选，取值见响应里的 options 字段：0=全部 1=5v5排位 16=10v10排位 2=5v5标准 4=巅峰赛 19=2v2巅峰
   * @param {number} opts.lastTime 翻页游标，传上一页响应的 lastTime 取更早的一页；0 为第一页
   */
  async getMoreBattleList (ID, requesterBotUserId = '', { option = 0, lastTime = 0 } = {}) {
    return this.#makeAuthRequest('/game/morebattlelist', {
      lastTime,
      recommendPrivacy: 0,
      apiVersion: 5,
      friendUserId: ID,
      option
    }, ID, requesterBotUserId)
  }

  /** 获取战绩详情 */
  async getBattledetail (ID, battleType, gameSvr, relaySvr, targetRoleId, gameSeq, requesterBotUserId = '') {
    return this.#makeAuthRequest('/game/battledetail', {
      recommendPrivacy: 0,
      battleType,
      gameSvr,
      relaySvr,
      targetRoleId,
      gameSeq,
      friendUserId: ID
    }, ID, requesterBotUserId)
  }

  /* ============================================ 二、主页与英雄数据 */

  /** 获取营地主页信息 */
  async getProfile (ID, requesterBotUserId = '') {
    return this.#makeAuthRequest('/game/koh/profile', {
      targetUserId: ID,
      targetRoleId: '0',
      resVersion: '3',
      recommendPrivacy: '0',
      apiVersion: '2'
    }, ID, requesterBotUserId)
  }

  /** 获取账号常用英雄列表（含场次/胜率/战力/称号） */
  async getProfileHeroList (ID, targetRoleId, requesterBotUserId = '') {
    return this.#makeAuthRequest('/game/profile/herolist', {
      targetUserId: toText(ID),
      targetRoleId: toText(targetRoleId),
      recommendPrivacy: 0
    }, ID, requesterBotUserId)
  }

  /**
   * 获取账号全量英雄列表（营地 App「我的英雄」页，全部竞技模式的生涯累计）。
   * 和皮肤墙同属游戏侧 form 接口。实测返回该账号拥有的全部英雄（一个号 132 条），
   * 单条含 playNum/winRate/heroFightPower/skilledLevel/heroTypes 等，一次请求就够，不用逐英雄拉。
   * heroFightPower 实测与 getProfileHeroList 的同名字段完全一致（两个号 × 4 英雄同时刻比对），
   * 营地 App 那页把这一列标成「最高战力」；近 30 天的战力峰值另在
   * /gametoolbox/hero/record/pagedetails 的 powerData 里，需逐英雄请求。
   * 荣耀称号（「XX区第N英雄」）不在这个接口里，同样要走 pagedetails 的 medalList。
   */
  async getGameHeroList (ID, requesterBotUserId = '') {
    return this.#transport.gameFormWithCandidates('/play/h5getherolist', {
      noCache: '0',
      recommendPrivacy: '0',
      friendUserId: toText(ID)
    }, toText(ID), requesterBotUserId)
  }

  /**
   * 获取「我的英雄 · 历史赛季」页数据（营地 App 那页右上角可切赛季，含历史最高战力）。
   * 注意路径里的 usaully 是营地自己的拼写（不是 usually），别当笔误改掉。
   * seasonId：0=「历史赛季」（跨赛季峰值，实测一个号 90 个英雄里 32 个有值），
   * -1=当前赛季（只回本赛季用过的几个英雄），再往前的负数服务端一律返回 0。
   * 单条含 heroFightPower（当前战力）/ maxHeroFightPower（历史最高战力）/ honorTitle（拿历史最高时的荣耀称号）。
   * 和 getGameHeroList 的差别：那边是「当前」战力且没有称号、没有 winNum 之外的口径差异，
   * 这边一次请求就能拿到全部英雄的历史峰值称号，不用逐英雄拉 pagedetails。
   * @param {string|number} roleId 角色 ID（来自 profile.data.targetRoleId，不是营地 ID）
   * @param {string} requesterBotUserId 发起查询的机器人用户 ID
   * @param {number} [seasonId=0] 赛季，0=历史赛季
   */
  async getSeasonUsuallyHeroList (roleId, requesterBotUserId = '', seasonId = 0) {
    return this.#makeAuthRequest('/hero/getseasonusaullyherolist', {
      recommendPrivacy: 0,
      seasonId,
      roleId: toText(roleId)
    }, roleId, requesterBotUserId)
  }

  /**
   * 获取单个英雄的战绩详情（营地 App 英雄战绩页）。
   * 这个端点在 kohcamp 网关，但有三个和别处不一样的硬性要求，改动前先看清：
   *   1. serverId 必须放 HTTP header，放 body 里会返回 heroId=0 的空壳而 returnCode 仍是 0
   *   2. 英雄 ID 的参数名是全小写 heroid，写成 heroId 拿不到数据
   *   3. roleId 要传字符串，传 Number 会 returnCode=1
   * 返回里可用的：medalList[] 荣耀称号（{UserMedalInfo:'天河区第25虞姬', TitleType:1}）、
   * heroInfo（熟练度/胜负场/MVP/均分）、zjList[] 最近 5 场、powerData[] 战力曲线（仅近 30 天）。
   * @param {string|number} roleId 角色 ID（getProfile 的 data.targetRoleId）
   * @param {string|number} heroId 英雄 ID
   * @param {object} [options]
   * @param {string} [options.roleName] 角色名，缺省不影响返回
   * @param {string|number} [options.serverId] 区服 ID（roleList 里对应角色的 serverId）
   */
  async getHeroRecordDetails (roleId, heroId, { roleName = '', serverId = '' } = {}, targetUserId = '', requesterBotUserId = '') {
    return this.#transport.requestWithCandidates('POST', '/gametoolbox/hero/record/pagedetails', {
      roleId: toText(roleId),
      heroid: Number(heroId),
      roleName: toText(roleName),
      h5Get: 1
    }, { serverId: toText(serverId) }, 2, targetUserId, requesterBotUserId)
  }

  /* ============================================== 三、皮肤与英雄资料 */

  /**
   * 获取账号皮肤列表（皮肤墙）。
   * 该接口位于游戏侧域名，使用 form 表单 + token/userId 鉴权，响应不加密。
   * 接口与参数参考自 https://github.com/KimigaiiWuyi/WzryUID
   */

  async getSkinList (ID, requesterBotUserId = '') {
    return this.#transport.gameFormWithCandidates('/play/h5getheroskinlist', {
      noCache: '0',
      recommendPrivacy: '0',
      friendUserId: toText(ID)
    }, toText(ID), requesterBotUserId)
  }

  /**
   * 英雄核心装备推荐（营地 App 英雄详情页「推荐出装」那块的数据源）。
   *
   * 和官网资料库那两套「成套出装」不是一回事：这里给的是**单件核心装备**（实测 3 件），
   * 但每件都带**真实对局数据** —— `winRate`（0.5998）/ `showRate`（0.1658）小数，
   * 还有 `szAttr` 属性文案、`descLabel` 推荐理由（「高额暴击伤害」）。两边互补，都值得展示。
   *
   * 参数只要 heroId（就是英雄 ename），和请求账号无关，属于公共数据。
   * @returns {Promise<object>} `data.list[]`
   */
  async getHeroBestEquip (heroId, targetUserId = '', requesterBotUserId = '') {
    return this.#transport.requestWithCandidates('POST', '/gametoolbox/equip/hero/getherobestequip', {
      heroId: Number(heroId)
    }, {}, 2, targetUserId, requesterBotUserId)
  }

  /**
   * 英雄铭文 + 技能（营地 App 英雄详情页的 `getherofringedata`）。
   *
   * **这个接口的响应没有 returnCode 包装**，顶层直接是
   * `{ skillList1, skillList2, skillList3, RuneSetList }`（skillList2/3 实测恒为空数组），
   * 所以别去判 `returnCode === 0`，判 `RuneSetList` 在不在就行。
   *
   * `RuneSetList` 实测 3 套推荐，每套 `{ showRate, winRate, runeList[] }`，
   * 单个铭文 `{ runeId, num（这套里带几个）, szTitle（"5级铭文:无双"）, szColor（"绿色铭文"）,
   * szCate（"攻击|穿透"）, szCommAttr（属性）, szIcon }`。
   * @returns {Promise<object>} 顶层就是数据本身
   */
  async getHeroFringeData (heroId, targetUserId = '', requesterBotUserId = '') {
    return this.#transport.requestWithCandidates('POST', '/gametoolbox/hero/getherofringedata', {
      heroId: Number(heroId)
    }, {}, 2, targetUserId, requesterBotUserId)
  }

  /* ============================================== 四、赛季与对战数据 */

  /** 获取赛季页数据 */
  async getSeasonpage (ID, requesterBotUserId = '', seasonId = 0, extraBody = {}) {
    return this.#makeAuthRequest('/game/seasonpage', {
      recommendPrivacy: 0,
      seasonId,
      roleId: ID,
      ...extraBody
    }, ID, requesterBotUserId)
  }

  /**
   * 获取对战五维数据（战斗表现）。
   * gameBattleType 对应 profile 的 options，例如 10=巅峰赛、2=5v5、3=排位赛。
   * branchType：0=全部分路 1=对抗路 2=中路 3=发育路 4=打野 5=游走。
   * dateType：1=近30场 2=近30天。
   * @param {string|number} roleId  角色 ID（来自 profile.data.targetRoleId）
   * @param {string} requesterBotUserId  发起查询的机器人用户 ID
   * @param {object} [options]
   * @param {number} [options.gameBattleType=10] 对战类型
   * @param {number} [options.branchType=0] 分路
   * @param {number} [options.dateType=2] 统计周期
   */
  async getFightData (roleId, requesterBotUserId = '', { gameBattleType = 10, branchType = 0, dateType = 2 } = {}) {
    return this.#makeAuthRequest('/game/getfightdata', {
      recommendPrivacy: 0,
      dateType,
      roleId: toText(roleId),
      roleFriendId: 0,
      branchType,
      source: 1,
      gameBattleType,
      card: 0
    }, roleId, requesterBotUserId)
  }

  /* ================================================ 五、榜单与观战 */

  /**
   * 获取英雄梯度榜（T0~T3 热度/胜率/登场率/Ban率）。
   * 数据由官方营地实时返回，返回体自带 updateTime 表示数据更新日期。
   * @param {object} [options]
   * @param {number} [options.rankId=0] 排行榜 ID，默认 0
   * @param {number} [options.segment=3] 段位筛选，对应 tabFilter 下标：1=所有段位 3=巅峰赛1350+ 4=顶端排位 5=赛事
   * @param {number} [options.position=0] 分路筛选，对应 branchFilter 下标：0=全部分路 1=对抗路 2=中路 3=发育路 4=游走 5=打野
   */
  async getdetailranklistbyid ({ rankId = 0, segment = 3, position = 0 } = {}) {
    return this.#makeAuthRequest('/hero/getdetailranklistbyid', {
      bottomTab: '',
      rankId,
      segment,
      position,
      recommendPrivacy: 0
    })
  }

  /**
   * 大神观战池：营地公开的「正在打的高端局」，每条自带**内嵌的 RTMP 流**。
   *
   * 零参数、不可筛不可翻页，每次返回**随机 10 场**（服务端每次换一批人）。
   * `tvChoiceItems` 里混着主播 / 节目 / 赛事各种条目，靠 `tvType` 区分 ——
   * **只有 `tvType === 2` 是对局**（4 主播 / 5 活动 / 6 节目 / 7 赛事都没有 battle）。
   *
   * 对局自带 `battleInfo.gameType`：4 = 排位赛、14 = 巅峰赛（营地只开放这两种观战）；
   * 分路在 `battleInfo.roleInfo.tag` 里（`id === 4` 那条，name 就是「打野」这类）。
   * ⚠️ 巅峰赛每天 12:00 才开，没开的时候池子里只有排位。
   */
  async getTvChoiceItems (targetUserId = '', requesterBotUserId = '') {
    return this.#transport.requestWithCandidates('POST', '/info/tv/choiceitem', {}, {}, 2, targetUserId, requesterBotUserId)
  }

  /* ==================================================== 六、营地签到 */

  /**
   * 拿一个营地号在游戏里的**角色列表**。
   *
   * 签到的 `newsignin` 必须带 `roleId`，而这个值不在登录态里 —— 账号池里所有号的
   * `gameRoleId` 都是空的（那是「当前选中角色」的缓存，扫码登录时不写）。
   * 所以每次签到前要现查一次。
   *
   * 返回值形状：`{ userId, openid, gameList: [{ gameId, roles: [...] }] }`，
   * 王者的 gameId 是 `20001`，`roles[]` 里每条含 `roleId` / `roleName` / `areaId` /
   * `serverId` / `roleDesc`（如「微信安卓 至尊星耀III」）。
   *
   * ⚠️ 用**指定的那个账号**发（options.accountId），不能轮转 —— 否则查到的是别人的角色。
   *
   * @param {string} userId 账号池里的 userId（营地ID）
   */
  async getRoleList (userId) {
    return this.#transport.requestWithCandidates(
      'POST', '/game/rolelist', {}, {}, 2, userId, '', { accountId: userId }
    )
  }

  /**
   * 查一个营地号的**签到状态**。
   *
   * 返回体（实测 2026-10-10，`data` 部分）：
   *   · `weekSignMap`   —— **本周签到图**，7 个字符、`'1'` 为已签，**下标 0 = 周一**
   *                        （2026-10-10 是周六，主人号返回 `'0000010'`，第 6 位=1 ✓）
   *   · `seqSignDays`   —— 连续签到天数
   *   · `userTotalSign` —— 累计签到天数
   *   · `canExtraSign`  —— 可补签次数
   *   · `weekList`      —— 本周 1~7 天的奖励表（`date` + `gift[]`）
   *   · `totalList`     —— 累计签到（7 天 / 14 天…）奖励表
   *   · `redPoint`      —— 红点（`{ text, show, id }`）
   *
   * ⚠️ 判「今天签没签」只认 `weekSignMap`。**别用同族的 `/operation/extrasignweekinfo`** ——
   *    它的 `signMap` 实测恒为 `'0000000'`（主人号当天已签也照样全 0），是另一个口径。
   *
   * ⚠️ 用**指定的那个账号**发（options.accountId），不能轮转。
   *
   * @param {string} userId 账号池里的 userId（营地ID）
   */
  async getCampSignInfo (userId) {
    return this.#transport.requestWithCandidates(
      'POST', '/operation/action/signinfo', {}, {}, 2, userId, '', { accountId: userId }
    )
  }

  /**
   * 给一个营地号**签到**。
   *
   * ⚠️⚠️ `roleId` 是**必需**的，不带它服务端回的是那句骗人的
   *    `-105204 未授权营地，请前往游戏修改授权设置后重试` —— 看着像权限问题，
   *    实际是**缺参数**（2026-10-10 实测：body 里只补一个 `roleId` 就变成
   *    `-105203 请勿重复签到`，参数就齐了）。别被那句文案带去查授权设置。
   *
   * 实测确认**只有 body 里的 `roleId` 管用**，这些通通不算数（都回 -105204）：
   *   body 里的 `gameRoleId` / `areaId` / `serverId` / `gameAreaId` / `gameServerId`；
   *   请求头里的 `gameroleid` / `gameserverid` / `gameareaid`；
   *   以及 `type` / `signType` / `source` / `userId` / `gameId` 等猜测参数。
   *
   * 返回码：
   *   · `0`        签到成功，`data` 里是奖励（`giftList[]` / `signDate` / `seqSignDays` / `totalSignDays`）
   *   · `-105203`  今天已经签过了（**不是错误**，调用方要按「已签」而不是「失败」处理）
   *   · `-105206`  操作太频繁，歇几秒再试
   *   · `-105204`  roleId 没传对（见上）
   *
   * `retries` 传 **0**：签到是**写操作**，重试等于连签两次，只会撞 -105206。
   *
   * @param {string} userId 账号池里的 userId（营地ID）
   * @param {string|number} roleId 该账号在游戏里的角色ID（来自 getRoleList）
   */
  async doCampSign (userId, roleId) {
    const role = toText(roleId)

    // ⚠️ roleId 为空时**整个字段都不发**，不能发 `{"roleId":""}`（2026-10-10 实测）：
    //    body = `{}`            → `-105204 未授权营地`（服务端认「缺字段」）
    //    body = `{"roleId":""}` → `1 服务繁忙，请稍后再试`（认「字段值非法」）
    //    两者结果不一样，说明 -105204 的判据是「这个键不存在」。空串漏出去的话，
    //    用户看到的是「服务繁忙」这种看不出原因的码，比「未授权营地」更难查。
    const body = role ? { roleId: role } : {}

    return this.#transport.requestWithCandidates(
      'POST', '/operation/action/newsignin', body, {},
      0, userId, '', { accountId: userId }
    )
  }

  /**
   * 查**营地币余额**。
   *
   * 端点本身叫 `h5lotteryquery`（抽奖查询），但实测（2026-10-10）它一次给全：
   *   · `data.userCurrencyCnt` —— **营地币余额**（签到给的也是营地币，
   *     主人号当天签到拿 25 枚，这里读出来正是 25 ✓）
   *   · `data.exchangeInfo`   —— 兑换活动信息，**没活动时是 `null`**
   *   · `data.exchangeBanners` —— 兑换横幅，没活动时是 `[]`
   *   · `data.gamesList`      —— 参与的游戏（王者是 `20001`）
   *   · `data.lotteryInfo`    —— 抽奖信息，没活动时是 `null`
   *
   * ⚠️ 走**游戏侧** form 网关（`baseUrls.game`），不是主站 —— 主站打这个路径
   *    是 `404 Route Not Found`。
   * ⚠️ `exchangeInfo` 为 null **不代表接口坏了**，是「当前没有兑换活动」。
   *    上层要按「没活动」展示，别报成错误。
   *
   * @param {string} targetUserId 用哪个账号查（营地池里的 userId）
   * @param {string} requesterBotUserId 发起查询的机器人用户 ID
   */
  async getCampCoin (targetUserId = '', requesterBotUserId = '') {
    const userId = toText(targetUserId)

    // ⚠️⚠️ 必须传 `options.accountId`（不轮转）。余额是**账号级**的数据，
    //    而 `gameFormWithCandidates` 默认会按全局账号轮转 ——
    //    不锁账号的话，「查 A 号的营地币」会拿 B 号的登录态发出去，
    //    读回来的是 **B 号的余额**（2026-10-10 实测：同一个号，
    //    裸探针写死账号读 25、走插件读 0，就是这个原因）。
    return this.#transport.gameFormWithCandidates(
      '/play/h5lotteryquery', {}, userId, requesterBotUserId, 2, { accountId: userId }
    )
  }

  /**
   * 拉**营地商城**商品列表（`/mall/tabgoodslist`）。
   *
   * 实测 2026-10-10：`totalPage` 67、单页 15 条。每条商品字段非常多，常用的：
   *   · `goodsId` / `djcId` —— 商品 ID（`djcId` 是「道具城」那边的 ID）
   *   · `name` / `subName` —— 名称 / 副标题（皮肤商品这里是英雄名）
   *   · `posterUrl` / `goodsBust` —— 海报 / 半身像
   *   · `curPrice` / `orgPrice` / `discountPrice` —— 现价 / 原价 / 折后价
   *   · `currencyType` —— **币种数组**。实测取值：`1`（营地币）、`3`（人民币）、`4`
   *   · `type` —— 商品类型（1=皮肤、6=英雄、7=个性按键…）
   *   · `isOwn` —— 是否已拥有
   *   · `limitBuy` —— 限购
   *
   * ⚠️ **`tabId` 不是品类筛选**：实测传 0~5 各页返回的商品不同，但都是混着的，
   *    没有稳定的「营地币专区」这种语义。想筛就用 `currencyType`。
   * ⚠️ `page` 从 **0** 开始。
   *
   * @param {object} [opts]
   * @param {number} [opts.tabId=0]
   * @param {number} [opts.page=0] 页码，**从 0 开始**
   * @param {number} [opts.pageSize=15]
   */
  async getMallGoods ({ tabId = 0, page = 0, pageSize = 15 } = {}) {
    return this.#transport.requestWithCandidates('POST', '/mall/tabgoodslist', {
      tabId, page, pageSize
    }, {}, 2)
  }

  /**
   * 英雄战力查询（sapi.run，非官方接口）。
   *
   * 四个大区各发一发、并发跑，**允许部分失败**：只要有一个区通就返回结果，
   * 四个全挂才抛错。失败的那个区记 logger.error 并跳过（返回 null 被 filter 掉），
   * 所以返回值里 type 字段能看出这条是哪个区的。
   *
   * @param {string} heroName 英雄名（调用方已做过 expandYuan 之类的别名展开）
   * @returns {Promise<Array<object>>} 至少一条
   */
  async getHeroFightingCapacity (heroName) {
    const results = await Promise.all(FIGHTING_CAPACITY_REGIONS.map(async (hero) => {
      try {
        const query = new URLSearchParams({
          hero: heroName,
          type: hero
        })
        const res = await fetch(`${EXTERNAL_URLS.heroFightingCapacity}?${query.toString()}`, {
          signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS)
        })

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`)
        }

        const payload = await res.json()
        if (payload.code !== 200 || !payload.data) {
          throw new Error(payload.msg || '接口返回异常')
        }

        return {
          ...payload.data,
          type: hero,
          apiMsg: payload.msg || ''
        }
      } catch (error) {
        logger.error(`[获取英雄战力] ${heroName}(${hero}) 请求失败`, error)
        return null
      }
    }))

    const availableResults = results.filter(Boolean)
    if (!availableResults.length) {
      throw new Error(`英雄战力接口请求失败：${heroName}`)
    }

    return availableResults
  }

  /* ============================================ 六、官网资料与资讯（外站） */

  /**
   * 拉一个外站公开 JSON。这些地址不需要鉴权、也不该占营地的请求名额，
   * 但同样必须设超时：herolist.json 在 #查战绩 的必经路径上，
   * 对端一挂，指令就永久没有回复（Yunzai 那头也不会替你兜）。
   */
  async #fetchExternalJson (url, timeoutMs = EXTERNAL_TIMEOUT_MS) {
    let response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      throw describeAbort(error, timeoutMs)
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    return response.json()
  }

  /**
   * 外站 JSON + 统一的失败包装。
   *
   * 四个「官网总表」类接口（英雄 / 皮肤 / 装备 / 爆料站）原先各写一份
   * try/catch + 一样的错误消息，这里合并成一处；`label` 同时决定日志前缀
   * 和错误文案（`[${label}] 接口请求失败` / `${label}失败。错误: ...`）。
   */
  async #fetchExternalTable (url, label, timeoutMs = EXTERNAL_TIMEOUT_MS) {
    try {
      return await this.#fetchExternalJson(url, timeoutMs)
    } catch (error) {
      logger.error(`[${label}] 接口请求失败`, error)
      throw new Error(`${label}失败。错误: ${error.message || error}`)
    }
  }

  /** 官网英雄总表 */
  async getHeroList () {
    return this.#fetchExternalTable(EXTERNAL_URLS.heroList, '获取英雄列表')
  }

  // 官网资料库的皮肤总表（约 780KB，816 条），按皮肤ID索引，含每张皮肤的官方立绘图。
  // 营地接口对刚上线的新皮肤常只给占位图，这里是唯一图片覆盖率 100% 的公开图源。
  // 体积不小，调用方需自行缓存，勿逐张皮肤调用。
  async getPvpSkinList () {
    return this.#fetchExternalTable(EXTERNAL_URLS.pvpSkinList, '获取官网皮肤总表')
  }

  /** 爆料站皮肤数据 */
  async getHeroXpflby () {
    return this.#fetchExternalTable(EXTERNAL_URLS.heroXpflby, '获取爆料站-皮肤数据')
  }

  /**
   * 官网装备总表（121 条，`{item_id, item_name, item_type, price, total_price, des1}`）。
   * 出装建议只给装备 ID，装备名要靠这张表翻。
   * 这个文件是 **UTF-8**，别跟着英雄详情页一起按 GB18030 解（会解成「閾佸墤」这种乱码）。
   */
  async getPvpItemList () {
    return this.#fetchExternalTable(EXTERNAL_URLS.pvpItemList, '获取官网装备表')
  }

  /**
   * 官网资讯列表（公告 / 新闻 / 赛事都在里面）。
   *
   * 端点是**官网资讯页自己调的那个**（`web201706/newsindex.shtml` → `js/newsindex.js`），
   * 零鉴权、不占营地频控配额。营地那边的 `/info/listinfov2` 一类要登录态、会吃账号配额，
   * 而公告对所有人都一样，没必要为它消耗营地的号。
   *
   * ⚠️ 必须带签名，否则回 `{"msg":"p0 error","status":-1}`（52 字节，很容易误判成
   * 「端点不存在」——实际上端点是对的，只是参数不全）。签名算法和 token 都明文写在
   * 官网那个 js 里：`md5(token + source + serviceId + 秒级时间戳)`。
   *
   * ⚠️ `tagids` 参数**服务端不生效**（传了照样返回全量，实测 total 恒为 10125），
   * 想按标签筛只能拉回来本地筛。
   *
   * 频道 ID（实测语义见 utils/gameNews.js 的 CHANNEL_NEWS）：
   * 1762 版本公告专区 / 1760 热门 / 1761 新闻 / 1763 活动 / 1766 体验服。
   *
   * @param {object} [options]
   * @param {number} [options.chanid] 频道 ID，默认 1762 版本公告专区
   * @param {number} [options.limit] 取多少条，默认 30
   * @param {number} [options.start] 偏移，翻页用
   * @returns {Promise<{items: object[], total: number}>}
   */
  async getPvpNewsList ({ chanid = 1762, limit = 30, start = 0 } = {}) {
    const timestamp = Math.floor(Date.now() / 1000)
    const sign = crypto
      .createHash('md5')
      .update(`${PVP_NEWS_TOKEN}${PVP_NEWS_SOURCE}${PVP_NEWS_SERVICE_ID}${timestamp}`)
      .digest('hex')

    const query = new URLSearchParams({
      serviceId: String(PVP_NEWS_SERVICE_ID),
      filter: 'channel',
      sortby: 'sIdxTime',
      source: PVP_NEWS_SOURCE,
      logic: 'or',
      // 1=图文 2=视频，官网首页就是这两类一起拉
      typeids: '1,2',
      withtop: 'yes',
      chanid: String(chanid),
      limit: String(limit),
      start: String(start),
      exclusiveChannel: '4',
      exclusiveChannelSign: sign,
      time: String(timestamp)
    })

    const data = await this.#fetchExternalTable(
      `${EXTERNAL_URLS.pvpNewsList}?${query.toString()}`,
      '获取官网资讯'
    )

    // status 非 0 时 msg 才是有用的信息（签名错就是 'p0 error'）
    if (Number(data?.status) !== 0) {
      throw new Error(`获取官网资讯失败：${data?.msg || '接口返回异常'}`)
    }

    return {
      items: Array.isArray(data?.data?.items) ? data.data.items : [],
      total: Number(data?.data?.total) || 0
    }
  }

  /**
   * 官网公告正文。`getPvpNewsList` 只给标题，正文要按 id 单独取。
   *
   * 端点来自详情页调的 `fillNews.detail()`（fillnewsgicp/v1.2.js 里写着
   * `newsType:'news'` → searchNews.php、`'video'` → search.php）。
   *
   * ⚠️ 响应是 **JSONP 形式**：整体是 `var searchObj={...}` 而不是裸 JSON，
   * 直接 `response.json()` 会抛解析错，必须先剥掉 `var searchObj=` 前缀和结尾的分号。
   * 正文在 `msg.sContent`，是一段 **HTML**（带大量内联 style，见 utils/gameNews.js 的清洗）。
   *
   * @param {string|number} id 公告 id（列表项的 iId）
   * @returns {Promise<{title: string, time: string, content: string}>}
   */
  async getPvpNewsDetail (id) {
    const tid = toText(id).trim()
    if (!tid) {
      throw new Error('缺少公告 id')
    }

    const url = `${EXTERNAL_URLS.pvpNewsDetail}?p0=18&source=web_pc&id=${encodeURIComponent(tid)}`

    let response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS) })
    } catch (error) {
      throw describeAbort(error, EXTERNAL_TIMEOUT_MS)
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const text = await response.text()
    // 剥 JSONP 外壳：`var searchObj={...};` → `{...}`
    const json = text.replace(/^[\s\S]*?var\s+searchObj\s*=/, '').replace(/;\s*$/, '').trim()

    let data
    try {
      data = JSON.parse(json)
    } catch {
      throw new Error('公告正文解析失败（接口返回格式变了）')
    }

    if (Number(data?.status) !== 0) {
      throw new Error(`获取公告正文失败：${data?.msg || '接口返回异常'}`)
    }

    return {
      title: String(data?.msg?.sTitle || '').trim(),
      time: String(data?.msg?.sIdxTime || data?.msg?.sCreated || '').trim(),
      content: String(data?.msg?.sContent || '')
    }
  }

  /**
   * 官网英雄资料页原始 HTML（出装建议 / 英雄关系 / 技能）。
   *
   * 两个坑：
   *   1. **路径是英雄拼音，不是英雄ID**。`herodetail/547.shtml` 是 404，
   *      `herodetail/luyana.shtml` 才是 200（官网改版过）。拼音取自
   *      `heroskinlist.json` 英雄表的 `yxpymc_4614` 字段，别自己音译。
   *   2. **页面编码是 GB18030**，`response.text()` 按 UTF-8 解会整页乱码，
   *      必须走 arrayBuffer + TextDecoder('gb18030')。
   *
   * @param {string} pinyin 英雄拼音，如 'luyana'
   * @returns {Promise<string>} 解码后的 HTML
   */
  async getHeroDetailPage (pinyin) {
    const name = toText(pinyin).trim()
    if (!name) {
      throw new Error('缺少英雄拼音')
    }

    const url = `${EXTERNAL_URLS.heroDetailPage}/${encodeURIComponent(name)}.shtml`

    let response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS) })
    } catch (error) {
      throw describeAbort(error, EXTERNAL_TIMEOUT_MS)
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    return new TextDecoder('gb18030').decode(await response.arrayBuffer())
  }

  /* ======================================================== 七、账号维护 */

  /**
   * **保活**：用指定账号调一次最轻的接口，让营地那边的登录态「动一下」。
   *
   * 为什么需要它：营地 token **没有固定过期时间**（`/user/login` 恒返回 `expires=0`），
   * 也没有「刷新」接口（老的 `/user/refreshweixintoken` 已下线，现在报 rpc invalid）——
   * 它是**用则续命、闲置才死**（记忆里的实例：闲置 29 天就报 `-30003` 登录态失效）。
   * 所以「天天在用的号不会过期，用得少的号会被忘掉」，定期戳一下就能把用得少的也保住。
   *
   * ⚠️ 只做查询、不改任何状态，也**不会换掉 token**（实测调完 token 原样不动，
   *    观战服务那几个正在用的号也不受影响）。
   *
   * @param {string} targetUserId 用哪个账号去调（账号池里的 userId）
   */
  async keepAlive (targetUserId) {
    // 重试 1 次而不是 2 次：保活是定时任务，失败了下轮再来，没必要退避着耗时间
    return this.#transport.requestWithCandidates('POST', '/user/getcampfriends', {}, {}, 1, targetUserId)
  }
}

/** 单例。起个名字是因为下面 estimateRequestSeconds 要用它（default export 是匿名的） */
const apiService = new ApiService()

/**
 * 估算「N 次请求大概要几秒」，给上层的「约需 XX 秒」提示用。
 *
 * **不能再用「次数 × MIN_REQUEST_GAP_MS」直接算**：请求是按账号并发跑的
 * （`CampRateLimiter.#acquireSlot` 按账号分队列、`CampAuthSession.#rotateGlobals`
 * 把请求轮着分给不同的号），4 个账号就是 4 路并行，照老算法会高估四倍，
 * 用户等 10 秒却被告知 40 秒。
 *
 * 用当前池里可用账号数折算，没有可用账号时按 1 路算（那种情况下请求本来就会失败，
 * 提示保守一点没有坏处）。
 *
 * @param {number} count 预计要发的请求次数
 * @returns {number} 秒数，至少 1
 */
export function estimateRequestSeconds (count) {
  const times = Math.max(0, Number(count) || 0)
  const workers = Math.max(1, apiService.usableAccountCount())
  return Math.max(1, Math.ceil(times * MIN_REQUEST_GAP_MS / 1000 / workers))
}

export default apiService
