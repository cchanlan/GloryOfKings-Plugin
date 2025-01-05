class Logger {
  error(message, context = {}) {
    if (typeof logger !== 'undefined') {
      logger.error(`[GloryOfKings-Plugin] ${message}`, context)
    } else {
      console.error(`[GloryOfKings-Plugin] ${message}`, context)
    }
  }

  info(message) {
    if (typeof logger !== 'undefined') {
      logger.info(`[GloryOfKings-Plugin] ${message}`)
    } else {
      console.log(`[GloryOfKings-Plugin] ${message}`)
    }
  }

  debug(message) {
    if (process.env.DEBUG) {
      if (typeof logger !== 'undefined') {
        logger.debug(`[GloryOfKings-Plugin] ${message}`)
      } else {
        console.debug(`[GloryOfKings-Plugin] ${message}`)
      }
    }
  }
}

export default new Logger() 