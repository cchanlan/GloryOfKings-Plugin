import ApiService from '../utils/api.js'
import fs from 'fs'
import path from 'path'
import common from '../../../lib/common/common.js'
import { writeJsonFile, getFilePath, writeYamlFile, readYamlFile } from '#utils'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginData } from '#components'

const functionList = [
  '----------',
  '可用功能：',
  '【#王者主页】查看部分王者信息',
  '【#查询战绩】查询王者战绩',
  '【#王者帮助】查看更多'
]

const CONFIG = {
  MAX_SCAN_RETRIES: 120,
  SCAN_INTERVAL: 1000,
  QR_ENCODE_PARAM: 'rhIMIdd/m8fRrf5i/cQFxSdQkp+WAop5GN2SMAbFTDp0QvvG7eCJQjeBuJmyv4BT3nl0BS452F2XEQawpnfZaPpjVKdoA28/waERI7lJuPmLc8RVYiQ1SQpLFbc6eGsuoVqW//856jkWy4KuZEU03reL5mGkbIx1LpRcVkKM/3k=',
  TOKEN_ENCODE_PARAM: 'bDDKzNEKn6L7257wFRD1wGRoVTNfl1kh9BnWkLaDCCeA4U4XarSrk1OptC21Zj682xDFYtfWW4Ao5uOglwReOfCvFXkwo3piug4PLll/OwXlD5aSOLn/Ucbltfw9//xJvTWB+xb9qRT3Pu1M8vm0wxX2b5OTm7SrUJ5V2jkA594='
}

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
          reg: /^#我的ID$/,
          fnc: 'myWzryId'
        },
        {
          reg: '^#绑定营地\\s*(.*)$',
          fnc: 'bindWzryId'
        },
        {
          reg: '^#切换营地\\s*(.*)$',
          fnc: 'switchWzryId'
        },
        {
          reg: '^#删除营地\\s*(.*)$',
          fnc: 'deleteWzryId'
        }
      ]
    })
  }

  // 获取用户数据
  getUserData (userId) {
    const filePath = path.join(PluginData, 'UserData.yaml')
    const userData = readYamlFile(filePath) || {}

    if (!userData[userId]) {
      userData[userId] = {
        ids: [],
        current: 0
      }
    }

    return { userData, filePath }
  }

  // 保存用户数据
  saveUserData (filePath, userData) {
    writeYamlFile(filePath, userData)
  }

  // 绑定ID
  async bindWzryId (e) {
    let userId = (e.at && e.isMaster && !e.atme) ? e.at : e.user_id
    const wzryId = e.msg.replace(/^#绑定营地\s*/, '')
    const { userData, filePath } = this.getUserData(userId)

    if (userData[userId].ids.includes(wzryId)) {
      await e.reply('该ID已经绑定过了')
      return
    }

    userData[userId].ids.push(wzryId)
    if (userData[userId].ids.length === 1) {
      userData[userId].current = 0
    }

    this.saveUserData(filePath, userData)

    const idList = this.formatIdList(userData[userId])
    await e.reply([
      `成功绑定王者ID: ${wzryId}`,
      '当前绑定的ID列表：',
      idList,
      ...functionList
    ].join('\n'))
  }

  // 切换ID
  async switchWzryId (e) {
    let userId = (e.at && e.isMaster && !e.atme) ? e.at : e.user_id
    const index = parseInt(e.msg.replace(/^#切换营地\s*/, '')) - 1
    const { userData, filePath } = this.getUserData(userId)

    if (!userData[userId].ids.length) {
      await e.reply('您还没有绑定任何ID，请先绑定')
      return
    }

    if (index < 0 || index >= userData[userId].ids.length) {
      await e.reply('序号无效，请输入正确的序号')
      return
    }

    userData[userId].current = index
    this.saveUserData(filePath, userData)

    const idList = this.formatIdList(userData[userId])
    await e.reply([
      `已切换到ID: ${userData[userId].ids[index]}`,
      '当前绑定的ID列表：',
      idList
    ].join('\n'))
  }

  // 删除ID
  async deleteWzryId (e) {
    let userId = (e.at && e.isMaster && !e.atme) ? e.at : e.user_id
    const index = parseInt(e.msg.replace(/^#删除营地\s*/, '')) - 1
    const { userData, filePath } = this.getUserData(userId)

    if (!userData[userId].ids.length) {
      await e.reply('您还没有绑定任何ID')
      return
    }

    if (index < 0 || index >= userData[userId].ids.length) {
      await e.reply('序号无效，请输入正确的序号')
      return
    }

    const deletedId = userData[userId].ids[index]
    userData[userId].ids.splice(index, 1)

    // 调整current索引
    if (userData[userId].current >= userData[userId].ids.length) {
      userData[userId].current = Math.max(0, userData[userId].ids.length - 1)
    }

    this.saveUserData(filePath, userData)

    const idList = this.formatIdList(userData[userId])
    await e.reply([
      `已删除ID: ${deletedId}`,
      userData[userId].ids.length ? '当前绑定的ID列表：\n' + idList : '已删除所有绑定的ID'
    ].join('\n'))
  }

  // 展示ID列表
  async myWzryId (e) {
    let userId = (e.at && e.isMaster && !e.atme) ? e.at : e.user_id
    const { userData } = this.getUserData(userId)

    if (!userData[userId]?.ids.length) {
      return e.reply(segment.image('https://gitee.com/Tloml-Starry/resources/raw/master/resources/img/example/王者营地ID获取.png'))
    }

    const idList = this.formatIdList(userData[userId])
    await e.reply([
      segment.at(userId),
      `${userId}的王者ID列表：`,
      idList
    ].join('\n'))
  }

  // 格式化ID列表显示
  formatIdList (userInfo) {
    return userInfo.ids.map((id, index) => {
      const prefix = index === userInfo.current ? '✅' : '☑️'
      return `${prefix} ${index + 1}. ${id}`
    }).join('\n')
  }

  async scanCodeLogin (e) {
    try {
      const dirPath = path.join(PluginData, 'ScanCodeLoginData')
      await fs.promises.mkdir(dirPath, { recursive: true })

      const qrData = await ApiService.post('/sso/getqrcode', null, {
        'Content-Length': '0',
        specialEncodeParam: CONFIG.QR_ENCODE_PARAM
      })

      writeJsonFile(getFilePath(e.user_id), qrData)

      const qrImage = await puppeteer.screenshot('scanCodeLogin', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/scanCodeLogin.html',
        qrCodeFile: qrData.qrCodeFile
      })
      await e.reply(qrImage)

      const scanResult = await this.waitForScan(e.user_id, qrData.uUid)
      if (!scanResult.success) {
        return await e.reply('扫码超时，请重新尝试')
      }

      await this.saveUserInfo(e.user_id, scanResult.data)
      await e.reply([
        '登陆成功',
        `Token过期时间: ${this.formatDate(scanResult.data.expireTime)}`,
        '过期之后需要重新扫码登录',
        ...functionList
      ].join('\n'))
    } catch (error) {
      logger.error('扫码登录失败:', error)
      await e.reply('操作失败，请稍后重试')
    }
  }

  async waitForScan (userId, uUid) {
    for (let i = 0; i < CONFIG.MAX_SCAN_RETRIES; i++) {
      try {
        const scanData = await ApiService.post('/sso/qrconnect', { uUid })

        if (scanData.statusCode === 408 && scanData.msg === '没扫码') {
          await common.sleep(CONFIG.SCAN_INTERVAL)
          continue
        }

        const tokenData = await ApiService.post('/sso/code2session', {
          grantType: 'authorization_code',
          code: scanData.code
        }, {
          specialEncodeParam: CONFIG.TOKEN_ENCODE_PARAM
        })

        return { success: true, data: tokenData }
      } catch (error) {
        logger.error('等待扫码出错:', error)
      }
    }
    return { success: false }
  }

  async saveUserInfo (userId, tokenData) {
    const { ssoOpenId, ssoToken } = tokenData.session

    const userInfoData = await ApiService.post('/pc/user/infolist', null, {
      ssoOpenId,
      ssoToken
    })

    // 获取用户ID
    const wzryId = userInfoData.list[0].userId

    // 读取用户数据
    const filePath = path.join(PluginData, 'UserData.yaml')
    const userData = readYamlFile(filePath) || {}

    // 初始化用户数据结构
    if (!userData[userId]) {
      userData[userId] = {
        ids: [],
        current: 0
      }
    }

    // 如果ID不存在则添加到列表中
    if (!userData[userId].ids.includes(wzryId)) {
      userData[userId].ids.push(wzryId)
      userData[userId].current = userData[userId].ids.length - 1
    }

    // 保存用户数据
    writeYamlFile(filePath, userData)

    // 保存登录凭证
    writeJsonFile(getFilePath(userId), {
      ssoOpenId,
      ssoToken,
      expireTime: tokenData.expireTime
    })
  }

  formatDate (timestamp) {
    const date = new Date(parseInt(timestamp) * 1000)
    const pad = num => String(num).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  }
}
