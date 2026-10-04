import crypto from 'node:crypto'
import fetch from 'node-fetch'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { buildSpecialEncodeParam, decodeEncodeResUserKey } from './wechatLogin.js'

/**
 * 王者营地 QQ 扫码登录。
 *
 * 为什么不能像微信那样纯接口实现：
 * QQ 的扫码授权链要在「同一个浏览器会话」里跑完 —— 页面自己轮询、自己跳转，
 * 服务端只负责拦住最后那一下 `auth://tauth.qq.com/?code=...`。
 * 任何「外部出码 + 另开浏览器」的拆分会话都会让流程停在二维码那一步。
 *
 * 三个必须照做的点（踩过）：
 *   1. `response_type=code` —— 用 token 的话凭证在 fragment 里，浏览器/服务端都拿不到
 *   2. 全程同一个会话，不手动调页面内的任何 API（手动调 pt_open_login 会被 23013 顶回来）
 *   3. 二维码从【页面里】截，不能另开一个会话单独生成
 */

const CAMP_QQ_APPID = '1105200115'
const LOGIN_PAGE = `https://openmobile.qq.com/oauth2.0/m_authorize?client_id=${CAMP_QQ_APPID}&scope=all&redirect_uri=auth://tauth.qq.com/&style=qr&response_type=code`
const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// 扫码页在手机 UA 下才给二维码版式
const QR_UA = 'Mozilla/5.0 (Linux; Android 15; V2366GA Build/V417IR; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.154 Safari/537.36 tencent_game_emulator'

// 外置渲染（puppeteerWS 连远程 chromium）时页面往返更慢，超时都放宽一些
const PAGE_TIMEOUT_MS = 90 * 1000
const QR_WAIT_TIMEOUT_MS = 60 * 1000
const SCAN_TIMEOUT_MS = 3 * 60 * 1000

/**
 * 取宿主渲染器。
 * ⚠️ 必须返回 null 而不是空对象 —— `lib/renderer/loader.js` 的 getRenderer() 在
 * 「配置的渲染后端不是 puppeteer」时返回 `{}`，直接拿它会在 browserInit 上炸成
 * 「renderer.browserInit is not a function」。这种环境下得走自己 launch 的兜底。
 */
function resolveRenderer(e) {
  for (const candidate of [e?.runtime?.puppeteer, puppeteer]) {
    if (candidate && typeof candidate.browserInit === 'function') {
      return candidate
    }
  }
  return null
}

/**
 * 兜底：自己起一个浏览器。
 * 宿主的渲染后端不是 puppeteer 时（换成外置/别的渲染器），借不到实例，只能自己来。
 * 这样拿到的实例归本流程所有，用完必须 close，别留给下次（会变孤儿进程）。
 */
export async function launchOwnBrowser() {
  let puppeteerPkg = null
  try {
    puppeteerPkg = (await import('puppeteer')).default
  } catch (error) {
    logger.error(`[营地QQ登录] 未能加载 puppeteer 包: ${error.message}`)
    return null
  }

  const browser = await puppeteerPkg.launch({
    headless: 'new',
    args: [
      '--disable-gpu',
      '--disable-setuid-sandbox',
      '--no-sandbox',
      '--no-zygote',
      '--disable-dev-shm-usage'
    ],
    timeout: 60 * 1000
  }).catch(error => {
    logger.error(`[营地QQ登录] 浏览器启动失败: ${error.message}`)
    return null
  })

  if (browser) {
    logger.info('[营地QQ登录] 宿主渲染后端不是 puppeteer，已自行启动浏览器')
  }
  return browser
}

/**
 * 拿浏览器实例。
 * @returns {Promise<{browser, owned}|null>} owned=true 表示是自己起的，close 时要负责关掉
 */
async function acquireBrowser(renderer, { retries = 4, intervalMs = 700 } = {}) {
  if (renderer) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const browser = await renderer.browserInit().catch(error => {
        logger.error(`[营地QQ登录] 浏览器初始化失败: ${error.message}`)
        return null
      })
      if (browser) {
        return { browser, owned: false }
      }
      if (attempt < retries) {
        // browserInit() 在并发（别人正在出图）时会直接返回 false，等一下再试
        await sleep(intervalMs)
      }
    }
    logger.warn('[营地QQ登录] 宿主浏览器多次获取失败，改为自己启动')
  }

  const browser = await launchOwnBrowser()
  return browser ? { browser, owned: true } : null
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * code → 三件套。
 * 走的是腾讯 YSDK 的 QQCodeLogin，签名方式是社区逆向出来的固定协议。
 */
