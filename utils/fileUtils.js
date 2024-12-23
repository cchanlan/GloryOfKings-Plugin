import fs from 'fs'
import path from 'path'
import { PluginData } from '#components'
export function readJsonFile (filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

export function writeJsonFile (filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data))
}

export function getFilePath (userId, folder = 'ScanCodeLoginData') {
  return path.join(PluginData, folder, `${userId}.json`)
}
