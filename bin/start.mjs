#!/usr/bin/env node
/**
 * 共享库的启动入口。pm2 / systemd 都指向这个文件。
 *
 * 用法：
 *   GOK_SALT=... GOK_ADMIN_SECRET=... node bin/start.mjs
 */
import { installGlobalGuards, startServer } from '../src/server.mjs'

installGlobalGuards()

startServer().catch(error => {
  process.stderr.write(`[gok-share] 启动失败：${error?.stack || error}\n`)
  process.exit(1)
})
