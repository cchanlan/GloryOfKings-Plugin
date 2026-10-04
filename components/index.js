/**
 * `#components` 别名对应的聚合出口。
 *
 * 插件代码里一律写 `import { Config } from '#components'`，
 * 由 package.json 的 `imports` 字段映射到这里 —— 好处是 `utils/` 内部模块
 * 引用配置时不必写 `../components/Config.js` 这种相对路径，
 * 也就从根上避开了「utils 引 components、components 又引 utils」的循环依赖。
 */
import YamlReader from './YamlReader.js'
import Config from './Config.js'
import {
  Path,
  PluginPath,
  PluginData,
  PluginName
} from './Path.js'

export {
  Path,
  YamlReader,
  Config,
  PluginName,
  PluginPath,
  PluginData
}
