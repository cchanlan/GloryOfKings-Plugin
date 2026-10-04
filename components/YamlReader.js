/**
 * YAML 读写：**带注释往返**是这里的核心价值。
 *
 * 用 `yaml` 的 `parseDocument` 而不是 `parse` —— 前者保留注释、缩进、键序，
 * 后者只给一个纯对象。用户的配置文件是**手写**的，里面全是「这行是干嘛的」
 * 注释；用 `parse` 读一遍再写回去，注释就全没了。所以凡是「改一个键」的操作
 * 都必须走 Document，不能走「读对象 → 改 → 整份覆盖」。
 *
 * ## 为什么不用 lodash / chokidar
 *
 * 原先取嵌套值靠 `lodash.get`、文件监听靠 `chokidar`，但这两个都没写进
 * `package.json` 的 dependencies —— 它们是靠**云崽根目录**的 node_modules
 * 才解析得到的。别人机器上（尤其是不带这两个包的框架）一加载插件就崩。
 * 现在两个依赖都去掉了：取嵌套值自己走 10 行，监听用内置 `node:fs`。
 *
 * ⚠️ `isWatch` 目前**没有任何调用方传 true**（全插件只有这里提到它）。
 * 留着是为了接口兼容，实现换成 `fs.watch`，不再是 chokidar。
 */
import fs from 'node:fs'
import YAML from 'yaml'

/**
 * 按路径取嵌套值。支持 `a.b.c` 与 `a[0].b` / `a.0.b` 两种写法，
 * 任一层缺失返回 `undefined`（不抛）—— 调用方大量依赖「取不到就是 undefined」。
 *
 * @param {unknown} root
 * @param {string} keyPath
 * @returns {unknown}
 */
function readPath (root, keyPath) {
  if (root == null || !keyPath) return undefined

  // `a[0].b` → ['a', '0', 'b']；纯 `a.b.c` 也走同一条
  const segments = String(keyPath)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(seg => seg !== '')

  let current = root
  for (const seg of segments) {
    if (current == null) return undefined
    current = current[seg]
  }
  return current
}

export default class YamlReader {
  /**
   * @param {string} yamlPath yaml 文件绝对路径
   * @param {boolean} isWatch 是否监听文件变化（当前无调用方使用）
   */
  constructor (yamlPath, isWatch = false) {
    this.yamlPath = yamlPath
    this.isWatch = isWatch
    this.initYaml()
  }

  initYaml () {
    // parseDocument 保留注释
    this.document = YAML.parseDocument(fs.readFileSync(this.yamlPath, 'utf8'))
    if (this.isWatch && !this.watcher) {
      // fs.watch 的 change 可能连发两次（写入 + 元数据），
      // 靠 isSave 标志把「自己写的」那一次过滤掉，避免无谓重读
      this.watcher = fs.watch(this.yamlPath, () => {
        if (this.isSave) {
          this.isSave = false
          return
        }
        this.initYaml()
      })
    }
  }

  /** 返回读取的对象 */
  get jsonData () {
    if (!this.document) return null
    return this.document.toJSON()
  }

  /**
   * 从 YAML 文件中读取数据（不带注释，纯对象）。
   * @param {string} filePath
   * @returns {object}
   */
  readYamlFile (filePath) {
    return YAML.parse(fs.readFileSync(filePath, 'utf8'))
  }

  /**
   * 把数据写进 YAML 文件。
   * ⚠️ 这是**整份覆盖**，注释不会保留 —— 需要保注释的场景用 `set`。
   * @param {string} filePath
   * @param {object} data
   */
  writeYamlFile (filePath, data) {
    fs.writeFileSync(filePath, YAML.stringify(data), 'utf8')
  }

  /** 集合里是否含该 key */
  has (keyPath) {
    return this.document.hasIn(keyPath.split('.'))
  }

  /** 取 key 的值（取不到返回 undefined） */
  get (keyPath) {
    return readPath(this.jsonData, keyPath)
  }

  /** 改某个 key 的值（保留注释） */
  set (keyPath, value) {
    this.document.setIn(keyPath.split('.'), value)
    this.save()
  }

  /** 删 key */
  delete (keyPath) {
    this.document.deleteIn(keyPath.split('.'))
    this.save()
  }

  /** 数组追加 */
  addIn (keyPath, value) {
    this.document.addIn(keyPath.split('.'), value)
    this.save()
  }

  /**
   * 彻底删除某个 key。
   *
   * ⚠️ 原实现这里调了 `this.mapParentKeys(keys)`，而**这个方法在类里根本不存在**
   * —— 一旦有人调用就是 `TypeError`。全插件目前 0 处调用，所以一直没暴露。
   * 这里按方法名与注释的本意实现：父级若不存在就什么都不做（而不是抛），
   * 存在就删掉那个键。
   */
  deleteKey (keyPath) {
    const keys = keyPath.split('.')
    const parent = keys.slice(0, -1)
    const last = keys[keys.length - 1]
    // 父路径不存在时 deleteIn 会一路建出空节点，这里先挡掉
    if (parent.length && !this.document.hasIn(parent)) return
    this.document.deleteIn([...parent, last])
    this.save()
  }

  /** 写回文件 */
  save () {
    this.isSave = true
    fs.writeFileSync(this.yamlPath, this.document.toString(), 'utf8')
  }
}
