import crypto from 'node:crypto'
import fetch from 'node-fetch'

/**
 * 王者营地「微信扫码登录」。
 *
 * 一条链路走完：取 SDK ticket → 拉微信二维码 → 轮询扫码结果 → 拿 code 换营地账号。
 * 本文件只负责协议本身，二维码怎么发给用户、账号怎么落盘由调用方管
 * （apps/accountManager.js / utils/index.js）。
 *
 * 下面这些常量都是抓包得到的，不是随手写的，来源逐条注在各自头上。
 */

/* ------------------------------------------------------------------ *
 * 协议常量
 * ------------------------------------------------------------------ */

/** 微信开放平台 AppID —— 营地 App 内置的那个（不是公众号的，别换） */
const WX_APPID = 'wxf4b1e8a3e9aaf978'

/** 营地网关：取 SDK ticket、登录换号都走它 */
const CAMP_API_BASE = 'https://ssl.kohsocialapp.qq.com:10001'

/** 微信开放平台扫码 SDK：取二维码 */
const WX_QRCODE_API = 'https://open.weixin.qq.com/connect/sdk/qrconnect'

/** 微信开放平台扫码 SDK：轮询扫码结果（long 域名是长连接专用，别改成普通域名） */
const WX_QRCODE_POLL_API = 'https://long.open.weixin.qq.com/connect/l/qrconnect'

/**
 * 营地下发的 RSA 公钥（裸 base64，没有 PEM 头尾）。
 * 两个用途：解 encodeRes（取 userKey）、加密 specialEncodeParam。
 */
const CAMP_PUBLIC_KEY = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC0h62mV/zjJtFsNdfFNlxksfUOpjDI2KCcBrPiA8T7szABT4InLDTrdXAW84QyGNiazB0i7pgPCNGSAYbiJrCRutZ5jQsVS0Wg/RnXfwVQDJcAHJDjP5IXyroeLX7NUxDai8nPcpfRsvq6sneobyPexZSH0TlVSnecsJZTj5wu/wIDAQAB'

/** 1024 位 RSA + PKCS#1 v1.5 填充：单块明文上限 117 字节，超了必须分块 */
const RSA_PLAIN_CHUNK_BYTES = 117

/** 二维码有效期 3 分钟：营地 ticket 自身就这个寿命，本地超时对齐它 */
const QRCODE_TTL_MS = 3 * 60 * 1000

/** 轮询间隔：2 秒一次 */
const POLL_INTERVAL_MS = 2000

/** 设备指纹里的占位 MAC / 内存（照抄抓包结果，营地不看真值只看格式） */
const DEVICE_MAC_PLACEHOLDER = '02:00:00:00:00:00'
const DEVICE_MEM_BYTES = 12 * 1024 * 1024 * 1024

/** 营地接口公共头：声明不走加密、客户端是 https 协议 */
const CAMP_COMMON_HEADERS = {
  'Content-Encrypt': '',
  'Accept-Encrypt': '',
  NOENCRYPT: '1',
  'X-Client-Proto': 'https',
  'User-Agent': 'okhttp/4.9.1'
}

/**
 * 轮询状态码 → 业务错误。
 * 用 Map 而不是对象字面量：服务端万一把 errcode 返回成字符串 '402'，
 * 对象查表会把 '402' 也当成 402（原实现是 `=== 402` 的严格比较），Map 不会。
 */
const POLL_FAILURE_PRESETS = new Map([
  [402, { code: 'QR_EXPIRED', message: '登录二维码已过期，请重新发起' }],
  [403, { code: 'QR_CANCELED', message: '登录已取消，请重新发起' }],
  [500, { code: 'QR_ERROR', message: '登录服务异常，请稍后再试' }]
])

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** x-log-uid：网关用它串起一次登录会话，必须大写 */
function newXLogUid () {
  return crypto.randomUUID().toUpperCase()
}

/** 32 位无连字符小写 uuid：营地当设备号 / 会话密钥用 */
function newUuidHex () {
  return crypto.randomUUID().replace(/-/g, '')
}

