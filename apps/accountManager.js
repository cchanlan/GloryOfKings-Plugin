import path from 'path'
import { writeYamlFile, readYamlFile } from '#utils'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginData } from '#components'

const functionList = [
  '----------',
  '可用功能：',
  '【#王者主页】查看部分王者信息',
  '【#查询战绩】查询王者战绩',
  '【#王者帮助】查看更多'
]

export class AccountManager extends plugin {
  constructor() {
    super({
      name: '王者账号管理',
      dsc: '王者账号管理',
      event: 'message',
      priority: 1,
      rule: [
        {
          reg: /^#我的(王者)?(荣耀|农药)?ID$/i,
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
  getUserData(userId) {
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
  saveUserData(filePath, userData) {
    writeYamlFile(filePath, userData)
  }

  // 新增公共方法处理HTML生成
  async generateAccountManageHTML(type, wzryId, idList, functionList) {
    return await puppeteer.screenshot('accountManage', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/accountManage.html',
      type,
      wzryId,
      idList,
      functionList,
      timestamp: new Date().toLocaleString()
    })
  }

  // 绑定ID
  async bindWzryId(e) {
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
    const html = await this.generateAccountManageHTML('绑定', wzryId, idList, [
      '【#绑定营地+ID】添加新账号',
      '【#切换营地+序号】切换账号',
      '【#删除营地+序号】删除账号',
      '【#我的ID】查看账号列表'
    ])
    await e.reply(html)
  }

  // 切换ID
  async switchWzryId(e) {
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
    const html = await this.generateAccountManageHTML('切换', userData[userId].ids[index], idList, functionList)
    await e.reply(html)
  }

  // 删除ID
  async deleteWzryId(e) {
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
    const functionList = userData[userId].ids.length ?
      ['当前剩余账号：'] :
      ['请使用【#绑定营地+ID】添加账号']

    const html = await this.generateAccountManageHTML('删除', deletedId, idList, functionList)
    await e.reply(html)
  }

  // 展示ID列表
  async myWzryId(e) {
    let userId = (e.at && e.isMaster && !e.atme) ? e.at : e.user_id
    const { userData } = this.getUserData(userId)

    if (!userData[userId]?.ids.length) {
      return e.reply(segment.image('https://raw.gitcode.com/Kevin1217/resources/files/master/resources/img/example/王者营地ID获取.png'))
    }

    const idList = this.formatIdList(userData[userId])
    await e.reply([
      segment.at(userId),
      `\n${userId}的王者ID列表：\n`,
      idList
    ])
  }

  // 格式化ID列表显示
  formatIdList(userInfo) {
    return userInfo.ids.map((id, index) => {
      const prefix = index === userInfo.current ? '✅' : '☑️'
      return `${prefix} ${index + 1}. ${id}`
    }).join('\n')
  }
}
