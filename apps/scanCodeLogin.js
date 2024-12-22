import ApiService from '../utils/api.js'
import fs from 'fs'
import path from 'path'
import common from '../../../lib/common/common.js'
import { readJsonFile, writeJsonFile, getFilePath, writeYamlFile, readYamlFile } from '#utils'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginData } from '#components'

export class ScanCodeLogin extends plugin {
  constructor () {
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

  async scanCodeLogin (e) {
    try {
      const qrData = await ApiService.post('/sso/getqrcode', null, {
        'Content-Length': '0',
        specialEncodeParam: 'rhIMIdd/m8fRrf5i/cQFxSdQkp+WAop5GN2SMAbFTDp0QvvG7eCJQjeBuJmyv4BT3nl0BS452F2XEQawpnfZaPpjVKdoA28/waERI7lJuPmLc8RVYiQ1SQpLFbc6eGsuoVqW//856jkWy4KuZEU03reL5mGkbIx1LpRcVkKM/3k='
      })

      const { qrCodeFile } = qrData

      const dirPath = path.join(PluginData, 'ScanCodeLoginData')
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true })
      }

      writeJsonFile(getFilePath(e.user_id), qrData)

      e.reply(await puppeteer.screenshot('scanCodeLogin', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/scanCodeLogin.html',
        qrCodeFile
      }))
    } catch (error) {
      logger.error(error)
      await e.reply('获取二维码时发生错误，请稍后重试。')
      return
    }

    let loginSuccess = false
    for (let i = 0; i < 120; i++) {
      try {
        const scanCodeLoginData = readJsonFile(getFilePath(e.user_id))
        const data = await ApiService.post('/sso/qrconnect', {
          uUid: scanCodeLoginData.uUid
        })

        const { statusCode, msg, code } = data

        if (statusCode === 408 && msg === '没扫码') {
          await common.sleep(1000)
          continue
        } else {
          scanCodeLoginData.code = code
          writeJsonFile(getFilePath(e.user_id), scanCodeLoginData)

          const tokenData = await ApiService.post('/sso/code2session', {
            grantType: 'authorization_code',
            code: scanCodeLoginData.code
          }, {
            specialEncodeParam: 'bDDKzNEKn6L7257wFRD1wGRoVTNfl1kh9BnWkLaDCCeA4U4XarSrk1OptC21Zj682xDFYtfWW4Ao5uOglwReOfCvFXkwo3piug4PLll/OwXlD5aSOLn/Ucbltfw9//xJvTWB+xb9qRT3Pu1M8vm0wxX2b5OTm7SrUJ5V2jkA594='
          })

          const { ssoOpenId, ssoToken } = tokenData.session
          scanCodeLoginData.ssoOpenId = ssoOpenId
          scanCodeLoginData.ssoToken = ssoToken
          scanCodeLoginData.expireTime = tokenData.expireTime
          writeJsonFile(getFilePath(e.user_id), scanCodeLoginData)

          const userInfoData = await ApiService.post('/pc/user/infolist', null, {
            ssoOpenId,
            ssoToken
          })

          const userId = userInfoData.list[0].userId

          const filePath = path.join(PluginData, 'UserData.yaml')
          let userData = {}

          if (fs.existsSync(filePath)) {
            userData = readYamlFile(filePath)
          }

          userData[e.user_id] = userId
          writeYamlFile(filePath, userData)

          function formatDateString (dateString) {
            const date = new Date(dateString)
            const year = date.getFullYear()
            const month = ('0' + (date.getMonth() + 1)).slice(-2)
            const day = ('0' + date.getDate()).slice(-2)
            const hours = ('0' + date.getHours()).slice(-2)
            const minutes = ('0' + date.getMinutes()).slice(-2)
            const seconds = ('0' + date.getSeconds()).slice(-2)
            return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
          }

          const expireDate = formatDateString(parseInt(tokenData.expireTime) * 1000)

          await e.reply(`登录成功\rToken过期时间: ${expireDate}\r过期之后需要重新扫码登录`)
          loginSuccess = true
          break
        }
      } catch (error) {
        logger.error(error)
        continue
      }
    }

    if (!loginSuccess) {
      await e.reply('扫码超时，请重新尝试')
    }
  }

  async getMyTokenAndOpenId (e) {
    const filePath = getFilePath(e.user_id)

    if (!fs.existsSync(filePath)) {
      await e.reply('未找到登录信息，请先扫码登录。')
      return
    }

    const userData = readJsonFile(filePath)
    const { ssoOpenId, ssoToken } = userData

    if (!ssoOpenId || !ssoToken) {
      await e.reply('未找到有效的Token或OpenId，请重新扫码登录。')
      return
    }

    await e.reply(`您的Token: ${ssoToken}\n您的OpenId: ${ssoOpenId}`)
  }

  async bindWzryId (e) {
    const wzryId = e.msg.match(/^#绑定营地\s+(\d+)$/)[1]

    const filePath = path.join(PluginData, 'UserData.yaml')
    let userData = {}

    if (fs.existsSync(filePath)) {
      userData = readYamlFile(filePath)
    }

    userData[e.user_id] = wzryId
    writeYamlFile(filePath, userData)

    await e.reply(`成功绑定您的王者ID: ${wzryId}`)
  }
}
