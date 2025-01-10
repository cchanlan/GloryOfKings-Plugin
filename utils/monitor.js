class Monitor {
  constructor () {
    this.metrics = new Map()
  }

  startTimer (label) {
    this.metrics.set(label, process.hrtime())
  }

  endTimer (label) {
    const start = this.metrics.get(label)
    if (!start) return 0

    const [seconds, nanoseconds] = process.hrtime(start)
    const duration = seconds * 1000 + nanoseconds / 1000000
    this.metrics.delete(label)

    logger.debug(`${label} 耗时: ${duration.toFixed(2)}ms`)
    return duration
  }

  recordMetric (name, value) {
    logger.debug(`${name}: ${value}`)
    // 可以添加指标上报逻辑
  }
}

export default new Monitor()
