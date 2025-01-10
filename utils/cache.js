class Cache {
  constructor () {
    this.cache = new Map()
    this.timeouts = new Map()
  }

  get (key) {
    if (this.cache.has(key)) {
      return this.cache.get(key)
    }
    return undefined
  }

  set (key, value, ttl = 300) {
    this.cache.set(key, value)

    // 清除旧的超时
    if (this.timeouts.has(key)) {
      clearTimeout(this.timeouts.get(key))
    }

    // 设置新的超时
    const timeout = setTimeout(() => {
      this.cache.delete(key)
      this.timeouts.delete(key)
    }, ttl * 1000)

    this.timeouts.set(key, timeout)
    return true
  }

  del (key) {
    if (this.timeouts.has(key)) {
      clearTimeout(this.timeouts.get(key))
      this.timeouts.delete(key)
    }
    return this.cache.delete(key)
  }

  flush () {
    // 清除所有超时
    for (const timeout of this.timeouts.values()) {
      clearTimeout(timeout)
    }
    this.timeouts.clear()
    this.cache.clear()
    return true
  }
}

export default new Cache()
