/**
 * XXTEA 分组加密（Corrected Block TEA，Needham & Wheeler 1998）。
 *
 * ⚠️ **这是公开的标准算法，不是谁的私产**。参数（DELTA、轮数公式
 * `6 + 52/n`、`mx` 混合函数）都由论文规定，任何正确实现都必须逐字节一致 ——
 * 所以本文件按公开规范独立实现，不参考任何既有代码的写法。
 *
 * ## 为什么自己写而不是用 npm 包
 *
 * 这里对「零依赖」有硬要求：**服务端也要用同一份**。观战/消息服务端是单独
 * 部署到别人机器上的（`#营地观战部署` / `#营地消息部署`），如果依赖 npm 包，
 * 就等于给群友多加一个安装步骤；而插件本体也只在两处用它，自己写 100 行更划算。
 *
 * ⚠️⚠️ **本文件和 `im-server` 分支的 `lib/xxtea.js` 是同一份代码** ——
 * 消息服务端从代码包里取那一份（`GOK_DIST_PACKAGES` 里写死的
 * `im=im-server|camp-im-server.js+lib/xxtea.js`）。**改这里必须同步改那边**，
 * 否则插件加密、服务端解密会对不上，群友部署完直接连不上。
 *
 * ## 与标准实现的差异（都是为了适配 Buffer）
 *
 * 1. **长度内嵌**：加密时把原始字节数当作最后一个 32 位字塞进去（`includeLength`），
 *    解密时读回来裁掉补齐的零。标准 XXTEA 不处理长度，调用方得自己记 ——
 *    这里内嵌掉，`decrypt(encrypt(x)) === x` 对任意长度都成立。
 * 2. **密钥补齐**：密钥不足 16 字节时右侧补 0 到 4 个字（标准做法之一）。
 * 3. **空输入直接返回空**：标准实现在 `n < 2` 时行为未定义，这里显式短路。
 *
 * 用法（见 `utils/api.js`）：
 *   encrypt(Buffer.from(json, 'utf8'), Buffer.from(userKey, 'utf8')).toString('base64')
 */

/** 黄金比例倒数 × 2^32，XXTEA 规定的固定常量 */
const DELTA = 0x9E3779B9

/** XXTEA 的一个字 = 4 字节 */
const WORD_BYTES = 4

/** 密钥按 4 个字（16 字节）对齐 —— 论文里的 `key[0..3]` */
const KEY_WORDS = 4

/**
 * 把字节序列按**小端**打包成 32 位字数组。
 *
 * @param {Buffer} buffer
 * @param {boolean} withLength 末尾是否追加原始字节数（解密时要靠它还原长度）
 * @returns {number[]}
 */
function bytesToWords (buffer, withLength) {
  const words = new Array(Math.ceil(buffer.length / WORD_BYTES))

  for (let i = 0; i < words.length; i++) {
    const at = i * WORD_BYTES
    // `|| 0` 兜住越界 —— 最后一块可能不满 4 字节
    words[i] = (
      (buffer[at] || 0) |
      ((buffer[at + 1] || 0) << 8) |
      ((buffer[at + 2] || 0) << 16) |
      ((buffer[at + 3] || 0) << 24)
    )
  }

  if (withLength) words.push(buffer.length)
  return words
}

/**
 * 把 32 位字数组按**小端**还原成字节。
 *
 * @param {number[]} words
 * @param {boolean} withLength 末尾那个字是原始长度，据此裁剪
 * @returns {Buffer}
 */
function wordsToBytes (words, withLength) {
  let size = words.length * WORD_BYTES

  if (withLength) {
    const declared = words[words.length - 1]
    // 长度字段本身占 4 字节，所以合法上限是 size - 4。
    // 越界说明密文被改过 / 密钥不对，返回空而不是抛 —— 调用方按「解不出来」处理。
    if (declared < 0 || declared > size - WORD_BYTES) return Buffer.alloc(0)
    size = declared
  }

  const out = Buffer.alloc(size)
  for (let i = 0; i < size; i++) {
    out[i] = (words[i >>> 2] >>> ((i & 3) * 8)) & 0xFF
  }
  return out
}

