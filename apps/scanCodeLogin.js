import ApiService from '../utils/api.js'
import fs from 'fs'
import path from 'path'
import common from '../../../lib/common/common.js'
import { readJsonFile, writeJsonFile, getFilePath, writeYamlFile, readYamlFile } from '#utils'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginData } from '#components'

const functionList = [
  '----------',
  '可用功能：',
  '【#王者主页】查看部分王者信息',
  '【#查询战绩】查询王者战绩',
  '【#查询战绩1】查看第一条战绩具体数据'
]

export class ScanCodeLogin extends plugin {
  constructor() {
    super({
      name: 'scanCodeLogin',
      dsc: '王者扫码登录',
      event: 'message',
      priority: 1,
      rule: [
        {
          reg: /^#营地扫码$/,
          fnc: 'scanCodeLogin'
        },
        {
          reg: /^#我的王者Tk$/,
          fnc: 'getMyTokenAndOpenId'
        },
        {
          reg: /^#绑定营地\s+(\d+)$/,
          fnc: 'bindWzryId'
        }
      ]
    })
  }

  async scanCodeLogin(e) {
    try {
      // 获取二维码
      const qrData = await ApiService.post('/sso/getqrcode', null, {
        'Content-Length': '0',
        specialEncodeParam: 'rhIMIdd/m8fRrf5i/cQFxSdQkp+WAop5GN2SMAbFTDp0QvvG7eCJQjeBuJmyv4BT3nl0BS452F2XEQawpnfZaPpjVKdoA28/waERI7lJuPmLc8RVYiQ1SQpLFbc6eGsuoVqW//856jkWy4KuZEU03reL5mGkbIx1LpRcVkKM/3k='
      })

      // 保存二维码数据
      const dirPath = path.join(PluginData, 'ScanCodeLoginData')
      fs.existsSync(dirPath) || fs.mkdirSync(dirPath, { recursive: true })
      writeJsonFile(getFilePath(e.user_id), qrData)

      // 发送二维码图片
      await e.reply(await puppeteer.screenshot('scanCodeLogin', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/scanCodeLogin.html',
        qrCodeFile: qrData.qrCodeFile
      }))

      // 等待扫码
      const scanResult = await this.waitForScan(e.user_id, qrData.uUid)
      if (!scanResult.success) {
        return await e.reply('扫码超时，请重新尝试')
      }

      // 获取用户信息并保存
      await this.saveUserInfo(e.user_id, scanResult.data)
      const message = [
        '登陆成功',
        `Token过期时间: ${this.formatDate(scanResult.data.expireTime)}`,
        '过期之后需要重新扫码登录',
        ...functionList
      ]
      await e.reply(message.join('\r'))

    } catch (error) {
      logger.error(error)
      await e.reply('操作失败，请稍后重试')
    }
  }

  async waitForScan(userId, uUid, maxRetries = 120) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const data = await ApiService.post('/sso/qrconnect', { uUid })

        if (data.statusCode === 408 && data.msg === '没扫码') {
          await common.sleep(1000)
          continue
        }

        const tokenData = await ApiService.post('/sso/code2session', {
          grantType: 'authorization_code',
          code: data.code
        }, {
          specialEncodeParam: 'bDDKzNEKn6L7257wFRD1wGRoVTNfl1kh9BnWkLaDCCeA4U4XarSrk1OptC21Zj682xDFYtfWW4Ao5uOglwReOfCvFXkwo3piug4PLll/OwXlD5aSOLn/Ucbltfw9//xJvTWB+xb9qRT3Pu1M8vm0wxX2b5OTm7SrUJ5V2jkA594='
        })

        return {
          success: true,
          data: tokenData
        }
      } catch (error) {
        logger.error(error)
      }
    }
    return { success: false }
  }

  async saveUserInfo(userId, tokenData) {
    const userInfoData = await ApiService.post('/pc/user/infolist', null, {
      ssoOpenId: tokenData.session.ssoOpenId,
      ssoToken: tokenData.session.ssoToken
    })

    const filePath = path.join(PluginData, 'UserData.yaml')
    const userData = fs.existsSync(filePath) ? readYamlFile(filePath) : {}
    userData[userId] = userInfoData.list[0].userId
    writeYamlFile(filePath, userData)

    const scanData = {
      ssoOpenId: tokenData.session.ssoOpenId,
      ssoToken: tokenData.session.ssoToken,
      expireTime: tokenData.expireTime
    }
    writeJsonFile(getFilePath(userId), scanData)
  }

  formatDate(timestamp) {
    const date = new Date(parseInt(timestamp) * 1000)
    const pad = num => String(num).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }

  async getMyTokenAndOpenId(e) {
    const filePath = getFilePath(e.user_id)
    if (!fs.existsSync(filePath)) {
      return await e.reply('未找到登录信息，请先扫码登录。')
    }

    const { ssoOpenId, ssoToken } = readJsonFile(filePath)
    if (!ssoOpenId || !ssoToken) {
      return await e.reply('未找到有效的Token或OpenId，请重新扫码登录。')
    }

    await e.reply(`您的Token: ${ssoToken}\n您的OpenId: ${ssoOpenId}`)
  }

  async bindWzryId(e) {
    const wzryId = e.msg.match(/^#绑定营地\s+(\d+)$/)[1]
    const filePath = path.join(PluginData, 'UserData.yaml')
    const userData = fs.existsSync(filePath) ? readYamlFile(filePath) : {}

    userData[e.user_id] = wzryId
    writeYamlFile(filePath, userData)
    await e.reply([
      `成功绑定您的王者ID: ${wzryId}`,
      ...functionList
    ].join('\r'))
  }
}
