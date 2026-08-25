import crypto from 'node:crypto'
import fetch from 'node-fetch'
import { Config } from '#components'
import { decrypt as xxteaDecrypt, encrypt as xxteaEncrypt } from './xxtea.js'
import authStore from './authStore.js'

const DEFAULT_PUBLIC_KEY = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC0h62mV/zjJtFsNdfFNlxksfUOpjDI2KCcBrPiA8T7szABT4InLDTrdXAW84QyGNiazB0i7pgPCNGSAYbiJrCRutZ5jQsVS0Wg/RnXfwVQDJcAHJDjP5IXyroeLX7NUxDai8nPcpfRsvq6sneobyPexZSH0TlVSnecsJZTj5wu/wIDAQAB'

/** 营地频控错误码：操作频繁 */
const CODE_RATE_LIMITED = -30107

/**
 * 相邻两次真实 HTTP 请求的最小间隔。营地接口按请求方账号限频，
 * 排行榜一次 19 连发、推送轮询和用户查询叠加时就触发 -30107，
 * 全局串行队列把所有端点的请求拉平到这个节奏
 */
const MIN_REQUEST_GAP_MS = 1200

/** 命中 -30107 后的冷却：60s 起步，冷却期间连续再命中则翻倍，封顶 10 分钟 */
const RATE_LIMIT_BASE_COOLDOWN_MS = 60 * 1000
const RATE_LIMIT_MAX_COOLDOWN_MS = 10 * 60 * 1000

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
  /** 频控冷却截止时间戳（ms），0 表示不在冷却 */
  #rateLimitUntil = 0
  /** 冷却期间连续命中频控的次数，决定下一次冷却时长 */
  #rateLimitHits = 0
  /** 全局串行队列的队尾 */
  #queueTail = Promise.resolve()
  /** 上次实际请求发出时刻 */
  #lastRequestAt = 0

  constructor() {
    this.baseUrls = {
      main: 'https://kohcamp.qq.com',
      game: 'https://ssl.kohsocialapp.qq.com:10001'
    }
    this.generatedXLogUid = this.#buildUuid()
  }

  /* ------------------------------------------------------ 频控冷却与请求队列 */

  /**
   * 冷却检查。账号池通常只有一个 token，-30107 后换号重试没有意义，
   * 唯一有效的策略是全体调用方立刻停手等冷却——期间的新请求在这里快速失败，
   * 不再打到营地接口加重频控。冷却过期或某次请求成功后自动恢复
   */
  #assertNotRateLimited() {
    if (Date.now() >= this.#rateLimitUntil) return

    const waitSec = Math.ceil((this.#rateLimitUntil - Date.now()) / 1000)
    throw new RateLimitError(`营地接口操作频繁，冷却中（约 ${waitSec} 秒后自动恢复），请稍后再试`)
  }

  /** 记录一次 -30107 命中，返回本次冷却毫秒数 */
  #markRateLimited() {
    this.#rateLimitHits = Math.min(this.#rateLimitHits + 1, 10)
    const cooldown = Math.min(
      RATE_LIMIT_BASE_COOLDOWN_MS * Math.pow(2, this.#rateLimitHits - 1),
      RATE_LIMIT_MAX_COOLDOWN_MS
    )
    this.#rateLimitUntil = Date.now() + cooldown
    logger.warn(`[王者接口] 命中频控 -30107，进入 ${Math.round(cooldown / 1000)}s 冷却（连续第 ${this.#rateLimitHits} 次）`)
    return cooldown
  }

  /** 任一请求成功即视为恢复，清空冷却与连续命中计数 */
  #clearRateLimit() {
    if (this.#rateLimitHits > 0) {
      logger.mark('[王者接口] 频控已恢复，清除冷却')
    }
    this.#rateLimitHits = 0
    this.#rateLimitUntil = 0
  }

  /**
   * 领一个发车名额：排到队尾，等够 MIN_REQUEST_GAP_MS 再放行。
   * 排行榜批量刷新（19 连发）、推送轮询、用户查询同时到来时在这里自动错峰，
   * 而不是叠着打同一个 token。
   *
   * 只管**发出节奏**，不等响应回来——响应时间不该算进间隔里，
   * 更不该让一个慢请求把后面所有人堵住。等响应、重试、换账号都在名额之外做。
   */
  #acquireSlot() {
    const slot = this.#queueTail.then(async () => {
      const wait = this.#lastRequestAt + MIN_REQUEST_GAP_MS - Date.now()
      if (wait > 0) {
        await new Promise(resolve => setTimeout(resolve, wait))
      }
      this.#lastRequestAt = Date.now()
    })

    this.#queueTail = slot.then(() => {}, () => {})
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
   * 冷却检查放在拿到名额之后：排队期间冷却可能已被前面的请求触发，
   * 这时立刻快速失败，不再打到营地接口加重频控。
   */
  async #gatedFetch(url, options) {
    await this.#acquireSlot()
    this.#assertNotRateLimited()
    return fetch(url, options)
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
      .replace(/(全局账号|共享账号|目标账号)\s*(\d{5,})/g, (_, label, userId) => `${label} ${this.#maskUserId(userId)}`)
      .replace(/(默认全局账号)\s*(\d{5,})/g, (_, label, userId) => `${label} ${this.#maskUserId(userId)}`)
  }

  #isSensitiveAuthError(error) {
    const message = this.#toString(error?.message)
    if (error instanceof AuthConfigError) {
      return true
    }

    return /营地登录态|全局账号|共享账号|目标账号|token|userKey|encodeRes|登录失效|重新登录|未找到可用的营地登录态|鉴权|安全参数/i.test(message)
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
      lines.push('处理建议：可使用【#营地wx全局登录】重新扫码更新全局账号。')
    } else if (/未找到可用的营地登录态/i.test(rawMessage)) {
      lines.push('处理建议：可先通过【#营地wx登录】补充登录态，或在锅巴账号列表中配置可用账号。')
    } else {
      lines.push('处理建议：可使用【#营地wx登录】重新登录，或在锅巴账号列表中检查相关字段。')
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
      shared: Boolean(auth.shared),
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
      enableAccountPool: auth.enableAccountPool !== false,
      allowPersonalAuthFallback: auth.allowPersonalAuthFallback === true,
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
    const candidates = authStore.getAuthCandidates(targetUserId, {
      requesterBotUserId,
      includeTarget: baseAuth.enableAccountPool && baseAuth.allowPersonalAuthFallback,
      includeShared: baseAuth.enableAccountPool,
      includeGlobal: true
    })

    const mappedCandidates = candidates.map(candidate => ({
      ...candidate,
      auth: this.#buildAuthConfig(candidate.auth, baseAuth)
    }))

    logger.debug('[王者接口] 本次请求鉴权候选列表', {
      targetUserId: this.#toString(targetUserId),
      requesterBotUserId: this.#toString(requesterBotUserId),
      enableAccountPool: baseAuth.enableAccountPool,
      allowPersonalAuthFallback: baseAuth.allowPersonalAuthFallback,
      candidates: mappedCandidates.map(candidate => this.#buildAuthDebugInfo(
        candidate.auth,
        candidate.source,
        candidate.label
      ))
    })

    return mappedCandidates
  }

  #markCandidateAuthFailure(candidate, message = '') {
    if (candidate?.source === 'global') {
      const state = authStore.markAuthFailure(candidate?.auth?.userId, message)
      if (state?.newlyInvalid) {
        void this.#notifyGlobalAuthInvalid(message)
      }
      return
    }

    authStore.markAuthFailure(candidate?.auth?.userId, message)
  }

  #markCandidateAuthSuccess(candidate) {
    authStore.markAuthSuccess(candidate?.auth?.userId)
  }

  async #notifyGlobalAuthInvalid(message = '') {
    try {
      if (typeof Bot !== 'object' || typeof Bot.sendMasterMsg !== 'function') {
        return
      }

      const sanitizedMessage = this.#sanitizeAuthMessage(message)
      const lines = [
        '王者插件默认全局账号登录态已失效，后续请求将自动跳过该账号。',
        sanitizedMessage ? `失效原因：${sanitizedMessage}` : '',
        '可使用【#营地wx全局登录】重新扫码更新全局 token。'
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
    const headers = {
      ...this.#getAuthHeaders(auth, url),
      ...additionalHeaders
    }
    const requestBody = body ? JSON.stringify(body) : null

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)

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

        const response = await this.#gatedFetch(url, {
          method,
          headers,
          body: requestBody,
          signal: controller.signal
        })

        clearTimeout(timer)
        const data = await this.#parseResponse(response, auth, context)

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${data.message || data.returnMsg || response.statusText}`)
        }

        return data
      } catch (error) {
        clearTimeout(timer)

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
   * 冷却期内直接快速失败，连队都不排。真正的错峰在 #gatedFetch 里按「每次 fetch」
   * 做，而不是把整条候选账号循环 × 重试链塞进队列——那样一个慢请求会独占队头几十秒。
   */
  async #request(method, endpoint, body = null, additionalHeaders = {}, retries = 2, targetUserId = '', requesterBotUserId = '') {
    this.#assertNotRateLimited()
    return this.#requestWithCandidates(method, endpoint, body, additionalHeaders, retries, targetUserId, requesterBotUserId)
  }

  async #requestWithCandidates(method, endpoint, body = null, additionalHeaders = {}, retries = 2, targetUserId = '', requesterBotUserId = '') {
    const url = `${this.baseUrls.main}${endpoint}`
    const candidates = this.#getAuthCandidates(targetUserId, requesterBotUserId)

    if (!candidates.length) {
      throw new AuthConfigError('未找到可用的营地登录态，请先完成营地登录，或在账号池中配置一个可用的全局账号')
    }

    let lastError = null

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]

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
            shared: Boolean(candidate.auth.shared),
            priority: Number(candidate.auth.priority || 100)
          }
        })

        this.#assertAuthReady(candidate.auth)
        const data = await this.#requestWithAuth(method, url, body, additionalHeaders, retries, candidate.auth, {
          endpoint,
          method,
          targetUserId: this.#toString(targetUserId),
          requesterBotUserId: this.#toString(requesterBotUserId)
        })

        if (this.#isAuthFailureResponse(data)) {
          lastError = new AuthConfigError(`${candidate.label} 返回疑似登录失效响应: ${data.returnMsg || data.message || data.msg}`)
          this.#markCandidateAuthFailure(candidate, lastError.message)

          if (index < candidates.length - 1) {
            logger.warn(`[王者接口] ${candidate.label} 疑似失效，尝试回退到下一个账号`, {
              endpoint,
              targetUserId,
              requesterBotUserId,
              returnCode: data.returnCode,
              returnMsg: data.returnMsg || data.message || data.msg
            })
            continue
          }

          logger.warn(`[王者接口] ${candidate.label} 疑似失效，且没有更多可回退账号`, {
            endpoint,
            targetUserId,
            requesterBotUserId,
            returnCode: data.returnCode,
            returnMsg: data.returnMsg || data.message || data.msg
          })
          throw lastError
        }

        // 业务错误码（频控 -30107、主页隐藏 -10107 等）：账号本身没问题，换账号重试没有意义，
        // 也不算「请求成功」。
        // -30107 直接触发全局冷却并抛错，让所有调用方立刻停手等恢复（单账号下重试只会加重频控）；
        // 其它错误码响应原样交给上层按 returnCode 自行分流
        // （pushStore / rankStore 会对频控退避重试，myKingHomepage 会对隐藏主页提示）。
        const businessCode = Number(data?.returnCode)
        if (Number.isFinite(businessCode) && businessCode !== 0) {
          if (businessCode === CODE_RATE_LIMITED) {
            const cooldown = this.#markRateLimited()
            throw new RateLimitError(`营地接口操作频繁(-30107)，冷却 ${Math.round(cooldown / 1000)}s 后自动恢复，请稍后再试`)
          }

          logger.warn(`[王者接口] ${candidate.label} 返回业务错误码 ${businessCode}: ${data.returnMsg || data.message || ''}`.trim(), {
            endpoint,
            targetUserId: this.#toString(targetUserId),
            requesterBotUserId: this.#toString(requesterBotUserId)
          })
          return data
        }

        this.#clearRateLimit()
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

        if (index < candidates.length - 1 && this.#isAuthRelatedError(error)) {
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
        body: JSON.stringify(body),
        targetUserId,
        requesterBotUserId
      })
      throw lastError
    }
  }

  async #makeAuthRequest(endpoint, body, targetUserId = '', requesterBotUserId = '') {
    return this.#request('POST', endpoint, body, {}, 2, targetUserId, requesterBotUserId)
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
    const headers = this.#getGameFormHeaders(auth)

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)

      try {
        logger.debug('[王者接口] 游戏侧表单请求调试', this.#buildRequestDebugInfo(
          'POST',
          url,
          headers,
          body,
          { ...context, attemptIndex: attempt }
        ))

        const response = await this.#gatedFetch(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal
        })

        clearTimeout(timer)
        const text = await response.text()

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
        clearTimeout(timer)

        // 同 #requestWithAuth：频控重试只会加重频控，鉴权配置错误重试也没用
        if (attempt === retries || error instanceof AuthConfigError || error instanceof RateLimitError) {
          throw error
        }

        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)))
      }
    }
  }

  async #requestGameForm(endpoint, extraFields = {}, targetUserId = '', requesterBotUserId = '', retries = 2) {
    this.#assertNotRateLimited()
    return this.#requestGameFormWithCandidates(endpoint, extraFields, targetUserId, requesterBotUserId, retries)
  }

  async #requestGameFormWithCandidates(endpoint, extraFields = {}, targetUserId = '', requesterBotUserId = '', retries = 2) {
    const url = `${this.baseUrls.game}${endpoint}`
    const candidates = this.#getAuthCandidates(targetUserId, requesterBotUserId)

    if (!candidates.length) {
      throw new AuthConfigError('未找到可用的营地登录态，请先完成营地登录，或在账号池中配置一个可用的全局账号')
    }

    let lastError = null

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]

      try {
        this.#assertAuthReady(candidate.auth)
        const body = this.#buildGameFormBody(candidate.auth, extraFields)
        const data = await this.#fetchGameForm(url, candidate.auth, body, retries, {
          endpoint,
          method: 'POST',
          targetUserId: this.#toString(targetUserId),
          requesterBotUserId: this.#toString(requesterBotUserId)
        })

        const returnCode = Number(data?.returnCode)
        if (Number.isFinite(returnCode) && returnCode !== 0) {
          if (returnCode === CODE_RATE_LIMITED) {
            const cooldown = this.#markRateLimited()
            throw new RateLimitError(`营地接口操作频繁(-30107)，冷却 ${Math.round(cooldown / 1000)}s 后自动恢复，请稍后再试`)
          }

          lastError = new AuthConfigError(`${candidate.label} 返回错误码 ${returnCode}: ${data.returnMsg || data.message || ''}`.trim())

          if (this.#isAuthFailureResponse(data) || this.#isAuthFailureResponse({ returnMsg: String(returnCode) })) {
            this.#markCandidateAuthFailure(candidate, lastError.message)
          }

          if (index < candidates.length - 1) {
            logger.warn(`[王者接口] ${candidate.label} 皮肤墙请求返回错误码，尝试回退下一个账号`, {
              endpoint,
              targetUserId,
              returnCode
            })
            continue
          }

          throw lastError
        }

        this.#markCandidateAuthSuccess(candidate)
        return data
      } catch (error) {
        lastError = error

        if (index < candidates.length - 1 && this.#isAuthRelatedError(error)) {
          this.#markCandidateAuthFailure(candidate, error.message)
          logger.warn(`[王者接口] ${candidate.label} 皮肤墙请求失败，尝试回退下一个账号`, {
            endpoint,
            targetUserId,
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
      logger.error(`API请求失败: ${lastError.message}`, { url, method: 'POST', targetUserId, requesterBotUserId })
      throw lastError
    }
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
        const res = await fetch(`https://www.sapi.run/hero/select.php?${query.toString()}`)

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

  async getHeroList() {
    try {
      const response = await fetch('https://pvp.qq.com/web201605/js/herolist.json')
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      return await response.json()
    } catch (error) {
      logger.error('[获取英雄列表] 接口请求失败', error)
      throw new Error(`获取英雄列表失败。错误: ${error}`)
    }
  }

  // 官网资料库的皮肤总表（约 780KB，816 条），按皮肤ID索引，含每张皮肤的官方立绘图。
  // 营地接口对刚上线的新皮肤常只给占位图，这里是唯一图片覆盖率 100% 的公开图源。
  // 体积不小，调用方需自行缓存，勿逐张皮肤调用。
  async getPvpSkinList() {
    try {
      const response = await fetch('https://pvp.qq.com/zlkdatasys/heroskinlist.json')
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      return await response.json()
    } catch (error) {
      logger.error('[获取官网皮肤总表] 接口请求失败', error)
      throw new Error(`获取官网皮肤总表失败。错误: ${error}`)
    }
  }

  async getHeroXpflby() {
    try {
      const response = await fetch('https://pvp.qq.com/zlkdatasys/data_zlk_xpflby.json')
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      return await response.json()
    } catch (error) {
      logger.error('[获取爆料站-皮肤数据] 接口请求失败', error)
      throw new Error(`获取爆料站-皮肤数据失败。错误: ${error}`)
    }
  }
}

export default new ApiService()
