/**
 * 配置读写与合并。
 *
 * ## 为什么不用 lodash / chokidar
 *
 * 原先 `mergeObjectsWithPriority` 靠 `lodash` 的 `isArray` / `isPlainObject` /
 * `isEqual` / `mergeWith`，配置热重载靠 `chokidar` —— 但这两个包**都没写进
 * `package.json` 的 dependencies**，它们是靠云崽根目录的 node_modules 才解析到的。
 * 换个不带这两个包的框架、或者干净安装一次，插件在 `components/Config.js`
 * 这一层就 `ERR_MODULE_NOT_FOUND` 直接起不来（配置是几乎所有功能的入口）。
 * 现在两处依赖都换成自带实现：深比较与深合并约 80 行，热重载用内置 `node:fs`。
 *
 * ⚠️ `mergeObjectsWithPriority` 的行为**必须逐字节保持**：它的返回值会被
 * `loadConfigFile` 逐个键写回用户的配置文件，合并语义偏一点就是在改用户的设置。
 * 重写时配了差分测试（同一输入，新旧实现的返回值与写出的文件都要一致）。
 */
import YAML from 'yaml'
import fs from 'node:fs'
import YamlReader from './YamlReader.js'
import { PluginPath } from './Path.js'
import { isPlainObject, isEqual, eq, isObjectLike, assignValue, safeGet } from './objectUtils.js'

/**
 * 按自定义规则深合并 —— 对应 `lodash.mergeWith`。
 *
 * 语义按 lodash 来：**只有 `customizer` 返回 `undefined` 时才走默认合并**。
 * 本文件那个 customizer 的每个分支都会返回值，所以实际效果就是
 * 「逐个键取 customizer 的结果」；仍保留 `undefined` 的回落分支，
 * 免得以后有人改 customizer 时踩到语义差异。
 *
 * ⚠️ 赋值短信用 `SameValueZero`（`===` + `NaN`）而不是深比较 —— 这是 lodash
 *    `assignMergeValue` 的实际行为。值只是**深相等**时它仍会覆盖（换成源对象的
 *    引用），用深比较会少赋一次。内容一样，但差分测试比的是行为，别自作聪明。
 *
 * `stack` 的作用与 lodash `baseMergeDeep` 一致：挡「默认合并分支」里的自引用。
 * ⚠️ 但 customizer 每次递归都会**新开一份栈**（lodash 的 `mergeWith` 内部也是
 *    自己 new Stack），所以真正带锚点成环的 YAML 两边一样会爆栈 —— 这里刻意
 *    保持与旧实现一致，不做行为改进。插件自己的配置里没有任何锚点/别名。
 *
 * @param {object} target 合并目标（调用方传空对象）
 * @param {object[]} sources
 * @param {(objValue: unknown, srcValue: unknown, key: string, object: object, source: object, stack: WeakMap) => unknown} customizer
 * @param {WeakMap<object, object>} [stack]
 * @returns {object}
 */
