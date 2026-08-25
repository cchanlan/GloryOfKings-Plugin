import YAML from 'yaml'
import chokidar from 'chokidar'
import fs from 'node:fs'
import YamlReader from './YamlReader.js'
import _ from 'lodash'
import { PluginPath } from './Path.js'
class Config {
  constructor () {
    this.config = {}
    /** 监听文件 */
    this.watcher = { config: {}, defSet: {} }

    this.initCfg()
  }

  initCfg () {
    try {
      let path = `${PluginPath}/config/config/`
      if (!fs.existsSync(path)) fs.mkdirSync(path, { recursive: true })

      const pathDef = `${PluginPath}/config/default_config/`
      const files = fs.readdirSync(pathDef).filter(file => file.endsWith('.yaml'))

      for (let file of files) {
        this.loadConfigFile(file, path, pathDef)
      }
    } catch (error) {
      logger.error(`配置初始化失败: ${error.message}`)
      throw error
    }
  }

  loadConfigFile (file, path, pathDef) {
    if (!fs.existsSync(`${path}${file}`)) {
      fs.copyFileSync(`${pathDef}${file}`, `${path}${file}`)
      return
    }

    const config = YAML.parse(fs.readFileSync(`${path}${file}`, 'utf8'))
    const defConfig = YAML.parse(fs.readFileSync(`${pathDef}${file}`, 'utf8'))

    try {
      this.validateConfig(config, file)
      const { differences, result } = this.mergeObjectsWithPriority(config, defConfig)

      if (differences) {
        fs.copyFileSync(`${pathDef}${file}`, `${path}${file}`)
        for (const key in result) {
          this.modify(file.replace('.yaml', ''), key, result[key])
        }
      }
    } catch (error) {
      logger.error(`配置文件 ${file} 验证失败: ${error.message}`)
      fs.copyFileSync(`${pathDef}${file}`, `${path}${file}`)
    }
  }

  /**
   * 获取配置yaml
   * @param type 默认跑配置-defSet，用户配置-config
   * @param name 名称
   */
  getYaml (type, name) {
    let file = `${PluginPath}/config/${type}/${name}.yaml`
    let key = `${type}.${name}`

    if (this.config[key]) return this.config[key]

    this.config[key] = YAML.parse(fs.readFileSync(file, 'utf8'))

    this.watch(file, name, type)

    return this.config[key]
  }

  /**
   * 获取默认配置和用户配置，并将它们合并为一个新的对象返回。
   * @param {string} name - 配置名称
   * @returns {object} - 合并后的配置对象
   */
  getDefOrConfig (name) {
    let def = this.getdefSet(name)
    let config = this.getConfig(name)
    return { ...def, ...config }
  }

  /**
   * 根据配置名称获取默认配置。
   * @param {string} name - 配置名称
   * @returns {object} - 默认配置对象
   */
  getdefSet (name) {
    return this.getYaml('default_config', name)
  }

  /**
   * 根据配置名称获取用户配置。
   * @param {string} name - 配置名称
   * @returns {object} - 用户配置对象
   */
  getConfig (name) {
    return this.getYaml('config', name)
  }

  /** 监听配置文件 */
  watch (file, name, type = 'default_config') {
    let key = `${type}.${name}`
    if (this.watcher[key]) return

    // 监听到变更只需清掉内存缓存，下次 getYaml 会重新读盘。
    // 这里原本还有一大段从 memz-plugin 抄来的逻辑：diff 出新旧配置的差异，
    // 挑出 `servers.*` 的增删开关算成 target。但本插件的配置里从来没有 servers 这个字段，
    // 那段 for 循环永远走不到 continue 之后，算出来的 target 也没有任何人使用 —— 纯死代码，已删。
    const watcher = chokidar.watch(file)
    watcher.on('change', () => {
      delete this.config[key]
      if (typeof Bot == 'undefined') return
      logger.mark(`[GloryOfKings-Plugin][修改配置文件][${type}][${name}]`)
    })

    this.watcher[key] = watcher
  }

  getCfg () {
    let config = this.getDefOrConfig('config')
    return {
      ...config
    }
  }

  /**
   * @description: 修改设置
   * @param {String} name 文件名
   * @param {String} key 修改的key值
   * @param {String|Number} value 修改的value值
   * @param {'config'|'default_config'} type 配置文件或默认
   */
  modify (name, key, value, type = 'config') {
    let path = `${PluginPath}/config/${type}/${name}.yaml`
    new YamlReader(path).set(key, value)
    delete this.config[`${type}.${name}`]
  }

  /**
   * @description: 修改配置数组
   * @param {String} name 文件名
   * @param {String|Number} key key值
   * @param {String|Number} value value
   * @param {'add'|'del'} category 类别 add or del
   * @param {'config'|'default_config'} type 配置文件或默认
   */
  modifyarr (name, key, value, category = 'add', type = 'config') {
    let path = `${PluginPath}/config/${type}/${name}.yaml`
    let yaml = new YamlReader(path)
    if (category == 'add') {
      yaml.addIn(key, value)
    } else {
      let index = yaml.jsonData[key].indexOf(value)
      yaml.delete(`${key}.${index}`)
    }
  }

  setArr (name, key, item, value, type = 'config') {
    let path = `${PluginPath}/config/${type}/${name}.yaml`
    let yaml = new YamlReader(path)
    let arr = yaml.get(key).slice()
    arr[item] = value
    yaml.set(key, arr)
  }

  mergeObjectsWithPriority (objA, objB) {
    let differences = false

    function customizer (objValue, srcValue, key, object, source, stack) {
      if (_.isArray(objValue) && _.isArray(srcValue)) {
        return objValue
      } else if (_.isPlainObject(objValue) && _.isPlainObject(srcValue)) {
        if (!_.isEqual(objValue, srcValue)) {
          return _.mergeWith({}, objValue, srcValue, customizer)
        }
      } else if (!_.isEqual(objValue, srcValue)) {
        differences = true
        return objValue !== undefined ? objValue : srcValue
      }
      return objValue !== undefined ? objValue : srcValue
    }

    let result = _.mergeWith({}, objA, objB, customizer)

    return {
      differences,
      result
    }
  }

  validateConfig (config, file = '') {
    const requiredFieldsByFile = {
      // 只列真正必须存在的字段。校验失败会让 loadConfigFile 的 catch
      // 把默认配置整份盖回用户配置（用户所有设置被静默重置），代价极大，
      // 所以这里宁少勿多：能靠 getDefOrConfig 的默认值兜住的字段就不该进这张表。
      // 早先还列了已废弃的 onlineReminderCron，逼得那个字段只能一直留在
      // config.yaml 里当摆设，删不掉，现在一并摘掉了。
      'config.yaml': ['onlineReminder']
    }
    const requiredFields = requiredFieldsByFile[file] || []
    const missingFields = requiredFields.filter(field => !Object.prototype.hasOwnProperty.call(config, field))

    if (missingFields.length > 0) {
      throw new Error(`缺少必要的配置项: ${missingFields.join(', ')}`)
    }
  }
}
export default new Config()
