import fs from 'fs'
import YAML from 'yaml'

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
 * @param {string} filePath - 要写入的 YAML 文件的路径。
 * @param {object} data - 要写入文件的数据。
 * @returns {void}
 */
export function writeYamlFile (filePath, data) {
  fs.writeFileSync(filePath, YAML.stringify(data), 'utf8')
}
