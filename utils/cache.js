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

    // 纯内存缓存的过期定时器不该让进程活着等它：不 unref 的话，
    // 一个 TTL 很长的条目会把 node 的退出往后拖到它到期为止
    timeout.unref?.()

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
