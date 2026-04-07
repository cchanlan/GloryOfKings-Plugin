import crypto from 'node:crypto'
import fetch from 'node-fetch'
import { Config } from '#components'
import { decrypt as xxteaDecrypt, encrypt as xxteaEncrypt } from './xxtea.js'

const DEFAULT_PUBLIC_KEY = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC0h62mV/zjJtFsNdfFNlxksfUOpjDI2KCcBrPiA8T7szABT4InLDTrdXAW84QyGNiazB0i7pgPCNGSAYbiJrCRutZ5jQsVS0Wg/RnXfwVQDJcAHJDjP5IXyroeLX7NUxDai8nPcpfRsvq6sneobyPexZSH0TlVSnecsJZTj5wu/wIDAQAB'

class AuthConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthConfigError'
  }
}

/**
 * API 服务类，封装了王者营地相关接口请求。
 * 新版营地接口需要额外的安全参数，因此这里统一处理鉴权头、encodeParam 和响应解密。
 */
class ApiService {
  constructor() {
    this.baseUrls = {
      main: 'https://kohcamp.qq.com',
      game: 'https://ssl.kohsocialapp.qq.com:10001'
    }
    this.generatedXLogUid = this.#buildUuid()
  }

  /**
   * 读取营地鉴权配置。
   * 固定客户端参数走代码内置，只有登录态和安全相关字段需要从 auth.yaml 提供。
   */
  #getAuthConfig() {
    const auth = Config.getDefOrConfig('auth') || {}
    const extraHeaders = auth.extraHeaders && typeof auth.extraHeaders === 'object'
      ? auth.extraHeaders
      : {}

    return {
      enabled: Boolean(auth.enabled),
      token: this.#toString(auth.token),
      userId: this.#toString(auth.userId),
      openId: this.#toString(auth.openId),
      gameOpenId: this.#toString(auth.gameOpenId),
      gameRoleId: this.#toString(auth.gameRoleId),
      gameServerId: this.#toString(auth.gameServerId),
      gameAreaId: this.#toString(auth.gameAreaId || 1),
      gameUserSex: this.#toString(auth.gameUserSex || 1),
      kohDimGender: this.#toString(auth.kohDimGender || 2),
      userKey: this.#toString(auth.userKey),
      encodeRes: this.#toString(auth.encodeRes),
      serverTimeOffsetMs: Number(auth.serverTimeOffsetMs || 0),
      xLogUid: this.#toString(auth.xLogUid),
      traceparent: this.#toString(auth.traceparent),
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

  #toString(value) {
    if (value === null || typeof value === 'undefined') {
      return ''
    }

    return String(value)
  }

  #assertAuthReady(auth) {
    if (!auth.enabled) {
      throw new AuthConfigError('请先在 plugins/GloryOfKings-Plugin/config/config/auth.yaml 中启用并填写营地鉴权参数')
    }

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
      return decodeURIComponent(value)
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
      throw new AuthConfigError('接口响应已加密，但 auth.yaml 中缺少 userKey 或 encodeRes')
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
  async #parseResponse(response, auth) {
    const encryptParamErr = response.headers.get('encryptparamerr') || response.headers.get('encryptParamErr')
    if (encryptParamErr) {
      throw new AuthConfigError(`接口安全参数校验失败 (encryptParamErr=${encryptParamErr})，请更新 auth.yaml 中的 token/userKey/encodeRes/client 相关字段`)
    }

    const returnCode = response.headers.get('returncode') || response.headers.get('returnCode')
    const returnMsg = this.#decodeHeaderValue(response.headers.get('returnmsg') || response.headers.get('returnMsg'))

    const text = await response.text()
    const payloadText = response.headers.get('campencrypt') === 'true'
      ? this.#decryptCampResponse(text, auth)
      : text

    if (!payloadText && returnCode) {
      return {
        returnCode,
        returnMsg
      }
    }

    try {
      return this.#parseJson(payloadText)
    } catch (error) {
      logger.error(`[王者接口] 解析响应失败: ${error.message}`, {
        status: response.status,
        returnCode,
        returnMsg,
        preview: payloadText?.slice(0, 200)
      })
      throw new Error('接口返回无法解析，请检查 auth.yaml 中的安全参数是否完整')
    }
  }

  /**
   * 通用请求方法。
   * 统一负责构造新版营地请求头、超时控制、重试和错误处理。
   */
  async #request(method, endpoint, body = null, additionalHeaders = {}, retries = 2) {
    const auth = this.#getAuthConfig()
    this.#assertAuthReady(auth)

    const url = `${this.baseUrls.main}${endpoint}`
    const headers = {
      ...this.#getAuthHeaders(auth, url),
      ...additionalHeaders
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : null,
          signal: controller.signal
        })

        clearTimeout(timer)
        const data = await this.#parseResponse(response, auth)

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${data.message || data.returnMsg || response.statusText}`)
        }

        return data
      } catch (error) {
        clearTimeout(timer)

        if (attempt === retries || error instanceof AuthConfigError) {
          logger.error(`API请求失败: ${error.message}`, {
            url,
            method,
            body: JSON.stringify(body)
          })
          throw error
        }

        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)))
      }
    }
  }

  async #makeAuthRequest(endpoint, body) {
    return this.#request('POST', endpoint, body)
  }

  /** 获取战绩列表 */
  async getMoreBattleList(ID) {
    return this.#makeAuthRequest('/game/morebattlelist', {
      lastTime: 0,
      recommendPrivacy: 0,
      apiVersion: 5,
      friendUserId: ID,
      option: 0
    })
  }

  /** 获取战绩详情 */
  async getBattledetail(ID, battleType, gameSvr, relaySvr, targetRoleId, gameSeq) {
    return this.#makeAuthRequest('/game/battledetail', {
      recommendPrivacy: 0,
      battleType,
      gameSvr,
      relaySvr,
      targetRoleId,
      gameSeq,
      friendUserId: ID
    })
  }

  /** 获取营地主页信息 */
  async getProfile(ID) {
    return this.#makeAuthRequest('/game/koh/profile', {
      targetUserId: ID,
      targetRoleId: '0',
      resVersion: '3',
      recommendPrivacy: '0',
      apiVersion: '2'
    })
  }

  /** 获取赛季页数据 */
  async getSeasonpage(ID) {
    return this.#makeAuthRequest('/game/seasonpage', {
      recommendPrivacy: 0,
      seasonId: 0,
      roleId: ID
    })
  }

  async getdetailranklistbyid() {
    return this.#makeAuthRequest('/hero/getdetailranklistbyid', {
      bottomTab: '',
      rankId: 0,
      segment: 1,
      position: 0,
      recommendPrivacy: 0
    })
  }

  async getHeroFightingCapacity(heroName) {
    const regions = ['aqq', 'awx', 'iqq', 'iwx']
    return Promise.all(regions.map(async (hero) => {
      try {
        const res = await fetch(`https://www.sapi.run/hero/select.php?hero=${heroName}&type=${hero}`)
        const data = await res.json()
        if (data.code !== 200) throw new Error(`该英雄不存在，请检查。错误: ${data}`)
        return data
      } catch (error) {
        logger.error(`[获取英雄战力] ${heroName}(${hero}) 请求失败`, error)
        return { code: 500, msg: error.message }
      }
    }))
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
