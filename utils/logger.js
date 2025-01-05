class Logger {
  error(message, context = {}) {
    console.error(`[GloryOfKings-Plugin Error] ${message}`, context)
    // 可以添加错误上报逻辑
  }

  info(message) {
    console.log(`[GloryOfKings-Plugin Info] ${message}`)
  }

  debug(message) {
    if (process.env.DEBUG) {
      console.log(`[GloryOfKings-Plugin Debug] ${message}`)
    }
  }
}

export default new Logger() 