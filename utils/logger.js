class Logger {
  error(message, context = {}) {
    logger.error(`[GloryOfKings-Plugin Error] ${message}`, context)
    // 可以添加错误上报逻辑
  }

  info(message) {
    logger.info(`[GloryOfKings-Plugin Info] ${message}`)
  }

  debug(message) {
    if (process.env.DEBUG) {
      logger.debug(`[GloryOfKings-Plugin Debug] ${message}`)
    }
  }
}

export default new Logger() 