async function exchangeCodeForTokens(code) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify({ appID: CAMP_QQ_APPID, loginCode: code })
  const signStr = `POST\n/cmd/QQCodeLogin\njson\nysdk\n${timestamp}\n${body}`
  const digest = crypto
    .createHmac('sha256', 'yyb@cloud_game:CQ8FA#')
    .update(signStr)
    .digest('base64')

  const response = await fetch('https://ysdk.qq.com/cmd/QQCodeLogin?', {
    method: 'POST',
    headers: {
      'Content-Type': 'json',
      'Auth-Secret-ID': 'ysdk',
      'Auth-Secret-Digest': digest,
      'Auth-Request-Time': timestamp
    },
    body
  })
  const result = await response.json().catch(() => null)

  if (!response.ok || result?.code !== 0 || result?.data?.ret !== 0) {
    throw new Error(result?.errmsg || result?.data?.errmsg || `换取登录凭证失败（${response.status}）`)
  }

  const data = result.data
  return {
    accessToken: String(data.accessToken || ''),
    openId: String(data.openID || ''),
    payToken: String(data.payToken || ''),
    refreshToken: String(data.refreshToken || ''),
    expiresIn: Number(data.expiresIn || 0)
  }
}

/**
 * 用三件套调营地登录，拿营地登录态。
 */
async function loginCampByOpenSdk(tokens) {
  const form = new URLSearchParams({
    delOldUser: '0',
    key1: crypto.randomUUID().replace(/-/g, ''),
    lastLoginTime: '0',
    lastGetRemarkTime: '0',
    cChannelId: '10003391',
    cClientVersionCode: '2057971306',
    cClientVersionName: '10.114.0826',
    cCurrentGameId: '20001',
    cGameId: '20001',
    cGzip: '1',
    cIsArm64: 'true',
    cRand: String(Date.now()),
    cSupportArm64: 'true',
    cSystem: 'android',
    cSystemVersionCode: '35',
    cSystemVersionName: '15',
    cpuHardware: 'qcom',
    gameId: '20001',
    tinkerId: '2057971306_64_0',
    specialEncodeParam: buildSpecialEncodeParam(),
    loginType: 'openSdk',
    accessToken: tokens.accessToken,
    openId: tokens.openId,
    payToken: tokens.payToken
  })

  const response = await fetch('https://ssl.kohsocialapp.qq.com:10001/user/login', {
    method: 'POST',
    headers: {
      'Content-Encrypt': '',
      'Accept-Encrypt': '',
      NOENCRYPT: '1',
      'X-Client-Proto': 'https',
      'User-Agent': 'okhttp/4.9.1',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-log-uid': crypto.randomUUID().toUpperCase()
    },
    body: form.toString()
  })

  const data = await response.json().catch(() => null)
  if (!response.ok || data?.returnCode !== 0 || !data?.data?.userId || !data?.data?.token) {
    throw new Error(data?.returnMsg || `营地登录失败（${response.status}）`)
  }

  const userKey = decodeEncodeResUserKey(data.data.encodeRes)
  return {
    userId: String(data.data.userId || ''),
    token: String(data.data.token || ''),
    userKey: String(userKey || ''),
    encodeRes: String(data.data.encodeRes || ''),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    appOpenid: String(data.data.appOpenid || ''),
    avatar: String(data.data.avatar || ''),
    bigAvatar: String(data.data.bigAvatar || ''),
    icon: String(data.data.icon || ''),
    nickname: String(data.data.nickname || ''),
    snsnickname: String(data.data.snsnickname || ''),
    userName: String(data.data.userName || ''),
    sex: String(data.data.sex ?? ''),
    expires: String(data.data.expires || ''),
    uin: String(data.data.uin || ''),
    userSig: String(data.data.userSig || ''),
    realRegisterTime: String(data.data.realRegisterTime || ''),
    loginPlatform: 'qq',
    lastLoginAt: new Date().toISOString()
  }
}

