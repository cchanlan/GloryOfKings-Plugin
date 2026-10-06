/**
 * 插件入口：初始化数据文件 → 并发加载 `apps/` 下所有模块 → 挂黑名单闸门。
 *
 * ## 加载约定
 *
 * `apps/` 下的 `.js` 文件**不需要注册**，扫到就加载，取它的 default 导出
 * （没有 default 就取第一个导出）当云崽的 plugin 实例。所以新增指令只要
 * 往 `apps/` 丢一个文件，不用改这里。
 *
 * 同时会尝试加载 `local/`（主人专属指令，不进公开仓）。**没有这个目录是正常的**，
 * 静默跳过。
 *
 * ⚠️ 单个模块加载失败**不能拖垮整个插件**：`apps/` 里有 60 多个模块，
 * 任何一个语法错 / 依赖缺失都只记一条日志并继续，其余功能照常可用。
 * 这也是为什么下面每个 import 都包在 try 里。
 */
import path from 'node:path'
import { writeYamlFile } from './utils/yamlUtils.js'
import { guardApps } from './utils/blackList.js'
import { fillDefaultShareUrl, migrateLegacyShareToken } from './utils/shareDefaults.js'
import { PluginName, PluginData } from './components/Path.js'
import fs from 'node:fs/promises'
import chalk from 'chalk'
import { fileURLToPath, pathToFileURL } from 'url'

/** 启动时要确保存在的数据文件 / 目录 */
const paths = {
  userSettingsDir: path.join(PluginData, 'user_settings'),
  userDataFile: path.join(PluginData, 'UserData.yaml'),
  gameRecordPushFile: path.join(PluginData, 'GameRecordPush.yaml'),
  userSettingsFile: path.join(PluginData, 'user_settings.yaml'),
  gameStatsPushSettingsFile: path.join(PluginData, 'gameStatsPushSettings.yaml')
}

