/**
 * 进程内的限流组件。
 *
 * 全是内存态，所以**单实例部署才能用**——PM2 cluster 模式下每个 worker 各有一份计数，
 * 限流会按 worker 数放宽。README 里写明了只用单实例；真要开 cluster，
 * 就得把这些换成 Redis 或直接删掉按 IP 那一层，只留数据库里的日配额（那份是准的）。
 *
 * 每个容器都限长：限流的键来自外部输入（IP、QQ 摘要），不限长就是一条内存泄漏。
 */

/** 所有容器共用的兜底上限，防止被大量不同 key 撑爆内存 */
const DEFAULT_MAX_KEYS = 5000

/** Map 按插入顺序迭代，超长时丢掉最早进来的——够用，不需要真正的 LRU 链表 */
function evictOldest (map, max) {
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** 按 key 的令牌桶。用于按 IP 挡扫描器。 */
export class TokenBucket {
  #buckets = new Map()
  #capacity
  #refillPerMs
  #maxKeys

  /**
   * @param {number} perMinute 每分钟补充的令牌数
   * @param {number} burst 桶容量（允许的瞬时突发）
   * @param {number} [maxKeys]
   */
  constructor (perMinute, burst, maxKeys = DEFAULT_MAX_KEYS) {
    this.#capacity = burst
    this.#refillPerMs = perMinute / 60000
    this.#maxKeys = maxKeys
  }

  /** @returns {boolean} 还有令牌则取走一个并返回 true */
  take (key, now = Date.now()) {
    let bucket = this.#buckets.get(key)

    if (!bucket) {
      bucket = { tokens: this.#capacity, at: now }
      this.#buckets.set(key, bucket)
      evictOldest(this.#buckets, this.#maxKeys)
    } else {
      const elapsed = Math.max(0, now - bucket.at)
      bucket.tokens = Math.min(this.#capacity, bucket.tokens + elapsed * this.#refillPerMs)
      bucket.at = now
    }

    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  /** 请求成功时把令牌还回去：合法客户端不该被自己的重试挤掉配额 */
  refund (key) {
    const bucket = this.#buckets.get(key)
    if (bucket) bucket.tokens = Math.min(this.#capacity, bucket.tokens + 1)
  }

  get size () {
    return this.#buckets.size
  }
}

/**
 * 冷却表：某个 key 在 TTL 内只认第一次的结果，后续直接复用。
 *
 * 用在 (client, qq) 这一层。客户端缓存失效时（重启、清缓存），所有 bot 会同时来查
 * 同一批热点 QQ；没有这道闸，服务端的 QPS 会随 bot 数量线性放大。顺带把命中期间的
 * 响应一起存下来，冷却期内的请求连 SQL 都不用跑。
 */
export class Cooldown {
  #entries = new Map()
  #maxKeys

  constructor (maxKeys = 1000) {
    this.#maxKeys = maxKeys
  }

  /** @returns {*} 冷却中则返回上次存的值，否则 undefined */
  get (key, now = Date.now()) {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    if (entry.until <= now) {
      this.#entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set (key, value, ttlMs, now = Date.now()) {
    this.#entries.set(key, { until: now + ttlMs, value })
    evictOldest(this.#entries, this.#maxKeys)
  }

  /**
   * 主动失效。
   * 写操作（PUT / DELETE）之后必须调它，否则会出现「刚上传完立刻查询，
   * 拿到的却是写之前那份冷却响应」——用户会以为自己的操作没生效。
   */
  delete (key) {
    this.#entries.delete(key)
  }

  get size () {
    return this.#entries.size
  }
}

/** 固定窗口计数器。用于全局请求上限这种「整分钟数一下」的场景。 */
export class WindowCounter {
  #windowMs
  #limit
  #count = 0
  #windowStart = 0

  constructor (limit, windowMs = 60000) {
    this.#limit = limit
    this.#windowMs = windowMs
  }

  /** @returns {boolean} 未超限并已计入 */
  take (now = Date.now()) {
    if (now - this.#windowStart >= this.#windowMs) {
      this.#windowStart = now
      this.#count = 0
    }

    if (this.#count >= this.#limit) return false
    this.#count += 1
    return true
  }
}

/**
 * 认证失败封禁：同一个来源连续失败太多次就拉黑一段时间。
 * 专门对付拿一堆 token 撞库的脚本——单次 401 很便宜，但它会一直试。
 */
export class FailureBan {
  #failures = new Map()
  #banned = new Map()
  #threshold
  #windowMs
  #banMs

  constructor ({ threshold = 20, windowMs = 60000, banMs = 300000 } = {}) {
    this.#threshold = threshold
    this.#windowMs = windowMs
    this.#banMs = banMs
  }

  isBanned (key, now = Date.now()) {
    const until = this.#banned.get(key)
    if (until === undefined) return false
    if (until <= now) {
      this.#banned.delete(key)
      return false
    }
    return true
  }

  /** @returns {boolean} 本次失败后是否触发了封禁 */
  recordFailure (key, now = Date.now()) {
    let entry = this.#failures.get(key)
    if (!entry || now - entry.at > this.#windowMs) {
      entry = { count: 0, at: now }
      this.#failures.set(key, entry)
      evictOldest(this.#failures, DEFAULT_MAX_KEYS)
    }

    entry.count += 1
    if (entry.count < this.#threshold) return false

    this.#failures.delete(key)
    this.#banned.set(key, now + this.#banMs)
    evictOldest(this.#banned, DEFAULT_MAX_KEYS)
    return true
  }

  clear (key) {
    this.#failures.delete(key)
  }
}
