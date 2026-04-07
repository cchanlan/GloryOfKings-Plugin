const DELTA = 0x9E3779B9

function normalizeKey(buffer) {
  const words = toUint32Array(buffer, false)
  while (words.length < 4) {
    words.push(0)
  }
  return words
}

function toUint32Array(buffer, includeLength) {
  const length = buffer.length
  const words = []

  for (let index = 0; index < length; index += 4) {
    words.push(
      ((buffer[index] || 0)) |
      ((buffer[index + 1] || 0) << 8) |
      ((buffer[index + 2] || 0) << 16) |
      ((buffer[index + 3] || 0) << 24)
    )
  }

  if (includeLength) {
    words.push(length)
  }

  return words
}

function toBuffer(words, includeLength) {
  let size = words.length << 2

  if (includeLength) {
    const length = words[words.length - 1]
    if (length < 0 || length > size - 4) {
      return Buffer.alloc(0)
    }
    size = length
  }

  const buffer = Buffer.alloc(size)

  for (let index = 0; index < size; index++) {
    buffer[index] = (words[index >>> 2] >>> ((index & 3) << 3)) & 0xFF
  }

  return buffer
}

function mx(sum, y, z, p, e, key) {
  return (
    ((((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^
      ((sum ^ y) + (key[(p & 3) ^ e] ^ z))) >>> 0
  )
}

export function encrypt(data, key) {
  const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const keyBuffer = Buffer.isBuffer(key) ? key : Buffer.from(key)

  if (!dataBuffer.length) {
    return Buffer.alloc(0)
  }

  const words = toUint32Array(dataBuffer, true)
  const keyWords = normalizeKey(keyBuffer)
  const rounds = Math.floor(6 + (52 / words.length))
  const last = words.length - 1

  let sum = 0
  let z = words[last]
  let y

  for (let round = 0; round < rounds; round++) {
    sum = (sum + DELTA) >>> 0
    const e = (sum >>> 2) & 3

    for (let index = 0; index < last; index++) {
      y = words[index + 1]
      z = words[index] = (words[index] + mx(sum, y, z, index, e, keyWords)) >>> 0
    }

    y = words[0]
    z = words[last] = (words[last] + mx(sum, y, z, last, e, keyWords)) >>> 0
  }

  return toBuffer(words, false)
}

export function decrypt(data, key) {
  const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const keyBuffer = Buffer.isBuffer(key) ? key : Buffer.from(key)

  if (!dataBuffer.length) {
    return Buffer.alloc(0)
  }

  const words = toUint32Array(dataBuffer, false)
  const keyWords = normalizeKey(keyBuffer)
  const last = words.length - 1
  const rounds = Math.floor(6 + (52 / words.length))

  let sum = (rounds * DELTA) >>> 0
  let y = words[0]
  let z

  while (sum !== 0) {
    const e = (sum >>> 2) & 3

    for (let index = last; index > 0; index--) {
      z = words[index - 1]
      y = words[index] = (words[index] - mx(sum, y, z, index, e, keyWords)) >>> 0
    }

    z = words[last]
    y = words[0] = (words[0] - mx(sum, y, z, 0, e, keyWords)) >>> 0
    sum = (sum - DELTA) >>> 0
  }

  return toBuffer(words, true)
}
