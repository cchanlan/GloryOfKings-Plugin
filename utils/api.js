import crypto from 'node:crypto'
import fetch from 'node-fetch'
import { Config } from '#components'
import { decrypt as xxteaDecrypt, encrypt as xxteaEncrypt } from './xxtea.js'
import authStore, { isUsableAuth } from './authStore.js'
import { notifyAccountRateLimited } from './rateLimitNotice.js'
import { markProfileHidden } from './hiddenProfiles.js'

const DEFAULT_PUBLIC_KEY = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC0h62mV/zjJtFsNdfFNlxksfUOpjDI2KCcBrPiA8T7szABT4InLDTrdXAW84QyGNiazB0i7pgPCNGSAYbiJrCRutZ5jQsVS0Wg/RnXfwVQDJcAHJDjP5IXyroeLX7NUxDai8nPcpfRsvq6sneobyPexZSH0TlVSnecsJZTj5wu/wIDAQAB'

/** 营地频控错误码：操作频繁 */
const CODE_RATE_LIMITED = -30107

/** 对方隐藏了主页：数据永远拿不到，标注后 24 小时内不再主动查（见 utils/hiddenProfiles.js） */
const CODE_PROFILE_HIDDEN = -10107

/** 主页接口。只有它返回的 -10107 才代表「这个玩家隐藏了主页」 */
const PROFILE_ENDPOINT = '/game/koh/profile'

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

/** 把「还要等多久」写成读得懂的话：超过一小时说小时，否则说秒 */
function describeWait (ms) {
  return ms >= 3600000 ? `${Math.ceil(ms / 3600000)} 小时` : `${Math.ceil(ms / 1000)} 秒`
}

/** 外站公开 JSON（官网资料库 / sapi.run）的超时。这些接口不进队列，但也不能不设表 */
const EXTERNAL_TIMEOUT_MS = 12000

