import path from 'node:path'
import { writeYamlFile } from './utils/yamlUtils.js'
import { PluginName, PluginData } from './components/Path.js'
import fs from 'node:fs/promises'
import chalk from 'chalk'
import { fileURLToPath, pathToFileURL } from 'url'

const paths = {
  userSettingsDir: path.join(PluginData, 'user_settings'),
  userDataFile: path.join(PluginData, 'UserData.yaml'),
  gameRecordPushFile: path.join(PluginData, 'GameRecordPush.yaml'),
  userSettingsFile: path.join(PluginData, 'user_settings.yaml'),
  gameStatsPushSettingsFile: path.join(PluginData, 'gameStatsPushSettings.yaml')
}

async function checkAndCreatePaths() {
  for (const [key, filePath] of Object.entries(paths)) {
    try {
      await fs.access(filePath).catch(() => {
        if (key.includes('Dir')) {
          return fs.mkdir(filePath, { recursive: true })
        } else {
          const content = key === 'gameRecordPushFile' ? { pushList: {} } : {}
          return writeYamlFile(filePath, content)
        }
      })
      logger.info(`${key} 文件已创建`)
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

async function scanDirectory(directory) {
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

async function loadModules() {
  try {
    const filePaths = await scanDirectory(appsDir)
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
await loadModules()

const endTime = Date.now()
const elapsedTime = endTime - startTime

logger.info('----------------------')
logger.info(chalk.green('王者荣耀插件载入完成'))
logger.info(`成功加载：${chalk.green(successCount)} 个`)
logger.info(`加载失败：${chalk.red(failureCount)} 个`)
logger.info(`总耗时：${chalk.yellow(elapsedTime)} 毫秒`)
logger.info('----------------------')

export { apps }
