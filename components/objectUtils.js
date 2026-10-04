/**
 * 对象工具集 —— 替代原先对 `lodash` 的依赖。
 *
 * 只实现插件真正用到的那几个函数，行为对着 lodash 对齐（`Config.js` 与
 * `guoba.support.js` 的差分测试逐条验证过）。
 *
 * **为什么不直接用 lodash**：`package.json` 里从来没有声明过它。
 * 在宿主的 `node_modules` 里恰好存在时能用，装到干净的云崽上就会
 * `Cannot find package 'lodash'` —— 配置是几乎所有功能的入口，插件会直接起不来。
 *
 * **为什么放 components/ 而不是 utils/**：`components/Config.js` 要用这里的函数，
 * 而 `utils/` 里不少模块会 import `#components`。放 `utils/` 会形成
 * 「components → utils → components」的循环依赖，放 `components/` 就没有这个问题。
 */

/**
 * 是否是「纯对象」—— 对应 `lodash.isPlainObject`。
 *
 * 只认 `{}` 字面量、`Object.create(null)`、以及 `new Object()` 这类；
 * 数组、`Date`、`Map`、类实例都不算。YAML 解析出来的嵌套结构正是这种。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainObject (value) {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 深比较 —— 对应 `lodash.isEqual` 里我们用得到的部分。
 *
 * 覆盖 YAML 能产出的全部值类型（null / 布尔 / 数字 / 字符串 / 数组 / 纯对象），
 * 外加 `Date` 与 `RegExp`（配置里写日期时会被解析成这两种）。
 * `NaN` 与 `NaN` 视为相等（SameValueZero），跟 lodash 一致。
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function isEqual (a, b) {
  if (a === b) return true
  // NaN
  if (typeof a === 'number' && typeof b === 'number') return a !== a && b !== b
  if (a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }
  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && String(a) === String(b)
  }

  const aIsArray = Array.isArray(a)
  if (aIsArray !== Array.isArray(b)) return false

  if (aIsArray) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!isEqual(a[i], b[i])) return false
    }
    return true
  }

  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!isEqual(a[key], b[key])) return false
  }
  return true
}

/**
 * `SameValueZero` —— 对应 `lodash.eq`：`===` 之外额外把 `NaN` 当作等于自身。
 * 注意这**不是**深比较，lodash 的赋值短路用的就是这个。
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function eq (a, b) {
  return a === b || (a !== a && b !== b)
}

/**
 * 是否是「对象」—— 对应 lodash 的 `isObjectLike`（非 null 的对象）。
 * 只用来决定「要不要走查环那条路」，函数也算（YAML 里不会出现函数）。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isObjectLike (value) {
  return value !== null && typeof value === 'object'
}

/**
 * 赋值 —— 对应 `baseAssignValue`。
 *
 * `__proto__` 必须走 `defineProperty` 建**自有属性**：直接 `target['__proto__'] = x`
 * 会改掉原型链（原型污染），配置文件里真写了 `__proto__` 就成了攻击面。
 *
 * @param {object} target
 * @param {string} key
 * @param {unknown} value
 */
export function assignValue (target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    })
  } else {
    target[key] = value
  }
}

/**
 * 读值 —— 对应 `safeGet`：`__proto__` 一律当读不到，避免顺着原型链取到东西。
 *
 * @param {object} object
 * @param {string} key
 * @returns {unknown}
 */
export function safeGet (object, key) {
  if (key === '__proto__') return undefined
  return object[key]
}

/**
 * 按 `a.b[0].c` 这样的路径读嵌套值 —— 对应 `lodash.get`。
 *
 * 支持点号与数组下标两种写法（`a.b` / `a[0].b` / `a[0][1]`），
 * 这也是配置项的写法；中途遇到 `null`/`undefined` 就返回 `defaultValue`。
 *
 * ⚠️ 路径里的 `__proto__` 一律当读不到 —— `lodash.get` 在这个键上的行为
 *    受版本影响（新版本会拦），这里统一按「读不到」处理更安全。
 *
 * @param {unknown} object 目标对象
 * @param {string} path 路径
 * @param {unknown} [defaultValue]
 * @returns {unknown}
 */
export function get (object, path, defaultValue) {
  if (object == null) return defaultValue
  if (typeof path !== 'string' || path === '') return defaultValue

  // 把 `a[0].b` 归一成 `a.0.b`，再按点切
  const keys = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(key => key !== '')

  let current = object
  for (const key of keys) {
    if (key === '__proto__') return defaultValue
    if (current == null) return defaultValue
    current = current[key]
  }
  return current === undefined ? defaultValue : current
}
