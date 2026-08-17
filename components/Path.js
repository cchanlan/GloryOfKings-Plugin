import path from 'path'
import { fileURLToPath } from 'url'
const Path = process.cwd()
const PluginName = 'GloryOfKings-Plugin'
// 插件根目录按本文件位置反推（components/ 的上一级），不跟 process.cwd() 走：
// 拿 cwd 拼的话，只要有脚本不在 Yunzai 根目录下 import 本模块（调试脚本等），
// Config 的初始化就会在那个 cwd 底下凭空造一份 plugins/GloryOfKings-Plugin/config/，
// 用户数据（data/ 下的 user_settings、UserData.yaml 等）也会写错地方
const PluginPath = path.resolve(fileURLToPath(import.meta.url), '../..')
const PluginData = path.join(PluginPath, 'data')
export {
  Path,
  PluginPath,
  PluginData,
  PluginName
}