/**
 * ⭐ **免扫码续期**：拿账号池里存着的三件套重新登录一次，换一份新的营地登录态。
 *
 * ## 为什么可行
 *
 * 营地的 `/user/login` 的 `openSdk` 分支**只吃三件套**（accessToken + openId + payToken），
 * 全程不需要 `code`。而三件套是 YSDK 签发的、**有效期 60 天**，比营地自己的 token（约 30 天）长 ——
 * 所以营地 token 到期时，拿三件套重登一次就能续上，**用户完全不用再扫码**。
 *
 * 2026-09-18 实测：`payToken` 传空串照样 `returnCode=0`（营地不校验它），
 * 所以**连 payToken 都不用存**，光靠 `accessToken + appOpenid` 就能续。
 *
 * ## ⚠️ 两条必须守住的规矩
 *
 * 1. **重登会顶掉旧 token**（实测：重放成功后旧 token 立刻变 `-30003`）。
 *    所以调用方拿到新凭证后**必须立刻写回账号池**，中间不能失败 ——
 *    否则旧票被作废、新票又没存，那个号就彻底废了。
 * 2. **别在请求热路径里调**：每次重登都要打营地接口，且会换掉 token（正在飞的请求可能刚好用旧票）。
 *    交给定时任务提前续（见 apps/campRenew.js）。
 *
 * @param {object} account 账号池里的一条账号记录（要带 accessToken / appOpenid）
 * @returns {Promise<object>} 新的账号数据（交给 authStore.upsertAccount 写回）
 */
export async function reloginQQAccount (account) {
  const accessToken = String(account?.accessToken || '')
  const openId = String(account?.appOpenid || account?.openId || '')
  if (!accessToken || !openId) {
    throw new Error('这个号没存三件套（accessToken / openId），续不了，得重新扫码一次')
  }

  return await loginCampByOpenSdk({
    accessToken,
    openId,
    payToken: String(account?.payToken || ''),
    refreshToken: String(account?.refreshToken || '')
  })
}

/**
 * 用宿主复用的浏览器开一个 QQ 登录会话，等到二维码出现。
 * @param {object} [e] 消息事件对象，用来取宿主的渲染器（外置渲染机器上必须传）
 * @returns {Promise<{browser, page, qrcodeBuffer, waitForCode, close}>}
 */
