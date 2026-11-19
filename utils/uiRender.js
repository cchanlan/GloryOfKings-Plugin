import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { Config, PluginPath } from '../components/index.js'
import { buildThemeStyle } from '../components/RenderTheme.js'

/** 仅包装本插件调用，保留宿主截图参数、返回值和异常，不修改全局渲染器。 */
export default {
  screenshot (name, data, ...args) {
    return puppeteer.screenshot(name, {
      ...data,
      _gokUiStyle: buildThemeStyle(Config.getDefOrConfig('config'), PluginPath)
    }, ...args)
  }
}
