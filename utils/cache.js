/**
 * 极简内存缓存：带 TTL、键级删除、整体清空。
 *
 * 只服务「同一个东西短时间内重复请求就别再打接口」这类场景（王者营地接口
 * 有频率限制），所以刻意不做容量上限、不做淘汰策略 —— 条数由调用方自己控制，
 * 每个条目到期自动删。
 *
 * ⚠️ 定时器一律 `unref()`：纯内存缓存的过期定时器不该拖着进程不让退出。
 * 不 unref 的话，一个 TTL 很长的条目会让 node 在「其它活都干完了」之后
 * 还得多等它到期才退。
 */
class Cache {
  constructor () {
    /** key → 值 */
    this.cache = new Map()
    /** key → 过期定时器（用来在覆盖或删除时取消） */
    this.timeouts = new Map()
  }

  /**
   * 取值。没有或已过期返回 `undefined`。
   * @param {string} key
   */
  get (key) {
    if (this.cache.has(key)) {
      return this.cache.get(key)
    }
    return undefined
  }

  /**
   * 存值。
   * @param {string} key
   * @param {unknown} value
   * @param {number} ttl 存活秒数，默认 300
   * @returns {boolean} 恒为 true（保持原有返回约定）
   */
  set (key, value, ttl = 300) {
    this.cache.set(key, value)

    // 覆盖同一个键时先撤掉旧定时器，否则旧的那次到期会把新值一起删掉
    if (this.timeouts.has(key)) {
      clearTimeout(this.timeouts.get(key))
    }

    const timeout = setTimeout(() => {
      this.cache.delete(key)
      this.timeouts.delete(key)
    }, ttl * 1000)

    timeout.unref?.()

    this.timeouts.set(key, timeout)
    return true
  }

  /**
   * 删一个键（连同它的定时器）。
   * @param {string} key
   * @returns {boolean} 缓存里原本是否有这个键
   */
  del (key) {
    if (this.timeouts.has(key)) {
      clearTimeout(this.timeouts.get(key))
      this.timeouts.delete(key)
    }
    return this.cache.delete(key)
  }

  /** 全部清空，并把所有定时器撤掉 */
  flush () {
    for (const timeout of this.timeouts.values()) {
      clearTimeout(timeout)
    }
    this.timeouts.clear()
    this.cache.clear()
    return true
  }
}

export default new Cache()
