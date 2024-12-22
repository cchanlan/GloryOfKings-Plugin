// import fs from 'fs'
import path from 'path'
import { PluginData } from '#components'
import { readYamlFile } from '#utils'
// import puppeteer from '../../../lib/puppeteer/puppeteer.js'
// import ApiService from '../utils/api.js'
// import { getFilePath, readJsonFile, writeJsonFile } from '../utils/fileUtils.js'

export class GameRecordPush extends plugin {
  constructor () {
    super({
      name: 'gameRecordPush',
      dsc: '战绩推送',
      event: 'message',
      priority: 1,
      rule: [
        {
          reg: /^#(开启|关闭)王者战绩推送/,
          fnc: 'onAndOffGameRecordPush'
        }
      ]
    })
    /*         this.task = {
            name: '[王者战绩推送]',
            fnc: () => gameRecordPush(),
            cron: '0 * * * * *'
        } */
  }

  async onAndOffGameRecordPush (e) {
    if (!e.isGroup) return e.reply('请在群内发送', true)

    const gameRecordPushData = readYamlFile(path.join(PluginData, 'GameRecordPush.yaml'))
    const { pushList } = gameRecordPushData

    if (!gameRecordPushData || !pushList[e.user_id]) {
      return e.reply('战绩推送数据读取失败，请稍后再试。')
    }

    const isEnabled = /^#开启/.test(e.msg)

    if (pushList[e.user_id].group_id === e.group_id && isEnabled) {
      return e.reply('本群已[开启]王者战绩推送，请勿重复[开启]')
    }

    if (!pushList[e.user_id].state && !isEnabled) {
      return e.reply('已[关闭]王者战绩推送，请勿重复[关闭]')
    }

    if (isEnabled) {
      pushList[e.user_id].group_id = e.group_id
      pushList[e.user_id].state = isEnabled

      return e.reply('已[开启]王者战绩推送\r对局结束将在本群推送战绩')
    } else {
      pushList[e.user_id].state = isEnabled
      return e.reply('已[关闭]王者战绩推送\r对局结束将不再推送战绩')
    }
  }
}
