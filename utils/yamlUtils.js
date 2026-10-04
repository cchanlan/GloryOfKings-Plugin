/**
 * YAML 读写小工具。
 *
 * 全插件的 yaml 数据文件（订阅表、绑定关系、群报设置……）都从这里进出，
 * 所以两件事只在这一层管，调用方不用重复操心：
 *   · **编码**：一律 UTF-8，调用点不必再写 `'utf8'`（写歪一次就是乱码文件）
 *   · **原子写**：见下面 `writeYamlFile` 的说明
 */
import fs from 'node:fs'
import YAML from 'yaml'
import { writeFileAtomic } from './safeStore.js'

/** 读 UTF-8 文本。YAML 文件全是文本，二进制的那几个不走这里 */
function readUtf8 (filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

/**
 * 从 YAML 文件中读取数据。
 *
 * 文件不存在 / 内容坏了都会**原样抛错**，不在这里兜底 —— 各调用方对「读不到」
 * 的处理不一样（订阅表要静默按空表继续，账号绑定则要隔离留证），
 * 统一兜底会把这两种诉求压成一种。
 *
 * @param {string} filePath - 要读取的 YAML 文件的路径。
 * @returns {object} - 从文件中解析出的 YAML 数据。
 */
export function readYamlFile (filePath) {
  return YAML.parse(readUtf8(filePath))
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
