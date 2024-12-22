import path from 'path'
const Path = process.cwd()
const PluginName = 'GloryOfKings-Plugin'
const PluginPath = path.join(Path, 'plugins', PluginName)
const PluginData = path.join(PluginPath, 'data')
export {
  Path,
  PluginPath,
  PluginData,
  PluginName
}
