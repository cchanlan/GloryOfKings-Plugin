import fs from 'fs'
import YAML from 'yaml'
import { writeFileAtomic } from './safeStore.js'

/**
 * 从 YAML 文件中读取数据。
 *
 * @param {string} filePath - 要读取的 YAML 文件的路径。
 * @returns {object} - 从文件中解析出的 YAML 数据。
 */
export function readYamlFile (filePath) {
  return YAML.parse(fs.readFileSync(filePath, 'utf8'))
}

/**
 * 将数据写入 YAML 文件。
 *
 * 走原子写（`.tmp` + rename）而不是裸 `writeFileSync`：订阅表 `GameRecordPush.yaml`
 * 被推送轮询每轮每个订阅写一次（约 3600 次/天），裸写撞上 `pm2 restart` 就留半截文件，
 * 而读方的 catch 会静默按空表继续、下一次写再把空表固化下来。理由详见 utils/safeStore.js。
 *
 * @param {string} filePath - 要写入的 YAML 文件的路径。
 * @param {object} data - 要写入文件的数据。
 * @returns {void}
 */
export function writeYamlFile (filePath, data) {
  writeFileAtomic(filePath, YAML.stringify(data))
}