/** 补 PEM 头尾：营地给的公钥是裸 base64，node 只认 PEM */
function toPublicKeyPem (publicKey) {
  const lines = publicKey.match(/.{1,64}/g) || [publicKey]
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`
}

/**
 * 分块 RSA 加密。
 * 1024 位密钥 + PKCS#1 v1.5 一次只能塞 117 字节，设备指纹 JSON 有 400+ 字节，
 * 所以切成若干块分别加密再首尾拼起来（营地那边同样按块解）。
 */
function encryptRsaChunked (buffer, publicKey) {
  const key = toPublicKeyPem(publicKey)
  const blocks = []

  for (let offset = 0; offset < buffer.length; offset += RSA_PLAIN_CHUNK_BYTES) {
    blocks.push(crypto.publicEncrypt(
      {
        key,
        padding: crypto.constants.RSA_PKCS1_PADDING
      },
      buffer.subarray(offset, offset + RSA_PLAIN_CHUNK_BYTES)
    ))
  }

  return Buffer.concat(blocks)
}

/** 微信签名里的随机数字串 */
function randomDigits (length = 8) {
  let result = ''
  for (let index = 0; index < length; index += 1) {
    result += Math.floor(Math.random() * 10)
  }
  return result
}

function sha1Hex (input) {
  return crypto.createHash('sha1').update(input).digest('hex')
}

/**
 * 解 encodeRes：营地把 userKey 之类的字段加密后塞在这里。
 * 必须用 publicDecrypt —— 这份密文就是配着公钥解的，换成 privateDecrypt 会直接抛错。
 */
function decryptEncodeRes (encodeRes, publicKey = CAMP_PUBLIC_KEY) {
  if (!encodeRes) {
    return null
  }

  try {
    const decrypted = crypto.publicDecrypt(
      {
        key: toPublicKeyPem(publicKey),
        padding: crypto.constants.RSA_PKCS1_PADDING
      },
      Buffer.from(encodeRes, 'base64')
    )

    return JSON.parse(decrypted.toString('utf8'))
  } catch (error) {
    logger.error(`[营地登录] 解析 encodeRes 失败: ${error.message}`)
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 设备指纹
 * ------------------------------------------------------------------ */

/**
 * specialEncodeParam 的明文负载。
 * ⚠️ 字段顺序就是 JSON 顺序，营地按它校验，别重排、别删字段。
 */
function buildDevicePayload ({ timestamp, nonce, deviceId }) {
  return {
    timestamp,
    nonce,
    cDeviceId: deviceId,
    deviceid: deviceId,
    cDeviceImei: deviceId.slice(0, 15),
    cDeviceMac: DEVICE_MAC_PLACEHOLDER,
    cDevicePPI: 480,
    cDeviceScreenWidth: 1080,
    cDeviceScreenHeight: 2400,
    cDeviceBrand: 'OnePlus',
    cDeviceModel: 'PHK110',
    cDeviceMem: DEVICE_MEM_BYTES,
    cDeviceCPU: 'SM8650',
    cSystemVersionCode: '34',
    cDeviceNet: 'WIFI',
    cDeviceSP: 'China Mobile',
    cDeviceOaid: deviceId,
    deviceLevel: 3,
    px: 0,
    py: 0,
    wifi_ssid: 'unknown',
    wifi_mac: DEVICE_MAC_PLACEHOLDER
  }
}

/**
 * 登录/取码时带的渠道与设备参数。
 * ⚠️ 顺序别动：表单 body 是按插入顺序拼的，请求头也照它排，跟抓包结果一致。
 */
function buildDeviceParams () {
  return {
    cChannelId: '10003391',
    cClientVersionCode: '2057957801',
    cClientVersionName: '10.111.0323',
    cCurrentGameId: '20001',
    cGameId: '20001',
    cGzip: '1',
    cIsArm64: 'true',
    cRand: String(Date.now()),
    cSupportArm64: 'true',
    cSystem: 'android',
    cSystemVersionCode: '34',
    cSystemVersionName: '14',
    cpuHardware: 'qcom',
    gameId: '20001',
    tinkerId: '2057957801_64_0'
  }
}

/** 生成 specialEncodeParam：设备指纹 JSON → 分块 RSA → base64 */
export function buildSpecialEncodeParam (publicKey = CAMP_PUBLIC_KEY) {
  const timestamp = Date.now()
  // ⚠️ 两次 uuid 的调用顺序不能换：nonce 在前、deviceId 在后（跟原实现一致）
  const nonce = `:${newUuidHex()}:${timestamp}`
  const deviceId = newUuidHex()

  return encryptRsaChunked(
    Buffer.from(JSON.stringify(buildDevicePayload({ timestamp, nonce, deviceId })), 'utf8'),
    publicKey
  ).toString('base64')
}

/* ------------------------------------------------------------------ *
 * 网络请求
 * ------------------------------------------------------------------ */

/** 统一发请求并返回 { ok, status, headers, json, text }，json 解析失败时退回 { raw } */
async function fetchJson (url, { method = 'GET', headers = {}, body = null } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body
  })
  const text = await response.text()
  let json = null

  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }

  return {
    ok: response.ok,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    json,
    text
  }
}

/** 取微信扫码用的 SDK ticket，后面出码要用它签名 */
async function fetchWxSdkTicket (xLogUid) {
  const result = await fetchJson(`${CAMP_API_BASE}/a/getwxsdkticket`, {
    method: 'POST',
    headers: {
      ...CAMP_COMMON_HEADERS,
      'x-log-uid': xLogUid
    }
  })

  if (!result.ok || result.json?.returnCode !== 0 || !result.json?.data?.sdkTicket) {
    throw new Error(`获取登录 SDK Ticket 失败: ${result.text}`)
  }

  return result.json.data.sdkTicket
}

/** 拉二维码：签名 = sha1(appid & noncestr & sdk_ticket & timestamp) */
async function fetchWechatQrCode (ticket) {
  const nonce = randomDigits()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = sha1Hex(`appid=${WX_APPID}&noncestr=${nonce}&sdk_ticket=${ticket}&timestamp=${timestamp}`)
  const requestParams = {
    appid: WX_APPID,
    noncestr: nonce,
    timestamp,
    scope: 'snsapi_userinfo',
    signature
  }
  const url = new URL(WX_QRCODE_API)

  for (const [key, value] of Object.entries(requestParams)) {
    url.searchParams.set(key, value)
  }

  const result = await fetchJson(url.toString())
  const qrcodeBase64 = result.json?.qrcode?.qrcodebase64
  const uuid = result.json?.uuid

  if (!result.ok || result.json?.errcode !== 0 || !qrcodeBase64 || !uuid) {
    throw new Error(`获取登录二维码失败: ${result.text}`)
  }

  return {
    uuid,
    qrcodeBase64,
    qrcodeBuffer: Buffer.from(qrcodeBase64, 'base64'),
    requestParams
  }
}

/** 轮询扫码结果 */
async function pollWechatQr (uuid) {
  const url = new URL(WX_QRCODE_POLL_API)
  url.searchParams.set('f', 'json')
  url.searchParams.set('uuid', uuid)
  return fetchJson(url.toString())
}

/* ------------------------------------------------------------------ *
 * 登录
 * ------------------------------------------------------------------ */

/** 用扫码拿到的 code 换营地账号 */
async function loginWithWechatAuthCode (code, xLogUid, publicKey = CAMP_PUBLIC_KEY) {
  const form = new URLSearchParams({
    loginType: 'wx',
    code,
    delOldUser: '0',
    key1: newUuidHex(),
    lastLoginTime: '0',
    lastGetRemarkTime: '0',
    ...buildDeviceParams(),
    specialEncodeParam: buildSpecialEncodeParam(publicKey)
  })

  const result = await fetchJson(`${CAMP_API_BASE}/user/login`, {
    method: 'POST',
    headers: {
      ...CAMP_COMMON_HEADERS,
      'x-log-uid': xLogUid,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      // 头部这组渠道参数跟 body 是同一套，但 cRand 是当场生成的，跟 body 不共享同一个值
      ...buildDeviceParams(),
      specialEncodeParam: form.get('specialEncodeParam')
    },
    body: form.toString()
  })

  if (!result.ok || result.json?.returnCode !== 0 || !result.json?.data?.userId || !result.json?.data?.token) {
    throw new Error(`营地登录失败: ${result.text}`)
  }

  return result.json
}

/**
 * 把登录响应摊平成账号对象。
 * 字段全是字符串（落盘到 yaml，数字会被读回来变类型），sex 用 `??` 保留 0 这种合法值。
 */
function buildAccountFromLoginResponse (loginResponse, publicKey = CAMP_PUBLIC_KEY) {
  const data = loginResponse?.data || {}
  const encodePayload = decryptEncodeRes(data.encodeRes, publicKey)

  return {
    userId: String(data.userId || ''),
    token: String(data.token || ''),
    userKey: String(encodePayload?.userKey || ''),
    encodeRes: String(data.encodeRes || ''),
    accessToken: String(data.accessToken || ''),
    refreshToken: String(data.refreshToken || ''),
    appOpenid: String(data.appOpenid || ''),
    avatar: String(data.avatar || ''),
    bigAvatar: String(data.bigAvatar || ''),
    icon: String(data.icon || ''),
    nickname: String(data.nickname || ''),
    snsnickname: String(data.snsnickname || ''),
    userName: String(data.userName || ''),
    sex: String(data.sex ?? ''),
    expires: String(data.expires || ''),
    uin: String(data.uin || ''),
    userSig: String(data.userSig || ''),
    realRegisterTime: String(data.realRegisterTime || ''),
    loginPlatform: 'wechat',
    lastLoginAt: new Date().toISOString()
  }
}

/** 开一次扫码会话：拿 ticket → 出码 → 返回调用方要发出去的东西 */
export async function createWechatLoginSession () {
  const xLogUid = newXLogUid()
  const sdkTicket = await fetchWxSdkTicket(xLogUid)
  const qrData = await fetchWechatQrCode(sdkTicket)

  return {
    xLogUid,
    sdkTicket,
    uuid: qrData.uuid,
    qrcodeBase64: qrData.qrcodeBase64,
    qrcodeBuffer: qrData.qrcodeBuffer,
    requestParams: qrData.requestParams,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + QRCODE_TTL_MS).toISOString()
  }
}

/** 造一个带业务码的登录错误，调用方按 error.code 分流（QR_EXPIRED / QR_CANCELED / …） */
function createLoginError (code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  if (statusCode !== undefined) {
    error.statusCode = statusCode
  }
  return error
}

/**
 * 轮询等扫码。
 * 405 + authCode = 用户扫了并授权，接着换账号；
 * 402 / 403 / 500 是三种终态失败；轮询期间状态变了才回调 onStatusChange（同一份 JSON 不重复报）。
 */
export async function waitForWechatLogin (session, options = {}) {
  const {
    timeoutMs = QRCODE_TTL_MS,
    pollIntervalMs = POLL_INTERVAL_MS,
    onStatusChange = null,
    publicKey = CAMP_PUBLIC_KEY
  } = options
  const startedAt = Date.now()
  let lastSummary = ''

  while (Date.now() - startedAt < timeoutMs) {
    const pollResult = await pollWechatQr(session.uuid)
    const statusCode = pollResult.json?.wx_errcode ?? pollResult.json?.errcode ?? null
    const authCode = pollResult.json?.wx_code ?? pollResult.json?.code ?? null
    const summary = JSON.stringify(pollResult.json)

    if (summary !== lastSummary) {
      lastSummary = summary
      if (typeof onStatusChange === 'function') {
        onStatusChange({
          statusCode,
          authCode,
          raw: pollResult.json
        })
      }
    }

    if (authCode && statusCode === 405) {
      const loginResponse = await loginWithWechatAuthCode(authCode, session.xLogUid, publicKey)
      return {
        authCode,
        poll: pollResult.json,
        loginResponse,
        account: buildAccountFromLoginResponse(loginResponse, publicKey)
      }
    }

    const failure = POLL_FAILURE_PRESETS.get(statusCode)
    if (failure) {
      throw createLoginError(failure.code, failure.message, statusCode)
    }

    await sleep(pollIntervalMs)
  }

  throw createLoginError('QR_TIMEOUT', '等待登录二维码超时，请重新发起')
}

/** 只要 encodeRes 里的 userKey，拿不到就返回空串 */
export function decodeEncodeResUserKey (encodeRes, publicKey = CAMP_PUBLIC_KEY) {
  return decryptEncodeRes(encodeRes, publicKey)?.userKey || ''
}