/** 密钥补齐到 4 个字（不足补 0），多出来的字忽略 */
function toKeyWords (key) {
  const words = bytesToWords(key, false)
  while (words.length < KEY_WORDS) words.push(0)
  return words.slice(0, KEY_WORDS)
}

/**
 * XXTEA 的混合函数 `mx`。论文原文：
 *
 *   MX = (((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((sum ^ y) + (key[(p & 3) ^ e] ^ z))
 *
 * `p` 是当前字下标，`e = (sum >>> 2) & 3` 决定用哪个密钥字。
 * 全程 `>>> 0` 保持在 uint32 —— JS 的位运算会得到 int32，不归一会溢出成负数。
 */
function mix (sum, y, z, p, e, keyWords) {
  const a = ((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))
  const b = (sum ^ y) + (keyWords[(p & 3) ^ e] ^ z)
  return ((a ^ b) >>> 0)
}

/**
 * 加密。
 *
 * @param {Buffer|Uint8Array|string} data
 * @param {Buffer|Uint8Array|string} key
 * @returns {Buffer} 密文（长度是 4 的倍数）
 */
export function encrypt (data, key) {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const keyBuffer = Buffer.isBuffer(key) ? key : Buffer.from(key)

  // 空输入没有可加密的字；标准实现在 n < 2 时也没有定义，直接短路
  if (!input.length) return Buffer.alloc(0)

  const words = bytesToWords(input, true)
  const keyWords = toKeyWords(keyBuffer)

  // 论文的轮数公式：6 + 52 / n（n = 字数）
  const rounds = Math.floor(6 + 52 / words.length)
  const last = words.length - 1

  let sum = 0
  // z 从最后一个字开始，每轮末尾滚动更新 —— 这是 XXTEA 的链式结构
  let z = words[last]

  for (let round = 0; round < rounds; round++) {
    sum = (sum + DELTA) >>> 0
    const e = (sum >>> 2) & 3

    // 前 last 个字：y 取下一个字
    for (let p = 0; p < last; p++) {
      const y = words[p + 1]
      words[p] = (words[p] + mix(sum, y, z, p, e, keyWords)) >>> 0
      z = words[p]
    }

    // 最后一个字：y 绕回第一个字
    const y0 = words[0]
    words[last] = (words[last] + mix(sum, y0, z, last, e, keyWords)) >>> 0
    z = words[last]
  }

  // 密文不带长度字段（长度已经在 words 里了，解密时读）
  return wordsToBytes(words, false)
}

/**
 * 解密。
 *
 * @param {Buffer|Uint8Array|string} data 密文
 * @param {Buffer|Uint8Array|string} key
 * @returns {Buffer} 明文；密钥不对 / 密文损坏时返回空 Buffer（不抛）
 */
export function decrypt (data, key) {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const keyBuffer = Buffer.isBuffer(key) ? key : Buffer.from(key)

  if (!input.length) return Buffer.alloc(0)

  const words = bytesToWords(input, false)
  const keyWords = toKeyWords(keyBuffer)

  const last = words.length - 1
  const rounds = Math.floor(6 + 52 / words.length)

  // 解密是加密的逆过程：sum 从终值倒着减回去
  let sum = (rounds * DELTA) >>> 0
  let y = words[0]

  while (sum !== 0) {
    const e = (sum >>> 2) & 3

    // 倒着走：z 取前一个字
    for (let p = last; p > 0; p--) {
      const z = words[p - 1]
      words[p] = (words[p] - mix(sum, y, z, p, e, keyWords)) >>> 0
      y = words[p]
    }

    // 第 0 个字：z 绕回最后一个字
    const zLast = words[last]
    words[0] = (words[0] - mix(sum, y, zLast, 0, e, keyWords)) >>> 0
    y = words[0]

    sum = (sum - DELTA) >>> 0
  }

  // 带长度字段：末尾那个字是原始字节数
  return wordsToBytes(words, true)
}
