import crypto from 'node:crypto'
import fetch from 'node-fetch'

const APPID_WX = 'wxf4b1e8a3e9aaf978'
const CAMP_BASE_URL = 'https://ssl.kohsocialapp.qq.com:10001'
const WX_QR_URL = 'https://open.weixin.qq.com/connect/sdk/qrconnect'
const WX_POLL_URL = 'https://long.open.weixin.qq.com/connect/l/qrconnect'
const DEFAULT_PUBLIC_KEY = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC0h62mV/zjJtFsNdfFNlxksfUOpjDI2KCcBrPiA8T7szABT4InLDTrdXAW84QyGNiazB0i7pgPCNGSAYbiJrCRutZ5jQsVS0Wg/RnXfwVQDJcAHJDjP5IXyroeLX7NUxDai8nPcpfRsvq6sneobyPexZSH0TlVSnecsJZTj5wu/wIDAQAB'

const COMMON_HEADERS = {
  'Content-Encrypt': '',
  'Accept-Encrypt': '',
  NOENCRYPT: '1',
  'X-Client-Proto': 'https',
  'User-Agent': 'okhttp/4.9.1'
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function buildUuid() {
  return crypto.randomUUID().toUpperCase()
}

function buildPublicKeyPem(publicKey) {
  const chunks = publicKey.match(/.{1,64}/g) || [publicKey]
  return `-----BEGIN PUBLIC KEY-----\n${chunks.join('\n')}\n-----END PUBLIC KEY-----`
}

function rsaEncryptChunked(buffer, publicKey) {
  const chunks = []

  for (let offset = 0; offset < buffer.length; offset += 117) {
    const chunk = buffer.subarray(offset, offset + 117)
    chunks.push(crypto.publicEncrypt(
      {
        key: buildPublicKeyPem(publicKey),
        padding: crypto.constants.RSA_PKCS1_PADDING
      },
      chunk
    ))
  }

  return Buffer.concat(chunks)
}

function buildNonce(length = 8) {
  let result = ''
  for (let index = 0; index < length; index += 1) {
    result += Math.floor(Math.random() * 10)
  }
  return result
}

function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('hex')
}