export async function createQQLoginSession(e) {
  const renderer = resolveRenderer(e)
  const acquired = await acquireBrowser(renderer)
  if (!acquired) {
    throw new Error('浏览器不可用，无法发起 QQ 扫码登录')
  }
  const { browser, owned: ownBrowser } = acquired

  const page = await browser.newPage()
  let closed = false
  let codeValue = ''
  let codeResolve = null
  const codePromise = new Promise(resolve => {
    codeResolve = resolve
  })

  const close = async () => {
    if (closed) {
      return
    }
    closed = true
    try {
      await page.close()
    } catch (error) {
      logger.debug(`[营地QQ登录] 关闭页面失败: ${error.message}`)
    }
    if (ownBrowser) {
      // 自己起的浏览器必须关掉，否则会变成常驻孤儿进程
      try {
        await browser.close()
      } catch (error) {
        logger.warn(`[营地QQ登录] 关闭自启浏览器失败: ${error.message}`)
      }
    }
  }

  try {
    await page.setUserAgent(QR_UA)
    await page.setViewport({ width: 420, height: 760, isMobile: true })

    // 拦截最后那一下 auth:// 回调 —— code 只在 query 里出现
    page.on('request', request => {
      const url = request.url()
      if (!url.startsWith('auth://') && !url.includes('tauth.qq.com')) {
        return
      }
      const matched = /[?&]code=([0-9A-Za-z]+)/.exec(url)
      if (matched && !codeValue) {
        codeValue = matched[1]
        logger.info(`[营地QQ登录] 已获取授权码（${codeValue.slice(0, 8)}…）`)
        codeResolve?.(codeValue)
      }
    })

    logger.info(`[营地QQ登录] 发起登录（${renderer ? '借宿主浏览器' : '自备浏览器'}）`)
    try {
      await page.goto(LOGIN_PAGE, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS })
    } catch (error) {
      // 外置渲染的机器若访问不了 QQ 登录页，会卡在这里 —— 日志里说清楚，别让它看起来像随机失败
      logger.error(`[营地QQ登录] 打开登录页失败: ${error.message}`)
      throw new Error('打开 QQ 登录页失败，请稍后重试')
    }

    // 等页面把二维码渲染出来（在 iframe / 各版式下找一找）
    const deadline = Date.now() + QR_WAIT_TIMEOUT_MS
    let box = null
    while (Date.now() < deadline) {
      box = await page.evaluate(() => {
        const selectors = [
          '#qrlogin_img', '.qrlogin_img', 'img[src*="ptqrshow"]',
          'img[src*="qrcode"]', 'canvas#qrlogin_canvas', '.qrlogin canvas'
        ]
        for (const selector of selectors) {
          const el = document.querySelector(selector)
          if (el) {
            const rect = el.getBoundingClientRect()
            if (rect.width > 40 && rect.height > 40) {
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            }
          }
        }
        return null
      }).catch(() => null)
      if (box) {
        break
      }
      await sleep(800)
    }

    if (!box) {
      throw new Error('未能获取登录二维码，请稍后重试')
    }

    // 优先在页面内把二维码读成 base64 —— 不走截图。
    // 截图依赖渲染后端（外置渲染/远程 chromium 上 clip、deviceScaleFactor 都可能不靠谱），
    // 而页面内的图片本来就是同源请求，直接 fetch 回来最稳，体积也更小。
    let qrcodeBuffer = await page.evaluate(async () => {
      const el = document.querySelector('#qrlogin_img, .qrlogin_img, img[src*="ptqrshow"], img[src*="qrcode"], canvas#qrlogin_canvas, .qrlogin canvas')
      if (!el) {
        return null
      }
      try {
        if (el.tagName === 'CANVAS') {
          return el.toDataURL('image/png')
        }
        const src = el.currentSrc || el.src || el.getAttribute('data-src')
        if (!src) {
          return null
        }
        const response = await fetch(src, { credentials: 'include' })
        const blob = await response.blob()
        return await new Promise(resolve => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result)
          reader.onerror = () => resolve(null)
          reader.readAsDataURL(blob)
        })
      } catch (error) {
        return null
      }
    }).catch(() => null)

    if (typeof qrcodeBuffer === 'string' && qrcodeBuffer.startsWith('data:')) {
      qrcodeBuffer = Buffer.from(qrcodeBuffer.slice(qrcodeBuffer.indexOf(',') + 1), 'base64')
    } else {
      // 兜底：页面里读不到（版式特殊）才截图；区域截图失败再退整页
      logger.warn('[营地QQ登录] 页面内未读到二维码图片，改用截图')
      qrcodeBuffer = await page.screenshot({
        clip: {
          x: Math.max(0, box.x - 12),
          y: Math.max(0, box.y - 12),
          width: box.width + 24,
          height: box.height + 24
        }
      }).catch(async error => {
        logger.warn(`[营地QQ登录] 二维码区域截图失败，改用整页截图: ${error.message}`)
        return page.screenshot().catch(() => null)
      })
    }

    if (!qrcodeBuffer) {
      throw new Error('二维码截图失败，请稍后重试')
    }

    const waitForCode = async ({ timeoutMs = SCAN_TIMEOUT_MS, onStatusChange } = {}) => {
      const began = Date.now()
      let scannedNotified = false
      while (Date.now() - began < timeoutMs) {
        if (codeValue) {
          return codeValue
        }
        if (closed) {
          const error = new Error('登录会话已结束')
          error.code = 'QR_CANCELED'
          throw error
        }
        // 页面自己会轮询，这里只借 DOM 判断「已扫码」给用户一个提示
        // （沿用微信那套状态协议：404 = 已扫码待确认）
        if (!scannedNotified && typeof onStatusChange === 'function') {
          const scanned = await page
            .evaluate(() => /扫码成功|请在手机上确认|已扫码|确认登录/.test(document.body?.innerText || ''))
            .catch(() => false)
          if (scanned) {
            scannedNotified = true
            void onStatusChange({ statusCode: 404 })
          }
        }
        const waitResult = await Promise.race([
          codePromise.then(() => 'code'),
          sleep(1500).then(() => 'tick')
        ])
        if (waitResult === 'code') {
          return codeValue
        }
      }

      const error = new Error('登录等待超时')
      error.code = scannedNotified ? 'QR_TIMEOUT' : 'QR_EXPIRED'
      throw error
    }

    return { browser, page, qrcodeBuffer, waitForCode, close }
  } catch (error) {
    await close()
    throw error
  }
}

/**
 * 等扫码 → 换三件套 → 营地登录，返回可直接写入账号池的 account。
 */
export async function waitForQQLogin(session, { onStatusChange } = {}) {
  const code = await session.waitForCode({ onStatusChange })

  logger.info('[营地QQ登录] 开始用授权码换取登录凭证')
  const tokens = await exchangeCodeForTokens(code)
  logger.info(`[营地QQ登录] 登录凭证换取成功，有效期约 ${Math.round(tokens.expiresIn / 86400)} 天`)

  const account = await loginCampByOpenSdk(tokens)
  logger.info(`[营地QQ登录] 营地登录成功，userId=${account.userId}`)
  return { account, tokens }
}