async function checkAndCreatePaths () {
  for (const [key, filePath] of Object.entries(paths)) {
    // 已存在就什么都不做。早先是无论存在与否都打一句「文件已创建」，
    // 于是每次启动都刷 5 行假的「已创建」日志
    try {
      await fs.access(filePath)
      continue
    } catch {}

    try {
      if (key.includes('Dir')) {
        await fs.mkdir(filePath, { recursive: true })
      } else {
        // 订阅表要有个 pushList 骨架，其余的空对象就够
        await writeYamlFile(filePath, key === 'gameRecordPushFile' ? { pushList: {} } : {})
      }
      logger.info(`[${PluginName}] 初始化数据文件：${key}`)
    } catch (error) {
      logger.error(`处理路径 ${filePath} 时发生错误: ${error.message}`)
    }
  }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appsDir = path.join(__dirname, 'apps')

const startTime = Date.now()
const apps = {}

let successCount = 0
let failureCount = 0

logger.info(chalk.cyan('王者荣耀插件载入中...'))

/**
 * 递归收集目录下所有 `.js` 模块的 URL。
 *
 * @param {string} directory
 * @returns {Promise<{name: string, filePath: string}[]>}
 */
async function scanDirectory (directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const tasks = []

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      tasks.push(scanDirectory(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      tasks.push({
        name: path.basename(entry.name, '.js'),
        filePath: pathToFileURL(fullPath).href
      })
    }
  }

  return (await Promise.all(tasks)).flat()
}

async function loadModules () {
  try {
    const filePaths = await scanDirectory(appsDir)

    // 本地扩展目录：主人专属的指令放这儿（不进公开仓，别人的机器人不会有）。
    // 没有这个目录是**正常情况**，静默跳过 —— 公开仓里不带它。
    try {
      filePaths.push(...await scanDirectory(path.join(__dirname, 'local')))
      logger.debug(`[${PluginName}] 已加载本地扩展目录 local/`)
    } catch {
      // 没有 local/ 就跳过
    }

    logger.debug(`[${PluginName}] 构建模块路径完成，共计 ${filePaths.length} 个模块。`)

    logger.debug(`[${PluginName}] 开始并发加载所有模块...`)

    const loadModules = filePaths.map(async ({ name, filePath }) => {
      const loadStartTime = Date.now()

      try {
        const moduleExports = await import(filePath)
        const defaultExport = moduleExports?.default || moduleExports[Object.keys(moduleExports)[0]]

        if (!defaultExport) {
          logger.debug(`[${PluginName}] 模块 ${name} 没有有效的导出内容`)
          return
        }

        // 同名模块（local/ 里覆盖 apps/ 的同名文件）依次挂 _1、_2，
        // 保证每个实例都被云崽注册上，不会后者顶掉前者
        let newName = name
        let counter = 1

        while (apps[newName]) {
          newName = `${name}_${counter}`
          counter++
        }

        apps[newName] = defaultExport

        const loadTime = Date.now() - loadStartTime
        logger.debug(chalk.green(`[${PluginName}] 成功载入模块：${newName}，耗时 ${loadTime} ms`))
        successCount++
      } catch (error) {
        // 只记日志，绝不往外抛：一个坏模块不该让整个插件起不来
        logger.error(chalk.red(`[${PluginName}] 加载模块失败：${name}`))
        logger.error(error)
        failureCount++
      }
    })

    await Promise.all(loadModules)
  } catch (error) {
    logger.error(`[${PluginName}] 扫描或加载文件时出错：${chalk.red(error.message)}`)
    logger.debug(error)
  }
}

await checkAndCreatePaths()

/**
 * ⭐ **升级上来的老用户，第一次启动就把共享库地址补上**（2026-10-06 修）。
 *
 * ⚠️⚠️ 为什么非得放在**启动**这一步：模板里加了默认值（`config/default_config/
 *    config.yaml` 的 `shareApiUrl`）**救不了老用户** —— 他们的 `config/config/
 *    config.yaml` 是当年从**旧模板**复制出来的，里面明明白白写着 `shareApiUrl: ''`，
 *    而配置合并规则是「用户值优先」（空串也是合法值），于是模板的新默认值被这个空串
 *    盖掉，永远轮不到它生效。
 *
 *    原先只在两个地方补：① 重发接入指令时 ② 打开锅巴配置页时。
 *    ① 老用户不会做（他早接好了）；② 他不打开就永远补不上 ——
 *    现象就是「别的用户锅巴上地址一片空白」，正是主人 2026-10-06 指出的那条。
 *    放到启动时补，覆盖所有老用户，且不依赖他去点任何东西。
 *
 * 只写**空**的那格，用户自己填过的地址一律不动（见 utils/shareDefaults.js）。
 * 失败不能影响启动：配置写不进去最多是这一格空着，插件本身照常用。
 */
try {
  const filled = fillDefaultShareUrl()
  const moved = migrateLegacyShareToken()
  if (filled) logger.info(`[${PluginName}] 已补上共享库地址（老配置里那格是空的）`)
  if (moved) logger.info(`[${PluginName}] 已把旧配置里的接入令牌搬到锅巴认的那一格`)
} catch (error) {
  logger.warn(`[${PluginName}] 补共享库默认值失败（不影响使用）：${error?.message || error}`)
}

await loadModules()

// 黑名单闸门：给所有 app 的方法统一套一层，名单里的人发王者指令一律不响应。
// 必须在模块全部加载完之后做（拿到的才是完整的 apps），详见 utils/blackList.js
const guardedCount = guardApps(apps)

const endTime = Date.now()
const elapsedTime = endTime - startTime

logger.info('----------------------')
logger.info(chalk.green('王者荣耀插件载入完成'))
logger.info(`成功加载：${chalk.green(successCount)} 个`)
logger.info(`加载失败：${chalk.red(failureCount)} 个`)
logger.info(`总耗时：${chalk.yellow(elapsedTime)} 毫秒`)
logger.debug(`[${PluginName}] 黑名单闸门已挂上 ${guardedCount} 个方法`)
logger.info('----------------------')

// 图片缓存清理已经挪到 apps/cacheManager.js：那里既有启动后的一次性清理，
// 也有每天一次的定时任务和 #清理王者缓存 指令，不必在这里再排一个定时器

export { apps }
