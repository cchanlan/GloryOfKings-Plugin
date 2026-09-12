/**
 * 哈希与令牌。全库只有 QQ 的 HMAC 摘要，明文 QQ 不落盘、不进日志。
 *
 * 关于 HMAC 而不是 sha256(salt + qq)：后者是把盐当拼接前缀用，存在长度扩展问题，
 * 而且盐一旦泄露就退化成「一个已知前缀的哈希」，GPU 上跑 QQ 空间（现实中 10^9 量级）
 * 是分钟级的事。HMAC 的密钥语义才是对的。
 *
 * 但这只解决「数据库文件单独被拖走」。盐和数据库一起泄露，QQ 依然能被暴力还原——
 * 所以 README 里写死了：盐必须和备份分开存放。
 */
import crypto from 'node:crypto'

/** 域名分隔前缀，防止同一个盐被复用到别的用途时产生可关联的摘要 */
const QQ_HASH_CONTEXT = 'gok:v1:qq:'

/** token 明文只在签发那一次出现在响应里，库里只留 sha256 */
const TOKEN_PREFIX = 'gok_'

/**
 * @param {string} salt GOK_SALT
 * @param {string} qq 已规范化的 QQ 号
 * @returns {string} 64 位十六进制摘要
 */
export function hashQQ (salt, qq) {
  return crypto.createHmac('sha256', salt).update(QQ_HASH_CONTEXT + qq).digest('hex')
}

/** @param {string} text */
export function sha256Hex (text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 生成一个新 token。格式 `gok_<clientId的36进制>_<32字节随机>`。
 *
 * 把 clientId 编进前缀是为了让校验时能直接定位到那一行，
 * 不必对 clients 表做全表扫描逐个比对摘要。
 *
 * @param {number} clientId
 * @returns {{token: string, tokenHash: string, tokenPrefix: string}}
 */
export function createToken (clientId) {
  const random = crypto.randomBytes(32).toString('base64url')
  const token = `${TOKEN_PREFIX}${Number(clientId).toString(36)}_${random}`

  return {
    token,
    tokenHash: sha256Hex(token),
    tokenPrefix: token.slice(0, 14)
  }
}

/**
 * 从 token 明文里解出 clientId。
 * 格式不对直接返回 null，**不要**拿去查库——那只会给扫描器制造查询量。
 *
 * @param {string} token
 * @returns {number|null}
 */
export function parseTokenClientId (token) {
  if (typeof token !== 'string') return null

  const match = /^gok_([0-9a-z]{1,10})_([A-Za-z0-9_-]{40,})$/.exec(token)
  if (!match) return null

  const id = parseInt(match[1], 36)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/**
 * 定长十六进制摘要的恒时比较。
 * 两个摘要都是 sha256，长度必然相等，不存在 timingSafeEqual 长度不等抛异常的问题。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqualHex (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false

  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

/**
 * 任意长度字符串的恒时比较。两侧各做一次 sha256 把长度归一化，
 * 否则长度不等时 timingSafeEqual 会抛，而抛不抛本身就泄露了长度。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqualText (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false

  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(a, 'utf8').digest(),
    crypto.createHash('sha256').update(b, 'utf8').digest()
  )
}
