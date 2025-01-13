import ApiService from './api.js'
import {
  readJsonFile,
  writeJsonFile,
  getFilePath
} from './fileUtils.js'
import {
  readYamlFile,
  writeYamlFile
} from './yamlUtils.js'
import monitor from './monitor.js'
import cache from './cache.js'
import path from 'path'
import { PluginData } from '#components'

export {
  ApiService,
  readJsonFile,
  writeJsonFile,
  getFilePath,
  readYamlFile,
  writeYamlFile,
  monitor,
  cache
}

export function getCurrentId (userId) {
  const filePath = path.join(PluginData, 'UserData.yaml')
  const userData = readYamlFile(filePath)

  if (!userData[userId] || !userData[userId].ids.length) {
    return null
  }

  return userData[userId].ids[userData[userId].current]
}