function mergeWith (target, sources, customizer, stack = new WeakMap()) {
  for (const source of sources) {
    if (!source) continue
    if (target === source) continue

    for (const key of Object.keys(source)) {
      const srcValue = safeGet(source, key)
      const objValue = safeGet(target, key)

      // 源值是对象时先查环（对应 baseMergeDeep 开头的 stacked 判断）
      if (isObjectLike(srcValue)) {
        const stacked = stack.get(srcValue)
        if (stacked) {
          assignValue(target, key, stacked)
          continue
        }
      }

      let newValue = customizer(objValue, srcValue, key, target, source, stack)

      if (newValue === undefined) {
        // 默认合并（lodash 的 baseMergeDeep 分支）
        if (Array.isArray(srcValue)) {
          newValue = Array.isArray(objValue) ? objValue : srcValue.slice()
        } else if (isPlainObject(srcValue)) {
          newValue = isPlainObject(objValue) ? objValue : {}
          stack.set(srcValue, newValue)
          mergeWith(newValue, [srcValue], customizer, stack)
          stack.delete(srcValue)
        } else {
          newValue = srcValue
        }
      }

      // assignMergeValue：值一样（SameValueZero）就不动
      if (newValue !== undefined ? !eq(objValue, newValue) : !(key in target)) {
        assignValue(target, key, newValue)
      }
    }
  }
  return target
}

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

    // ⚠️ 解析必须放在 try 里：用户手抖写坏 YAML 时 YAML.parse 会直接抛，
    //    而那是在下面的 try 之外 —— 插件会因此**整个起不来**（一份坏配置拦住所有功能）。
    let config = {}
    let defConfig = {}
    try {
      config = YAML.parse(fs.readFileSync(`${path}${file}`, 'utf8')) || {}
      defConfig = YAML.parse(fs.readFileSync(`${pathDef}${file}`, 'utf8')) || {}
      this.validateConfig(config, file)
      const { differences, result } = this.mergeObjectsWithPriority(config, defConfig)

      if (differences) {
        // ⚠️ 这里**不再** `copyFileSync(模板 → 用户)`。
        //    那句会把用户手写的注释整份吃掉（值靠下面的循环能救回来，注释救不回）。
        //    合并结果 result 里已经同时有「模板的新键」和「用户的值」，所以
        //    去掉它不影响「新键自动补默认值」这个好处 —— 循环会把 result 的每个键写回去。
        for (const key in result) {
          this.modify(file.replace('.yaml', ''), key, result[key])
        }
      }
    } catch (error) {
      // ⚠️ 校验失败时**以前只做了 copyFileSync**：用户的所有设置（包括令牌）
      //    会被模板整份盖掉，而且是静默的。改成「模板只当缺失键的兜底」：
      //    能解析出来的键一律保留，缺的用模板值补，然后再走同一套写回。
      logger.error(`配置文件 ${file} 读取/校验未通过，改为按缺失键兜底（能读到的值保留）：${error.message}`)
      try {
        const { result } = this.mergeObjectsWithPriority(config || {}, defConfig || {})
        for (const key in result) {
          this.modify(file.replace('.yaml', ''), key, result[key])
        }
      } catch (inner) {
        // 兜底也失败（磁盘满、权限不对…）：只记日志，**绝不能再抛**
        logger.error(`配置文件 ${file} 兜底写回失败，本次用默认值运行：${inner.message}`)
      }
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

    // ⚠️ 这里也必须容错：同一份被写坏的 YAML，loadConfigFile 里已经兜住了，
    //    但读的时候会再解析一次 —— 裸 `YAML.parse` 一抛，插件在
    //    `getDefOrConfig` 那一步整个挂掉（一份坏配置 → 所有功能不可用）。
    //    解析不出来就当空对象，让默认配置兜住，并在日志里说清是哪个文件。
    try {
      this.config[key] = YAML.parse(fs.readFileSync(file, 'utf8')) || {}
    } catch (error) {
      logger.error(`配置 ${file} 解析失败，本次用默认值运行：${error.message}`)
      this.config[key] = {}
    }

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
    //
    // ⚠️ 用内置 `fs.watch` 而不是 chokidar（见文件头）。失败**不能往外抛**：
    //    调用方是 getYaml，它一旦抛就等于「一份读不到的配置让插件起不来」，
    //    而这里只是个热重载优化 —— 监听不上顶多是改完配置要重启云崽。
    let watcher
    try {
      watcher = fs.watch(file, () => {
        delete this.config[key]
        if (typeof Bot == 'undefined') return
        logger.mark(`[GloryOfKings-Plugin][修改配置文件][${type}][${name}]`)
      })
      watcher.on('error', () => {
        // 文件被删/被替换时监听会失效，清掉记录让下次 getYaml 重新挂
        try { watcher.close() } catch { /* 已经关了就算了 */ }
        delete this.watcher[key]
      })
    } catch (error) {
      logger.error(`监听配置文件 ${file} 失败（改完配置需重启云崽才生效）：${error.message}`)
      return
    }

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
      if (Array.isArray(objValue) && Array.isArray(srcValue)) {
        return objValue
      } else if (isPlainObject(objValue) && isPlainObject(srcValue)) {
        if (!isEqual(objValue, srcValue)) {
          // 与 lodash 版一致：这里**开一份新的合并栈**（lodash 的 mergeWith
          // 内部自己 new Stack），而不是把外层栈传进去
          return mergeWith({}, [objValue, srcValue], customizer)
        }
      } else if (!isEqual(objValue, srcValue)) {
        differences = true
        return objValue !== undefined ? objValue : srcValue
      }
      return objValue !== undefined ? objValue : srcValue
    }

    let result = mergeWith({}, [objA, objB], customizer)

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