/** 把 AbortError 翻译成人话，否则用户只看到 “The operation was aborted” */
function describeAbort (error, timeoutMs) {
  if (error?.name === 'AbortError' || error?.type === 'aborted') {
    return new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒无响应）`)
  }
  return error
}

class AuthConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthConfigError'
  }
}

/**
 * 频控错误。单独一个类型，是因为它和别的失败处理方式相反：
 * 不能重试（重试只会加重频控），也不能换账号（账号池通常只有一个 token），
 * 唯一有效的做法是立刻放弃、等冷却过去。重试循环和候选账号循环都靠这个类型提前退出。
 */
class RateLimitError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RateLimitError'
  }
}

/**
 * API 服务类，封装了王者营地相关接口请求。
 * 新版营地接口需要额外的安全参数，因此这里统一处理鉴权头、encodeParam 和响应解密。
 */
class ApiService {
  /**
   * 账号 userId -> 静默截止时间戳（ms）。
   *
   * 按**账号**记，不是全局：多个全局账号轮询时，某个号被营地限流不该把池里
   * 其他好号一起拖停——那个号单独静默、从候选里跳过，其余的照常顶上。
   * 条目只在它请求成功时才删（见 #clearRateLimit），所以「静默期内一个请求都不发」
   * 对上层完全透明。
   */
  #rateLimitUntilByUser = new Map()

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
   * **按账号分队列，不是全局一条**：营地的限流是按账号记的（实测 2026-09-13，
   * 同一个号怎么等都会被拒、换个号立刻通），所以「相邻两次请求至少隔
   * MIN_REQUEST_GAP_MS」这条约束本就该按账号成立，而不是让池里所有号排同一条队。
   * 分开之后多个全局账号的请求能真正并发，谁也不用替别人白等——
   * #谁在打游戏 的现刷、排行榜那种十几连发，速度直接按账号数成倍。
   */
  #queueTailByUser = new Map()
  /** 账号 userId -> 上次实际请求发出时刻 */
  #lastRequestAtByUser = new Map()
  /**
   * 全局账号之间的轮询游标。多个全局账号时，请求挨个换号发（见 #rotateGlobals），
   * 单号请求量降到 1/N，配合上面的分队列才谈得上并发。
   */
  #globalCursor = 0

  constructor() {
    this.baseUrls = {
      main: 'https://kohcamp.qq.com',
      game: 'https://ssl.kohsocialapp.qq.com:10001'
    }
    this.generatedXLogUid = this.#buildUuid()
  }

  /* ------------------------------------------------------ 频控冷却与请求队列 */

  /**
   * 这个账号还剩多少毫秒冷却（0 = 可正常使用）。
   *
   * 冷却按账号独立记，所以调用方能把「冷却中的号」从候选里挑出来跳过，
   * 而不是让整个插件停摆。
   */
  #rateLimitCooldownLeft(auth) {
    const userId = this.#toString(auth?.userId)
    if (!userId) {
      return 0
    }

    return Math.max(0, (this.#rateLimitUntilByUser.get(userId) || 0) - Date.now())
  }

  /**
   * 冷却检查：只看传进来的这个账号。
   *
   * ⚠️ 错误文案里**不能**出现「全局账号 / token / 鉴权 / 登录态 / 安全参数」这类词。
   * 频控文案会被 formatUserFacingError 原样透给用户，一旦命中它那串敏感词正则，
   * 用户看到的就是「请联系主人处理」，反而看不出是频控。
   */
  #assertNotRateLimited(auth) {
    const waitMs = this.#rateLimitCooldownLeft(auth)
    if (waitMs <= 0) return

    throw new RateLimitError(`营地接口暂时被限流，约 ${describeWait(waitMs)}后恢复，请稍后再试`)
  }

  /**
   * 记录一次 -30107 命中：把这个号静默 12 小时，并私信主人。
   *
   * 「首次」的判据就是**冷却表里还没有它**（成功恢复时条目会被删掉，见 #clearRateLimit），
   * 所以静默期内就算又被别的路径撞到，也不会反复私信；等它哪天真恢复了、
   * 以后再被限流，会重新通知一次——那是新的事故，该说。
   *
   * @returns {number} 本次静默毫秒数
   */
  #markRateLimited(auth) {
    const userId = this.#toString(auth?.userId)
    if (!userId) {
      return 0
    }

    const firstHit = !this.#rateLimitUntilByUser.has(userId)
    this.#rateLimitUntilByUser.set(userId, Date.now() + RATE_LIMIT_SILENCE_MS)
    this.#lastRateLimitAt = Date.now()

    logger.warn(`[王者接口] 账号 ${this.#maskUserId(userId)} 命中频控 -30107，静默 ${Math.round(RATE_LIMIT_SILENCE_MS / 3600000)} 小时`)

    // 通知是 fire-and-forget：私信发不出去也不能影响请求链路（sendMaster 自己吃异常）
    if (firstHit) {
      notifyAccountRateLimited({
        userId,
        silenceMs: RATE_LIMIT_SILENCE_MS,
        accountCount: this.usableAccountCount()
      }).catch(() => {})
    }

    return RATE_LIMIT_SILENCE_MS
  }

  /** 该账号请求成功即视为它自己恢复，清掉它的静默记录 */
  #clearRateLimit(auth) {
    const userId = this.#toString(auth?.userId)
    if (!userId) return

    // 有记录才说明它此前被限流过，这条日志就是「静默期结束」的信号
    if (this.#rateLimitUntilByUser.has(userId)) {
      logger.mark(`[王者接口] 账号 ${this.#maskUserId(userId)} 频控已恢复，静默期结束`)
    }
    this.#rateLimitUntilByUser.delete(userId)
  }

  /** 最近一次真命中 -30107 的时刻（ms），0 = 从没命中过 */
  lastRateLimitAt() {
    return this.#lastRateLimitAt
  }

  /**
   * 池里所有还能用的账号是不是都在频控冷却里——也就是「现在谁都发不出去」。
   *
   * 给定时轮询用：整轮跳过比逐个订阅去撞省事得多（冷却中的号会被
   * `#runWithCandidates` 一个个跳过，一个真请求都发不出去，白抛错、白写盘）。
   *
   * 判据是「可用账号全在冷却表里」而不是「冷却表非空」：从没被限流过的账号
   * 压根不在表里，只看表会把「池里还有个没试过的号」误判成全池停摆。
   * 单账号部署（绝大多数）下它就等价于「那个号在冷却」。
   *
   * 没有任何可用账号时返回 false —— 那是配置问题，该让请求抛「未找到登录态」，
   * 而不是被轮询当成频控悄悄跳过。
   *
   * 只统计池里的全局账号（候选现在也只有这一类）
   * （那个开关默认关，真靠它兜底的部署极少），所以最多是偏保守地多跳一轮，
   * 代价是这一轮晚个两分钟，不会漏推。
   */
  hasNoAvailableAccount() {
    const now = Date.now()
    const usable = this.#usableAccounts()
    if (!usable.length) return false

    return usable.every(account =>
      (this.#rateLimitUntilByUser.get(this.#toString(account.userId)) || 0) > now)
  }

  /**
   * 池里现在有几个能用的账号。
   *
   * 上层拿它估耗时（请求是**按账号并发**的，N 个号就是 N 路并行，
   * 见 #acquireSlot），也用来判断「这次操作大概要等多久」。
   * 判据和 hasNoAvailableAccount 同一份，别在调用方另写一套。
   */
  usableAccountCount() {
    return this.#usableAccounts().length
  }

  /** 池里没被标记失效、且密钥齐全的账号 */
  #usableAccounts() {
    return authStore.listAccounts().filter(account => !account?.authInvalid && isUsableAuth(account))
  }

  /**
   * 领一个发车名额：排到**这个账号**的队尾，等够 MIN_REQUEST_GAP_MS 再放行。
   * 排行榜批量刷新、推送轮询、用户查询同时到来时在这里自动错峰，
   * 而不是叠着打同一个 token；不同账号各排各的队，互不阻塞。
   *
   * 只管**发出节奏**，不等响应回来——响应时间不该算进间隔里，
   * 更不该让一个慢请求把后面所有人堵住。等响应、重试、换账号都在名额之外做。
   *
   * @param {object|null} auth 本次请求要用的账号，队列按它分；拿不到账号时退化成一条公共队列
   */
  #acquireSlot(auth) {
    const key = this.#toString(auth?.userId) || '__unknown__'
    const prev = this.#queueTailByUser.get(key) || Promise.resolve()

    const slot = prev.then(async () => {
      const last = this.#lastRequestAtByUser.get(key) || 0
      const wait = last + MIN_REQUEST_GAP_MS - Date.now()
      if (wait > 0) {
        await new Promise(resolve => setTimeout(resolve, wait))
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
   * @param {object|null} auth  本次请求使用的账号，冷却按它来查；不传则不查冷却
   * @returns {Promise<{response: Response, release: () => void}>}
   */
  async #gatedFetch(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS, auth = null) {
    await this.#acquireSlot(auth)
    this.#assertNotRateLimited(auth)

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

  #maskUserId(value, keepStart = 3, keepEnd = 3) {
    const text = this.#toString(value)
    if (!text) {
      return ''
    }

    if (text.length <= keepStart + keepEnd) {
      return text
    }

    return `${text.slice(0, keepStart)}***${text.slice(-keepEnd)}`
  }

  #maskValue(value, keepStart = 6, keepEnd = 4) {
    const text = this.#toString(value)
    if (!text) {
      return ''
    }

    if (text.length <= keepStart + keepEnd) {
      return text
    }

    return `${text.slice(0, keepStart)}...${text.slice(-keepEnd)}`
  }

  #sanitizeAuthMessage(message = '') {
    const text = this.#toString(message)
    if (!text) {
      return ''
    }

    return text
      .replace(/(全局账号|目标账号)\s*(\d{5,})/g, (_, label, userId) => `${label} ${this.#maskUserId(userId)}`)
      .replace(/(默认全局账号)\s*(\d{5,})/g, (_, label, userId) => `${label} ${this.#maskUserId(userId)}`)
  }

  #isSensitiveAuthError(error) {
    const message = this.#toString(error?.message)
    if (error instanceof AuthConfigError) {
      return true
    }

    return /营地登录态|全局账号|目标账号|token|userKey|encodeRes|登录失效|重新登录|未找到可用的营地登录态|鉴权|安全参数/i.test(message)
  }

  formatUserFacingError(error, options = {}) {
    const {
      isMaster = false,
      scene = '营地登录异常'
    } = options
    const rawMessage = this.#toString(error?.message)
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

  #buildAuthDebugInfo(auth = {}, source = '', label = '') {
    return {
      source,
      label,
      userId: this.#toString(auth.userId),
      token: this.#maskValue(auth.token),
      userKey: this.#maskValue(auth.userKey),
      encodeRes: this.#maskValue(auth.encodeRes),
      openId: this.#maskValue(auth.openId),
      gameOpenId: this.#maskValue(auth.gameOpenId),
      gameRoleId: this.#toString(auth.gameRoleId),
      gameServerId: this.#toString(auth.gameServerId),
      gameAreaId: this.#toString(auth.gameAreaId),
      gameUserSex: this.#toString(auth.gameUserSex),
      kohDimGender: this.#toString(auth.kohDimGender),
      isGlobalDefault: Boolean(auth.isGlobalDefault),
      priority: Number(auth.priority || 100),
      loginPlatform: this.#toString(auth.loginPlatform),
      ownerBotUserId: this.#toString(auth.ownerBotUserId),
      authInvalid: Boolean(auth.authInvalid),
      authErrorCount: Number(auth.authErrorCount || 0),
      lastAuthErrorAt: this.#toString(auth.lastAuthErrorAt),
      lastAuthErrorMessage: this.#toString(auth.lastAuthErrorMessage)
    }
  }

  /**
   * 读取营地鉴权配置。
   * auth.yaml 只保留策略开关和请求默认值，实际登录态统一来自 AuthPool.json。
   */
  #getBaseAuthConfig() {
    const auth = Config.getDefOrConfig('auth') || {}
    const extraHeaders = auth.extraHeaders && typeof auth.extraHeaders === 'object'
      ? auth.extraHeaders
      : {}

    return {
      gameAreaId: this.#toString(auth.gameAreaId || 1),
      gameUserSex: this.#toString(auth.gameUserSex || 1),
      kohDimGender: this.#toString(auth.kohDimGender || 2),
      serverTimeOffsetMs: Number(auth.serverTimeOffsetMs || 0),
      userAgent: this.#toString(auth.userAgent || 'okhttp/4.9.1'),
      xClientProto: this.#toString(auth.xClientProto || 'https'),
      contentEncrypt: this.#toString(auth.contentEncrypt),
      acceptEncrypt: this.#toString(auth.acceptEncrypt),
      noEncrypt: this.#toString(auth.noEncrypt ?? 1),
      isTrpcRequest: this.#toString(auth.isTrpcRequest ?? true),
      cChannelId: this.#toString(auth.cChannelId || '10003391'),
      cClientVersionCode: this.#toString(auth.cClientVersionCode || '2057957801'),
      cClientVersionName: this.#toString(auth.cClientVersionName || '10.111.0323'),
      cCurrentGameId: this.#toString(auth.cCurrentGameId || '20001'),
      cGameId: this.#toString(auth.cGameId || '20001'),
      cGzip: this.#toString(auth.cGzip ?? 1),
      cIsArm64: this.#toString(auth.cIsArm64 ?? true),
      cSupportArm64: this.#toString(auth.cSupportArm64 ?? true),
      cSystem: this.#toString(auth.cSystem || 'android'),
      cSystemVersionCode: this.#toString(auth.cSystemVersionCode || '34'),
      cSystemVersionName: this.#toString(auth.cSystemVersionName || '14'),
      cpuHardware: this.#toString(auth.cpuHardware || 'qcom'),
      tinkerId: this.#toString(auth.tinkerId || '2057957801_64_0'),
      publicKey: this.#toString(auth.publicKey || DEFAULT_PUBLIC_KEY),
      extraHeaders
    }
  }

  #pickAuthValue(value, fallback) {
    if (value === null || typeof value === 'undefined' || value === '') {
      return fallback
    }

    return value
  }

  #buildAuthConfig(auth = {}, baseAuth = this.#getBaseAuthConfig()) {
    const extraHeaders = {
      ...(baseAuth.extraHeaders && typeof baseAuth.extraHeaders === 'object' ? baseAuth.extraHeaders : {}),
      ...(auth.extraHeaders && typeof auth.extraHeaders === 'object' ? auth.extraHeaders : {})
    }

    return {
      ...baseAuth,
      ...auth,
      enabled: true,
      token: this.#toString(auth.token),
      userId: this.#toString(auth.userId),
      openId: this.#toString(auth.openId),
      gameOpenId: this.#toString(auth.gameOpenId),
      gameRoleId: this.#toString(auth.gameRoleId),
      gameServerId: this.#toString(auth.gameServerId),
      gameAreaId: this.#toString(this.#pickAuthValue(auth.gameAreaId, baseAuth.gameAreaId || 1)),
      gameUserSex: this.#toString(this.#pickAuthValue(auth.gameUserSex, baseAuth.gameUserSex || 1)),
      kohDimGender: this.#toString(this.#pickAuthValue(auth.kohDimGender, baseAuth.kohDimGender || 2)),
      userKey: this.#toString(auth.userKey),
      encodeRes: this.#toString(auth.encodeRes),
      serverTimeOffsetMs: Number(this.#pickAuthValue(auth.serverTimeOffsetMs, baseAuth.serverTimeOffsetMs || 0)),
      xLogUid: this.#toString(auth.xLogUid),
      traceparent: this.#toString(auth.traceparent),
      userAgent: this.#toString(this.#pickAuthValue(auth.userAgent, baseAuth.userAgent || 'okhttp/4.9.1')),
      xClientProto: this.#toString(this.#pickAuthValue(auth.xClientProto, baseAuth.xClientProto || 'https')),
      contentEncrypt: this.#toString(this.#pickAuthValue(auth.contentEncrypt, baseAuth.contentEncrypt)),
      acceptEncrypt: this.#toString(this.#pickAuthValue(auth.acceptEncrypt, baseAuth.acceptEncrypt)),
      noEncrypt: this.#toString(this.#pickAuthValue(auth.noEncrypt, baseAuth.noEncrypt ?? 1)),
      isTrpcRequest: this.#toString(this.#pickAuthValue(auth.isTrpcRequest, baseAuth.isTrpcRequest ?? true)),
      cChannelId: this.#toString(this.#pickAuthValue(auth.cChannelId, baseAuth.cChannelId || '10003391')),
      cClientVersionCode: this.#toString(this.#pickAuthValue(auth.cClientVersionCode, baseAuth.cClientVersionCode || '2057957801')),
      cClientVersionName: this.#toString(this.#pickAuthValue(auth.cClientVersionName, baseAuth.cClientVersionName || '10.111.0323')),
      cCurrentGameId: this.#toString(this.#pickAuthValue(auth.cCurrentGameId, baseAuth.cCurrentGameId || '20001')),
      cGameId: this.#toString(this.#pickAuthValue(auth.cGameId, baseAuth.cGameId || '20001')),
      cGzip: this.#toString(this.#pickAuthValue(auth.cGzip, baseAuth.cGzip ?? 1)),
      cIsArm64: this.#toString(this.#pickAuthValue(auth.cIsArm64, baseAuth.cIsArm64 ?? true)),
      cSupportArm64: this.#toString(this.#pickAuthValue(auth.cSupportArm64, baseAuth.cSupportArm64 ?? true)),
      cSystem: this.#toString(this.#pickAuthValue(auth.cSystem, baseAuth.cSystem || 'android')),
      cSystemVersionCode: this.#toString(this.#pickAuthValue(auth.cSystemVersionCode, baseAuth.cSystemVersionCode || '34')),
      cSystemVersionName: this.#toString(this.#pickAuthValue(auth.cSystemVersionName, baseAuth.cSystemVersionName || '14')),
      cpuHardware: this.#toString(this.#pickAuthValue(auth.cpuHardware, baseAuth.cpuHardware || 'qcom')),
      tinkerId: this.#toString(this.#pickAuthValue(auth.tinkerId, baseAuth.tinkerId || '2057957801_64_0')),
      publicKey: this.#toString(this.#pickAuthValue(auth.publicKey, baseAuth.publicKey || DEFAULT_PUBLIC_KEY)),
      extraHeaders
    }
  }

  #toString(value) {
    if (value === null || typeof value === 'undefined') {
      return ''
    }

    return String(value)
  }

  #previewValue(value, maxLength = 1200) {
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

  #buildRequestDebugInfo(method, url, headers, body, context = {}) {
    return {
      endpoint: context.endpoint || '',
      method,
      url,
      attemptIndex: Number(context.attemptIndex || 0),
      targetUserId: context.targetUserId || '',
      requesterBotUserId: context.requesterBotUserId || '',
      headers,
      body
    }
  }

  #assertAuthReady(auth) {
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

  #getAuthCandidates(targetUserId, requesterBotUserId = '') {
    const baseAuth = this.#getBaseAuthConfig()
    const candidates = authStore.getAuthCandidates(targetUserId)

    const mappedCandidates = candidates.map(candidate => ({
      ...candidate,
      auth: this.#buildAuthConfig(candidate.auth, baseAuth)
    }))

    // 先轮转再打日志：日志要反映**这次实际会按什么顺序试**，打轮转前的顺序
    // 会让人以为「每次都是同一个号打头」而去找轮询为什么没生效（实测踩过）。
    const rotated = this.#rotateGlobals(mappedCandidates)

    logger.debug('[王者接口] 本次请求鉴权候选列表', {
      targetUserId: this.#toString(targetUserId),
      requesterBotUserId: this.#toString(requesterBotUserId),
      candidates: rotated.map(candidate => this.#buildAuthDebugInfo(
        candidate.auth,
        candidate.source,
        candidate.label
      ))
    })

    return rotated
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
   * @param {Array<object>} candidates authStore 给的候选（已按 priority 排好）
   * @returns {Array<object>} 轮转后的候选
   */
  #rotateGlobals(candidates) {
    const globals = candidates.filter(candidate => candidate.source === 'global')
    if (globals.length <= 1) return candidates

    const rest = candidates.filter(candidate => candidate.source !== 'global')
    const start = this.#globalCursor % globals.length
    this.#globalCursor += 1

    return [...globals.slice(start), ...globals.slice(0, start), ...rest]
  }

  #markCandidateAuthFailure(candidate, message = '') {
    if (candidate?.source === 'global') {
      const state = authStore.markAuthFailure(candidate?.auth?.userId, message)
      if (state?.newlyInvalid) {
        void this.#notifyGlobalAuthInvalid(message, candidate)
      }
      return
    }

    authStore.markAuthFailure(candidate?.auth?.userId, message)
  }

  #markCandidateAuthSuccess(candidate) {
    authStore.markAuthSuccess(candidate?.auth?.userId)
  }

  async #notifyGlobalAuthInvalid(message = '', candidate = null) {
    try {
      if (typeof Bot !== 'object' || typeof Bot.sendMasterMsg !== 'function') {
        return
      }

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

      await Bot.sendMasterMsg(lines.join('\n'), Bot.uin, 0)
    } catch (error) {
      logger.warn(`[王者接口] 发送全局账号失效提醒失败: ${error.message}`)
    }
  }

  #buildUuid() {
    return crypto.randomUUID().toUpperCase()
  }

  #getXLogUid(auth) {
    return auth.xLogUid || this.generatedXLogUid
  }

  #buildTraceparent(auth) {
    if (auth.traceparent) {
      return auth.traceparent
    }

    const traceId = crypto.randomBytes(16).toString('hex')
    const spanId = crypto.randomBytes(8).toString('hex')
    return `00-${traceId}-${spanId}-01`
  }

  #getTimestamp(auth) {
    return Date.now() + auth.serverTimeOffsetMs
  }

  #buildNonce(prefix, timestamp) {
    const random = crypto.randomUUID().replace(/-/g, '')
    return `${prefix}${random}:${timestamp}`
  }

  #buildPublicKeyPem(publicKey) {
    const chunks = publicKey.match(/.{1,64}/g) || [publicKey]
    return `-----BEGIN PUBLIC KEY-----\n${chunks.join('\n')}\n-----END PUBLIC KEY-----`
  }

  #decodeEncodeRes(auth) {
    if (!auth.encodeRes) {
      return null
    }

    const decrypted = crypto.publicDecrypt(
      {
        key: this.#buildPublicKeyPem(auth.publicKey),
        padding: crypto.constants.RSA_PKCS1_PADDING
      },
      Buffer.from(auth.encodeRes, 'base64')
    )

    return JSON.parse(decrypted.toString('utf8'))
  }

  #resolveUserKey(auth) {
    if (auth.userKey) {
      return auth.userKey
    }

    const encodeRes = this.#decodeEncodeRes(auth)
    return encodeRes?.userKey || ''
  }

  /**
   * 生成新版营地接口的 encodeParam。
   * 请求体为 { timestamp, nonce }，再使用 userKey 进行 XXTEA 加密并 Base64 编码。
   */
  #generateEncodeParam(auth) {
    const userKey = this.#resolveUserKey(auth)
    if (!userKey) {
      return ''
    }

    const timestamp = this.#getTimestamp(auth)
    const payload = JSON.stringify({
      timestamp,
      nonce: this.#buildNonce(`${auth.userId}:`, timestamp)
    })

    return xxteaEncrypt(Buffer.from(payload, 'utf8'), Buffer.from(userKey, 'utf8')).toString('base64')
  }

  #generateSpecialEncodeParam(auth) {
    const timestamp = this.#getTimestamp(auth)
    const payload = JSON.stringify({
      timestamp,
      nonce: this.#buildNonce(':', timestamp)
    })

    return crypto.publicEncrypt(
      {
        key: this.#buildPublicKeyPem(auth.publicKey),
        padding: crypto.constants.RSA_PKCS1_PADDING
      },
      Buffer.from(payload, 'utf8')
    ).toString('base64')
  }

  #getCommonHeaders(auth, url) {
    const headers = {
      Host: url.includes(this.baseUrls.main) ? 'kohcamp.qq.com' : 'ssl.kohsocialapp.qq.com',
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': auth.userAgent,
      'Content-Encrypt': auth.contentEncrypt,
      'Accept-Encrypt': auth.acceptEncrypt,
      NOENCRYPT: auth.noEncrypt,
      'X-Client-Proto': auth.xClientProto,
      'x-log-uid': this.#getXLogUid(auth)
    }

    headers.traceparent = this.#buildTraceparent(auth)

    return headers
  }

  #getAuthHeaders(auth, url) {
    const headers = {
      ...this.#getCommonHeaders(auth, url),
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

    const encodeParam = this.#generateEncodeParam(auth)
    if (encodeParam) {
      headers.encodeParam = encodeParam
    } else {
      headers.specialEncodeParam = this.#generateSpecialEncodeParam(auth)
    }

    return headers
  }

  #decodeHeaderValue(value) {
    if (!value) {
      return ''
    }

    try {
      // 营地按 form-urlencoded 编码 header：空格是 `+` 而不是 %20，decodeURIComponent 不认它，
      // 直接解会得到「-30107:操作频繁,+请稍后重试」这种带加号的文案，
      // 而这段 returnMsg 会被 #requestWithAuth 拼进错误消息透给用户。
      // 先把 `+` 还原成空格再解码；真正的加号服务端会编成 %2B，不会被误伤
      return decodeURIComponent(value.replace(/\+/g, ' '))
    } catch {
      return value
    }
  }

  #parseJson(text) {
    if (!text) {
      return {}
    }

    return JSON.parse(text)
  }

  /**
   * 营地接口在 campencrypt=true 时，响应体会被 userKey 加密。
   */
  #decryptCampResponse(text, auth) {
    const userKey = this.#resolveUserKey(auth)
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
   */
  async #parseResponse(response, auth, context = {}) {
    const encryptParamErr = response.headers.get('encryptparamerr') || response.headers.get('encryptParamErr')
    if (encryptParamErr) {
      throw new AuthConfigError(`接口安全参数校验失败 (encryptParamErr=${encryptParamErr})，请更新当前账号的 token / userKey / encodeRes 或客户端参数`)
    }

    const returnCode = response.headers.get('returncode') || response.headers.get('returnCode')
    const returnMsg = this.#decodeHeaderValue(response.headers.get('returnmsg') || response.headers.get('returnMsg'))

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
      rawTextPreview: this.#previewValue(text),
      payloadPreview: this.#previewValue(payloadText)
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
      const parsed = this.#parseJson(payloadText)
      logger.debug('[王者接口] 响应解析结果', {
        endpoint: context.endpoint || '',
        method: context.method || '',
        status: response.status,
        parsedPreview: this.#previewValue(parsed)
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

  #isAuthRelatedError(error) {
    if (error instanceof AuthConfigError) {
      return true
    }

    const message = error?.message || ''
    return /encryptparamerr|安全参数|鉴权|token|encodeRes|userKey/i.test(message)
  }

  #isAuthFailureResponse(data) {
    const returnMsg = this.#toString(data?.returnMsg || data?.message || data?.msg)
    if (!returnMsg) {
      return false
    }

    return /登录|登录态|token|鉴权|安全参数|重新登录|权限/i.test(returnMsg)
  }

  async #requestWithAuth(method, url, body, additionalHeaders, retries, auth, context = {}) {
    const requestBody = body ? JSON.stringify(body) : null

    for (let attempt = 0; attempt <= retries; attempt++) {
      // 每次尝试都重新签一次名：#getAuthHeaders 生成的 crand 是 Date.now()、
      // encodeParam 的 payload 里也带 timestamp + nonce，退避 1~2 秒后拿旧签名重发
      // 等于「注定失败的重试」。签名必须跟着这一次尝试现算。
      const headers = {
        ...this.#getAuthHeaders(auth, url),
        ...additionalHeaders
      }

      try {
        logger.debug('[王者接口] 请求参数调试', this.#buildRequestDebugInfo(
          method,
          url,
          headers,
          requestBody,
          {
            ...context,
            attemptIndex: attempt
          }
        ))

        const { response, release } = await this.#gatedFetch(url, {
          method,
          headers,
          body: requestBody
        }, REQUEST_TIMEOUT_MS, auth)

        let data
        try {
          data = await this.#parseResponse(response, auth, context)
        } finally {
          release()
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${data.message || data.returnMsg || response.statusText}`)
        }

        return data
      } catch (error) {
        // 频控和鉴权配置错误都不该重试：前者重试只会加重频控、把冷却翻倍，
        // 后者换多少次也还是缺字段
        if (attempt === retries || error instanceof AuthConfigError || error instanceof RateLimitError) {
          throw error
        }

        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)))
      }
    }
  }

  /**
   * 通用请求方法。
   * 统一负责构造新版营地请求头、超时控制、重试和错误处理。
   *
   * 这里不做频控预检：冷却已经按账号记，此刻还没选账号，判断不了该查谁。
   * 冷却中的号由 #runWithCandidates 逐个跳过，而跳过发生在发请求之前，
   * 和原先「连队都不排」的效果一致。
   *
   * 真正的错峰在 #gatedFetch 里按「每次 fetch」做，而不是把整条候选账号循环 ×
   * 重试链塞进队列——那样一个慢请求会独占队头几十秒。
   */
  async #request(method, endpoint, body = null, additionalHeaders = {}, retries = 2, targetUserId = '', requesterBotUserId = '') {
    return this.#requestWithCandidates(method, endpoint, body, additionalHeaders, retries, targetUserId, requesterBotUserId)
  }

  /**
   * 候选账号循环的公共骨架。
   *
   * 依次用候选账号发请求：鉴权类失败就标记该账号并回退到下一个，全部失败则抛出最后一个错误。
   * 真正有差异的只有两件事——**怎么发请求**、**业务错误码怎么判定**，分别由 execute 和
   * onBusinessCode 注入；循环骨架、鉴权失败回退、频控冷却、成功后的状态更新两处完全一致。
   *
   * 候选列表的顺序由 authStore.getAuthCandidates 决定：多个全局账号时它是轮询旋转过的
   * （本轮该用的号在队首），所以「换号重试」同时也是「轮换到下一个账号」。
   *
   * @param {object} opts
   * @param {string} opts.url  实际请求地址（已含 baseUrl 前缀），只用于兜底日志
   * @param {Array} opts.candidates  #getAuthCandidates 的结果
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
  async #runWithCandidates({ url, candidates, context = {}, execute, onBusinessCode, errorLogExtra = {} }) {
    const { endpoint, method, targetUserId = '', requesterBotUserId = '' } = context
    let lastError = null

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const isLast = index >= candidates.length - 1

      // 这个号还在频控冷却里：跳过它，改用下一个候选，不占请求名额。
      //
      // 必须在 try 之前判：冷却时 #gatedFetch 会抛 RateLimitError，一旦落到下面的
      // catch，会被当作「非鉴权错误」直接 break 掉整个循环，后面的候选就没机会了。
      const cooldownLeft = this.#rateLimitCooldownLeft(candidate.auth)
      if (cooldownLeft > 0) {
        lastError = new RateLimitError(`营地接口暂时被限流，约 ${describeWait(cooldownLeft)}后恢复，请稍后再试`)
        logger.warn(`[王者接口] ${candidate.label} 仍在频控冷却中，暂时跳过它`)

        if (!isLast) {
          continue
        }

        break
      }

      try {
        logger.debug('[王者接口] 尝试使用鉴权账号发起请求', {
          endpoint,
          method,
          targetUserId: this.#toString(targetUserId),
          requesterBotUserId: this.#toString(requesterBotUserId),
          attemptIndex: index,
          auth: {
            source: candidate.source,
            label: candidate.label,
            userId: this.#toString(candidate.auth.userId),
            isGlobalDefault: Boolean(candidate.auth.isGlobalDefault),
            priority: Number(candidate.auth.priority || 100)
          }
        })

        this.#assertAuthReady(candidate.auth)
        const data = await execute(candidate)
        const decision = onBusinessCode(data, candidate, { isLast })

        if (decision.action === 'return') {
          return decision.value
        }

        if (decision.action === 'rate-limit') {
          // 只冷却触发频控的这个号，然后换下一个候选——池子里还有好号就不该整体停摆
          const cooldown = this.#markRateLimited(candidate.auth)
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
            this.#markCandidateAuthFailure(candidate, decision.error.message)
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
        this.#clearRateLimit(candidate.auth)
        this.#markCandidateAuthSuccess(candidate)

        logger.debug('[王者接口] 请求成功，当前使用鉴权账号', {
          endpoint,
          method,
          targetUserId: this.#toString(targetUserId),
          requesterBotUserId: this.#toString(requesterBotUserId),
          auth: {
            source: candidate.source,
            label: candidate.label,
            userId: this.#toString(candidate.auth.userId)
          }
        })

        return data
      } catch (error) {
        lastError = error

        // 这个号在这轮里被标了冷却（典型是排队期间另一个请求刚把它打到限流，
        // #gatedFetch 里的 #assertNotRateLimited 于是抛了出来）：换下一个候选，
        // 别因为一个号被限流就中断整个循环。
        if (!isLast && error instanceof RateLimitError) {
          logger.warn(`[王者接口] ${candidate.label} 已被限流，改用下一个账号`, {
            endpoint,
            targetUserId,
            requesterBotUserId
          })
          continue
        }

        if (!isLast && this.#isAuthRelatedError(error)) {
          this.#markCandidateAuthFailure(candidate, error.message)
          logger.warn(`[王者接口] ${candidate.label} 请求失败，尝试回退到下一个账号`, {
            endpoint,
            targetUserId,
            requesterBotUserId,
            error: error.message
          })
          continue
        }

        if (this.#isAuthRelatedError(error)) {
          this.#markCandidateAuthFailure(candidate, error.message)
        }

        break
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

  async #requestWithCandidates(method, endpoint, body = null, additionalHeaders = {}, retries = 2, targetUserId = '', requesterBotUserId = '') {
    const url = `${this.baseUrls.main}${endpoint}`
    const candidates = this.#getAuthCandidates(targetUserId, requesterBotUserId)

    if (!candidates.length) {
      throw new AuthConfigError('未找到可用的营地登录态，请先完成营地登录，或在账号池中配置一个可用的全局账号')
    }

    return this.#runWithCandidates({
      url,
      candidates,
      context: { endpoint, method, targetUserId, requesterBotUserId },
      // 主站接口的兜底日志历来带 body，保持原样
      errorLogExtra: { body: JSON.stringify(body) },
      execute: candidate => this.#requestWithAuth(method, url, body, additionalHeaders, retries, candidate.auth, {
        endpoint,
        method,
        targetUserId: this.#toString(targetUserId),
        requesterBotUserId: this.#toString(requesterBotUserId)
      }),
      onBusinessCode: (data, candidate) => {
        const businessCode = Number(data?.returnCode)

        // 频控必须**最先**判。它的 returnMsg 有时也带「登录」「操作频繁」这类字样，
        // 若排在 #isAuthFailureResponse 后面，就会被误判成登录失效，
        // 把这个该进冷却的号错标成 authInvalid。
        if (businessCode === CODE_RATE_LIMITED) {
          return { action: 'rate-limit' }
        }

        // 疑似登录失效响应：标记这个号后换下一个
        if (this.#isAuthFailureResponse(data)) {
          return {
            action: 'retry',
            mark: true,
            reason: '疑似失效',
            error: new AuthConfigError(`${candidate.label} 返回疑似登录失效响应: ${data.returnMsg || data.message || data.msg}`)
          }
        }

        // 主页被隐藏：把**被查的玩家**标注下来，24 小时内主动取数不再碰它
        // （定时轮询 / 批量刷榜 / 群报都会先问 isProfileHidden，见 utils/hiddenProfiles.js）。
        // 记在这里是为了覆盖所有入口，将来新增查询路径也不会漏。
        //
        // 只认 profile 端点：#makeAuthRequest 的 targetUserId 在别的接口上可能是角色ID
        // （getFightData 传的就是 roleId），混进标注会污染。
        if (businessCode === CODE_PROFILE_HIDDEN && endpoint === PROFILE_ENDPOINT) {
          markProfileHidden(targetUserId)
        }

        // 其余业务错误码：账号本身没问题，换账号重试没有意义，也不算「请求成功」，
        // 原样交给上层按 returnCode 自行分流（myKingHomepage 会对隐藏主页提示）。
        if (Number.isFinite(businessCode) && businessCode !== 0) {
          logger.warn(`[王者接口] ${candidate.label} 返回业务错误码 ${businessCode}: ${data.returnMsg || data.message || ''}`.trim(), {
            endpoint,
            targetUserId: this.#toString(targetUserId),
            requesterBotUserId: this.#toString(requesterBotUserId)
          })
          return { action: 'return', value: data }
        }

        return { action: 'success' }
      }
    })
  }

  async #makeAuthRequest(endpoint, body, targetUserId = '', requesterBotUserId = '') {
    return this.#request('POST', endpoint, body, {}, 2, targetUserId, requesterBotUserId)
  }

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
    return this.#request('POST', '/user/getcampfriends', {}, {}, 1, targetUserId)
  }

  /**
   * 获取战绩列表（单页，服务端固定一页 30 场）
   * @param {object} opts
   * @param {number} opts.option   模式筛选，取值见响应里的 options 字段：0=全部 1=5v5排位 16=10v10排位 2=5v5标准 4=巅峰赛 19=2v2巅峰
   * @param {number} opts.lastTime 翻页游标，传上一页响应的 lastTime 取更早的一页；0 为第一页
   */
  async getMoreBattleList(ID, requesterBotUserId = '', { option = 0, lastTime = 0 } = {}) {
    return this.#makeAuthRequest('/game/morebattlelist', {
      lastTime,
      recommendPrivacy: 0,
      apiVersion: 5,
      friendUserId: ID,
      option
    }, ID, requesterBotUserId)
  }

  /** 获取战绩详情 */
  async getBattledetail(ID, battleType, gameSvr, relaySvr, targetRoleId, gameSeq, requesterBotUserId = '') {
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

  /** 获取营地主页信息 */
  async getProfile(ID, requesterBotUserId = '') {
    return this.#makeAuthRequest('/game/koh/profile', {
      targetUserId: ID,
      targetRoleId: '0',
      resVersion: '3',
      recommendPrivacy: '0',
      apiVersion: '2'
    }, ID, requesterBotUserId)
  }

  /** 获取账号常用英雄列表（含场次/胜率/战力/称号） */
  async getProfileHeroList(ID, targetRoleId, requesterBotUserId = '') {
    return this.#makeAuthRequest('/game/profile/herolist', {
      targetUserId: this.#toString(ID),
      targetRoleId: this.#toString(targetRoleId),
      recommendPrivacy: 0
    }, ID, requesterBotUserId)
  }

  /**
   * 获取账号皮肤列表（皮肤墙）。
   * 该接口位于游戏侧域名，使用 form 表单 + token/userId 鉴权，响应不加密。
   * 接口与参数参考自 https://github.com/KimigaiiWuyi/WzryUID
   */
  async getSkinList(ID, requesterBotUserId = '') {
    return this.#requestGameForm('/play/h5getheroskinlist', {
      noCache: '0',
      recommendPrivacy: '0',
      friendUserId: this.#toString(ID)
    }, this.#toString(ID), requesterBotUserId)
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
  async getHeroRecordDetails(roleId, heroId, { roleName = '', serverId = '' } = {}, targetUserId = '', requesterBotUserId = '') {
    return this.#request('POST', '/gametoolbox/hero/record/pagedetails', {
      roleId: this.#toString(roleId),
      heroid: Number(heroId),
      roleName: this.#toString(roleName),
      h5Get: 1
    }, { serverId: this.#toString(serverId) }, 2, targetUserId, requesterBotUserId)
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
  async getHeroBestEquip(heroId, targetUserId = '', requesterBotUserId = '') {
    return this.#request('POST', '/gametoolbox/equip/hero/getherobestequip', {
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
  async getHeroFringeData(heroId, targetUserId = '', requesterBotUserId = '') {
    return this.#request('POST', '/gametoolbox/hero/getherofringedata', {
      heroId: Number(heroId)
    }, {}, 2, targetUserId, requesterBotUserId)
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
  async getGameHeroList(ID, requesterBotUserId = '') {
    return this.#requestGameForm('/play/h5getherolist', {
      noCache: '0',
      recommendPrivacy: '0',
      friendUserId: this.#toString(ID)
    }, this.#toString(ID), requesterBotUserId)
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
  async getSeasonUsuallyHeroList(roleId, requesterBotUserId = '', seasonId = 0) {
    return this.#makeAuthRequest('/hero/getseasonusaullyherolist', {
      recommendPrivacy: 0,
      seasonId,
      roleId: this.#toString(roleId)
    }, roleId, requesterBotUserId)
  }

  #buildGameFormBody(auth, extraFields = {}) {
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
      gameRoleId: this.#toString(auth.gameRoleId) || '0',
      gameServerId: this.#toString(auth.gameServerId) || '0',
      gameUserSex: auth.gameUserSex,
      openId: auth.openId || this.generatedXLogUid,
      tinkerId: auth.tinkerId,
      token: auth.token,
      userId: auth.userId,
      ...extraFields
    }

    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(fields)) {
      params.append(key, this.#toString(value))
    }

    return params.toString()
  }

  #getGameFormHeaders(auth) {
    return {
      Host: 'ssl.kohsocialapp.qq.com:10001',
      'content-encrypt': '',
      'accept-encrypt': '',
      noencrypt: '1',
      'x-client-proto': auth.xClientProto,
      'x-log-uid': this.#getXLogUid(auth),
      kohdimgender: auth.kohDimGender,
      'content-type': 'application/x-www-form-urlencoded',
      'accept-encoding': 'gzip',
      'user-agent': auth.userAgent,
      token: auth.token,
      userid: auth.userId
    }
  }
  async #fetchGameForm(url, auth, body, retries, context = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      // 同 #requestWithAuth：表单头里的 x-log-uid 等字段也按次现算，别跨重试复用
      const headers = this.#getGameFormHeaders(auth)

      try {
        logger.debug('[王者接口] 游戏侧表单请求调试', this.#buildRequestDebugInfo(
          'POST',
          url,
          headers,
          body,
          { ...context, attemptIndex: attempt }
        ))

        const { response, release } = await this.#gatedFetch(url, {
          method: 'POST',
          headers,
          body
        }, REQUEST_TIMEOUT_MS, auth)

        let text
        try {
          text = await response.text()
        } finally {
          release()
        }

        logger.debug('[王者接口] 游戏侧表单原始响应', {
          endpoint: context.endpoint || '',
          status: response.status,
          ok: response.ok,
          rawTextPreview: this.#previewValue(text)
        })

        let data
        try {
          data = this.#parseJson(text)
        } catch (error) {
          throw new Error('接口返回无法解析，请检查当前账号登录态是否有效')
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${data.returnMsg || data.message || response.statusText}`)
        }

        return data
      } catch (error) {
        // 同 #requestWithAuth：频控重试只会加重频控，鉴权配置错误重试也没用
        if (attempt === retries || error instanceof AuthConfigError || error instanceof RateLimitError) {
          throw error
        }

        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)))
      }
    }
  }

  async #requestGameForm(endpoint, extraFields = {}, targetUserId = '', requesterBotUserId = '', retries = 2) {
    // 同 #request：频控按账号记，这里还没选账号，预检交给 #runWithCandidates
    return this.#requestGameFormWithCandidates(endpoint, extraFields, targetUserId, requesterBotUserId, retries)
  }

  async #requestGameFormWithCandidates(endpoint, extraFields = {}, targetUserId = '', requesterBotUserId = '', retries = 2) {
    const url = `${this.baseUrls.game}${endpoint}`
    const candidates = this.#getAuthCandidates(targetUserId, requesterBotUserId)

    if (!candidates.length) {
      throw new AuthConfigError('未找到可用的营地登录态，请先完成营地登录，或在账号池中配置一个可用的全局账号')
    }

    return this.#runWithCandidates({
      url,
      candidates,
      context: { endpoint, method: 'POST', targetUserId, requesterBotUserId },
      execute: candidate => this.#fetchGameForm(
        url,
        candidate.auth,
        // 表单体里含 token/userId/gameRoleId，每个候选账号都得现建一份
        this.#buildGameFormBody(candidate.auth, extraFields),
        retries,
        {
          endpoint,
          method: 'POST',
          targetUserId: this.#toString(targetUserId),
          requesterBotUserId: this.#toString(requesterBotUserId)
        }
      ),
      onBusinessCode: (data, candidate) => {
        const returnCode = Number(data?.returnCode)
        if (!Number.isFinite(returnCode) || returnCode === 0) {
          return { action: 'success' }
        }

        if (returnCode === CODE_RATE_LIMITED) {
          return { action: 'rate-limit' }
        }

        // 皮肤墙的错误响应没有统一的「登录失效」文案，所以额外拿错误码本身当 returnMsg 再判一次
        return {
          action: 'retry',
          reason: '皮肤墙请求返回错误码',
          error: new AuthConfigError(`${candidate.label} 返回错误码 ${returnCode}: ${data.returnMsg || data.message || ''}`.trim()),
          mark: this.#isAuthFailureResponse(data) || this.#isAuthFailureResponse({ returnMsg: String(returnCode) })
        }
      }
    })
  }

  /** 获取赛季页数据 */
  async getSeasonpage(ID, requesterBotUserId = '', seasonId = 0, extraBody = {}) {
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
  async getFightData(roleId, requesterBotUserId = '', { gameBattleType = 10, branchType = 0, dateType = 2 } = {}) {
    return this.#makeAuthRequest('/game/getfightdata', {
      recommendPrivacy: 0,
      dateType,
      roleId: this.#toString(roleId),
      roleFriendId: 0,
      branchType,
      source: 1,
      gameBattleType,
      card: 0
    }, roleId, requesterBotUserId)
  }

  /**
   * 获取英雄梯度榜（T0~T3 热度/胜率/登场率/Ban率）。
   * 数据由官方营地实时返回，返回体自带 updateTime 表示数据更新日期。
   * @param {object} [options]
   * @param {number} [options.rankId=0] 排行榜 ID，默认 0
   * @param {number} [options.segment=3] 段位筛选，对应 tabFilter 下标：1=所有段位 3=巅峰赛1350+ 4=顶端排位 5=赛事
   * @param {number} [options.position=0] 分路筛选，对应 branchFilter 下标：0=全部分路 1=对抗路 2=中路 3=发育路 4=游走 5=打野
   */
  async getdetailranklistbyid({ rankId = 0, segment = 3, position = 0 } = {}) {
    return this.#makeAuthRequest('/hero/getdetailranklistbyid', {
      bottomTab: '',
      rankId,
      segment,
      position,
      recommendPrivacy: 0
    })
  }

  async getHeroFightingCapacity(heroName) {
    const regions = ['aqq', 'awx', 'iqq', 'iwx']
    const results = await Promise.all(regions.map(async (hero) => {
      try {
        const query = new URLSearchParams({
          hero: heroName,
          type: hero
        })
        const res = await fetch(`https://www.sapi.run/hero/select.php?${query.toString()}`, {
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
  async getTvChoiceItems(targetUserId = '', requesterBotUserId = '') {
    return this.#request('POST', '/info/tv/choiceitem', {}, {}, 2, targetUserId, requesterBotUserId)
  }

  async getHeroList() {
    try {
      return await this.#fetchExternalJson('https://pvp.qq.com/web201605/js/herolist.json')
    } catch (error) {
      logger.error('[获取英雄列表] 接口请求失败', error)
      throw new Error(`获取英雄列表失败。错误: ${error.message || error}`)
    }
  }

  // 官网资料库的皮肤总表（约 780KB，816 条），按皮肤ID索引，含每张皮肤的官方立绘图。
  // 营地接口对刚上线的新皮肤常只给占位图，这里是唯一图片覆盖率 100% 的公开图源。
  // 体积不小，调用方需自行缓存，勿逐张皮肤调用。
  async getPvpSkinList() {
    try {
      return await this.#fetchExternalJson('https://pvp.qq.com/zlkdatasys/heroskinlist.json')
    } catch (error) {
      logger.error('[获取官网皮肤总表] 接口请求失败', error)
      throw new Error(`获取官网皮肤总表失败。错误: ${error.message || error}`)
    }
  }

  async getHeroXpflby() {
    try {
      return await this.#fetchExternalJson('https://pvp.qq.com/zlkdatasys/data_zlk_xpflby.json')
    } catch (error) {
      logger.error('[获取爆料站-皮肤数据] 接口请求失败', error)
      throw new Error(`获取爆料站-皮肤数据失败。错误: ${error.message || error}`)
    }
  }

  /**
   * 官网装备总表（121 条，`{item_id, item_name, item_type, price, total_price, des1}`）。
   * 出装建议只给装备 ID，装备名要靠这张表翻。
   * 这个文件是 **UTF-8**，别跟着英雄详情页一起按 GB18030 解（会解成「閾佸墤」这种乱码）。
   */
  async getPvpItemList() {
    try {
      return await this.#fetchExternalJson('https://pvp.qq.com/web201605/js/item.json')
    } catch (error) {
      logger.error('[获取官网装备表] 接口请求失败', error)
      throw new Error(`获取官网装备表失败。错误: ${error.message || error}`)
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
  async getHeroDetailPage(pinyin) {
    const name = this.#toString(pinyin).trim()
    if (!name) {
      throw new Error('缺少英雄拼音')
    }

    const url = `https://pvp.qq.com/web201605/herodetail/${encodeURIComponent(name)}.shtml`

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

  /**
   * 拉一个外站公开 JSON。这些地址不需要鉴权、也不该占营地的请求名额，
   * 但同样必须设超时：herolist.json 在 #查战绩 的必经路径上，
   * 对端一挂，指令就永久没有回复（Yunzai 那头也不会替你兜）。
   */
  async #fetchExternalJson(url, timeoutMs = EXTERNAL_TIMEOUT_MS) {
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
}

/** 单例。起个名字是因为下面 estimateRequestSeconds 要用它（default export 是匿名的） */
const apiService = new ApiService()

/**
 * 估算「N 次请求大概要几秒」，给上层的「约需 XX 秒」提示用。
 *
 * **不能再用「次数 × MIN_REQUEST_GAP_MS」直接算**：请求是按账号并发跑的
 * （`#acquireSlot` 按账号分队列、`#rotateGlobals` 把请求轮着分给不同的号），
 * 4 个账号就是 4 路并行，照老算法会高估四倍，用户等 10 秒却被告知 40 秒。
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