function decodeEncodeRes(encodeRes, publicKey = DEFAULT_PUBLIC_KEY) {
  if (!encodeRes) {
    return null
  }

  try {
    const decrypted = crypto.publicDecrypt(
      {
        key: buildPublicKeyPem(publicKey),
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

function buildSpecialEncodeParam(publicKey = DEFAULT_PUBLIC_KEY) {
  const timestamp = Date.now()
  const nonce = `:${crypto.randomUUID().replace(/-/g, '')}:${timestamp}`
  const deviceId = crypto.randomUUID().replace(/-/g, '')
  const payload = {
    timestamp,
    nonce,
    cDeviceId: deviceId,
    deviceid: deviceId,
    cDeviceImei: deviceId.slice(0, 15),
    cDeviceMac: '02:00:00:00:00:00',
    cDevicePPI: 480,
    cDeviceScreenWidth: 1080,
    cDeviceScreenHeight: 2400,
    cDeviceBrand: 'OnePlus',
    cDeviceModel: 'PHK110',
    cDeviceMem: 12 * 1024 * 1024 * 1024,
    cDeviceCPU: 'SM8650',
    cSystemVersionCode: '34',
    cDeviceNet: 'WIFI',
    cDeviceSP: 'China Mobile',
    cDeviceOaid: deviceId,
    deviceLevel: 3,
    px: 0,
    py: 0,
    wifi_ssid: 'unknown',
    wifi_mac: '02:00:00:00:00:00'
  }

  return rsaEncryptChunked(Buffer.from(JSON.stringify(payload), 'utf8'), publicKey).toString('base64')
}

async function requestJson(url, { method = 'GET', headers = {}, body = null } = {}) {
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

async function fetchWxSdkTicket(xLogUid) {
  const result = await requestJson(`${CAMP_BASE_URL}/a/getwxsdkticket`, {
    method: 'POST',
    headers: {
      ...COMMON_HEADERS,
      'x-log-uid': xLogUid
    }
  })

  if (!result.ok || result.json?.returnCode !== 0 || !result.json?.data?.sdkTicket) {
    throw new Error(`获取登录 SDK Ticket 失败: ${result.text}`)
  }

  return result.json.data.sdkTicket
}

async function fetchWechatQrCode(ticket) {
  const nonce = buildNonce()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = sha1(`appid=${APPID_WX}&noncestr=${nonce}&sdk_ticket=${ticket}&timestamp=${timestamp}`)
  const url = new URL(WX_QR_URL)

  url.searchParams.set('appid', APPID_WX)
  url.searchParams.set('noncestr', nonce)
  url.searchParams.set('timestamp', timestamp)
  url.searchParams.set('scope', 'snsapi_userinfo')
  url.searchParams.set('signature', signature)

  const result = await requestJson(url.toString())
  const qrcodeBase64 = result.json?.qrcode?.qrcodebase64
  const uuid = result.json?.uuid

  if (!result.ok || result.json?.errcode !== 0 || !qrcodeBase64 || !uuid) {
    throw new Error(`获取登录二维码失败: ${result.text}`)
  }

  return {
    uuid,
    qrcodeBase64,
    qrcodeBuffer: Buffer.from(qrcodeBase64, 'base64'),
    requestParams: {
      appid: APPID_WX,
      noncestr: nonce,
      timestamp,
      scope: 'snsapi_userinfo',
      signature
    }
  }
}

async function pollWechatQr(uuid) {
  const url = new URL(WX_POLL_URL)
  url.searchParams.set('f', 'json')
  url.searchParams.set('uuid', uuid)
  return requestJson(url.toString())
}

async function loginWithWechatAuthCode(code, xLogUid, publicKey = DEFAULT_PUBLIC_KEY) {
  const form = new URLSearchParams({
    loginType: 'wx',
    code,
    delOldUser: '0',
    key1: crypto.randomUUID().replace(/-/g, ''),
    lastLoginTime: '0',
    lastGetRemarkTime: '0',
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
    tinkerId: '2057957801_64_0',
    specialEncodeParam: buildSpecialEncodeParam(publicKey)
  })

  const result = await requestJson(`${CAMP_BASE_URL}/user/login`, {
    method: 'POST',
    headers: {
      ...COMMON_HEADERS,
      'x-log-uid': xLogUid,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
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
      tinkerId: '2057957801_64_0',
      specialEncodeParam: form.get('specialEncodeParam')
    },
    body: form.toString()
  })

  if (!result.ok || result.json?.returnCode !== 0 || !result.json?.data?.userId || !result.json?.data?.token) {
    throw new Error(`营地登录失败: ${result.text}`)
  }

  return result.json
}

function buildAccountFromLoginResponse(loginResponse, publicKey = DEFAULT_PUBLIC_KEY) {
  const data = loginResponse?.data || {}
  const encodePayload = decodeEncodeRes(data.encodeRes, publicKey)

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

export async function createWechatLoginSession() {
  const xLogUid = buildUuid()
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
    expiresAt: new Date(Date.now() + 3 * 60 * 1000).toISOString()
  }
}

export async function waitForWechatLogin(session, options = {}) {
  const {
    timeoutMs = 3 * 60 * 1000,
    pollIntervalMs = 2000,
    onStatusChange = null,
    publicKey = DEFAULT_PUBLIC_KEY
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

    if (statusCode === 402) {
      const error = new Error('登录二维码已过期，请重新发起')
      error.code = 'QR_EXPIRED'
      error.statusCode = statusCode
      throw error
    }

    if (statusCode === 403) {
      const error = new Error('登录已取消，请重新发起')
      error.code = 'QR_CANCELED'
      error.statusCode = statusCode
      throw error
    }

    if (statusCode === 500) {
      const error = new Error('登录服务异常，请稍后再试')
      error.code = 'QR_ERROR'
      error.statusCode = statusCode
      throw error
    }

    await sleep(pollIntervalMs)
  }

  const error = new Error('等待登录二维码超时，请重新发起')
  error.code = 'QR_TIMEOUT'
  throw error
}

export function decodeEncodeResUserKey(encodeRes, publicKey = DEFAULT_PUBLIC_KEY) {
  return decodeEncodeRes(encodeRes, publicKey)?.userKey || ''
}
