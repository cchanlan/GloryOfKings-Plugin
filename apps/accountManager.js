import path from 'path'
import { writeYamlFile, readYamlFile } from '#utils'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginData } from '#components'
import authStore from '../utils/authStore.js'
import {
  createWechatLoginSession,
  waitForWechatLogin
} from '../utils/wechatLogin.js'

const functionList = [
  '----------',
  '可用功能：',
  '【#王者主页】查看部分王者信息',
  '【#查询战绩】查询王者战绩',
  '【#王者帮助】查看更多'
]

const pendingWechatLoginMap = new Map()
const LOGIN_QR_RECALL_SECONDS = 175
const LOGIN_SCAN_STATUS_RECALL_SECONDS = 60

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
        },
        {
          reg: '^#营地wx登录$',
          fnc: 'wechatScanLogin'
        },
        {
          reg: '^#营地wx全局登录$',
          fnc: 'wechatGlobalScanLogin',
          permission: 'master'
        },
        {
          reg: '^#王者用户统计$',
          fnc: 'showAuthPool',
          permission: 'master'
        },
        {
          reg: '^#共享营地账号\\s*(\\d+)$',
          fnc: 'shareCampAuth',
          permission: 'master'
        },
        {
          reg: '^#取消共享营地账号\\s*(\\d+)$',
          fnc: 'unshareCampAuth',
          permission: 'master'
        },
        {
          reg: '^#清理失效营地账号$',
          fnc: 'clearInvalidCampAuth',
          permission: 'master'
        }
      ]
    })
  }

  getReplyUserId(e) {
    return (e.at && e.isMaster && !e.atme) ? e.at : e.user_id
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

  async generateAuthPoolOverviewHTML(data) {
    return await puppeteer.screenshot('authPoolOverview', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/authPoolOverview.html',
      imgType: 'png',
      ...data
    })
  }

  maskId(value, keepStart = 3, keepEnd = 3) {
    const text = String(value || '')
    if (!text) {
      return '未绑定'
    }

    if (text.length <= keepStart + keepEnd) {
      return text
    }

    return `${text.slice(0, keepStart)}***${text.slice(-keepEnd)}`
  }

  buildAuthPoolOverviewData() {
    const pool = authStore.getPool()
    const accounts = authStore.listAccounts()
    const userData = readYamlFile(path.join(PluginData, 'UserData.yaml')) || {}
    const sharedIds = new Set(pool.sharedIds)
    const boundUsers = Object.entries(userData)
      .map(([qqId, info]) => ({
        qqId: String(qqId),
        ids: Array.isArray(info?.ids) ? info.ids.map(id => String(id)) : [],
        current: Number(info?.current || 0)
      }))
      .filter(item => item.ids.length)

    const ownerMap = new Map()
    for (const boundUser of boundUsers) {
      ownerMap.set(boundUser.qqId, {
        qqId: boundUser.qqId,
        maskedQqId: this.maskId(boundUser.qqId, 3, 2),
        boundCampIds: boundUser.ids,
        maskedBoundCampIds: boundUser.ids.map(id => this.maskId(id, 3, 3)),
        currentCampId: boundUser.ids[boundUser.current] || boundUser.ids[0] || '',
        currentMaskedCampId: this.maskId(boundUser.ids[boundUser.current] || boundUser.ids[0] || '', 3, 3),
        tokens: []
      })
    }

    const unownedAccounts = []
    for (const account of accounts) {
      const ownerBotUserId = String(account.ownerBotUserId || '')
      const tokenItem = {
        campUserId: account.userId,
        maskedCampUserId: this.maskId(account.userId, 3, 3),
        nickname: account.nickname || account.userName || '未命名账号',
        statusText: account.authInvalid ? '失效' : '正常',
        statusClass: account.authInvalid ? 'invalid' : 'valid',
        sharedText: sharedIds.has(account.userId) ? '共享' : '私有',
        sourceText: account.loginPlatform || '未知来源',
        lastAuthErrorMessage: account.lastAuthErrorMessage || '',
        hasToken: Boolean(account.token)
      }

      if (ownerBotUserId) {
        if (!ownerMap.has(ownerBotUserId)) {
          ownerMap.set(ownerBotUserId, {
            qqId: ownerBotUserId,
            maskedQqId: this.maskId(ownerBotUserId, 3, 2),
            boundCampIds: [],
            maskedBoundCampIds: [],
            currentCampId: '',
            currentMaskedCampId: '未绑定',
            tokens: []
          })
        }

        ownerMap.get(ownerBotUserId).tokens.push(tokenItem)
      } else {
        unownedAccounts.push(tokenItem)
      }
    }

    const allOwnerSections = [...ownerMap.values()]
      .sort((left, right) => left.qqId.localeCompare(right.qqId))
      .map(owner => {
        const tokenMap = new Map(owner.tokens.map(item => [item.campUserId, item]))
        const mergedCampIds = [...new Set([
          ...owner.boundCampIds,
          ...owner.tokens.map(item => item.campUserId)
        ])]
        const validTokenCount = owner.tokens.filter(item => item.statusClass === 'valid').length
        const invalidTokenCount = owner.tokens.length - validTokenCount
        return {
          ...owner,
          tokenCount: owner.tokens.length,
          validTokenCount,
          invalidTokenCount,
          bindCount: owner.boundCampIds.length,
          bindText: owner.maskedBoundCampIds.length
            ? `${owner.maskedBoundCampIds.slice(0, 3).join(' / ')}${owner.maskedBoundCampIds.length > 3 ? ' / ...' : ''}`
            : '未绑定营地ID',
          uidEntries: mergedCampIds.map(campUserId => {
            const token = tokenMap.get(campUserId)
            const isCurrent = owner.currentCampId && owner.currentCampId === campUserId
            return {
              campUserId,
              maskedCampUserId: this.maskId(campUserId, 3, 3),
              isCurrent,
              badgeText: token ? 'Token' : '无',
              badgeClass: token ? token.statusClass : 'none'
            }
          })
        }
      })
    const displayedOwnerSections = allOwnerSections.slice(0, 60)
    const omittedOwnerCount = Math.max(0, allOwnerSections.length - displayedOwnerSections.length)

    const overviewCards = [
      {
        label: '绑定QQ',
        value: String(boundUsers.length),
        tone: 'blue'
      },
      {
        label: '营地ID',
        value: String(boundUsers.reduce((sum, item) => sum + item.ids.length, 0)),
        tone: 'cyan'
      },
      {
        label: '持有TokenQQ',
        value: String(allOwnerSections.filter(item => item.tokenCount > 0).length),
        tone: 'green'
      },
      {
        label: 'Token总数',
        value: String(accounts.length),
        tone: 'purple'
      },
      {
        label: '可用',
        value: String(accounts.filter(account => !account.authInvalid).length),
        tone: 'emerald'
      },
      {
        label: '失效',
        value: String(accounts.filter(account => account.authInvalid).length),
        tone: 'red'
      }
    ]

    return {
      timestamp: new Date().toLocaleString(),
      overviewCards,
      ownerSections: displayedOwnerSections,
      ownerTotalCount: allOwnerSections.length,
      omittedOwnerCount,
      unownedAccounts: unownedAccounts.map(item => ({
        ...item
      })),
      emptyState: !displayedOwnerSections.length && !unownedAccounts.length
    }
  }

  async replyBindResultCard(e, botUserId, wzryId) {
    const { filePath } = this.getUserData(botUserId)
    const nextUserData = readYamlFile(filePath) || {}
    const currentUserInfo = nextUserData[botUserId] || {
      ids: [wzryId],
      current: 0
    }

    const idList = this.formatIdList(currentUserInfo)
    const html = await this.generateAccountManageHTML('绑定', wzryId, idList, [
      '【#绑定营地+ID】添加新账号',
      '【#切换营地+序号】切换账号',
      '【#删除营地+序号】删除账号',
      '【#我的ID】查看账号列表',
      '【#营地wx登录】自动获取登录态并绑定'
    ])
    await e.reply(html)
  }

  // 绑定ID
  async bindWzryId(e) {
    let userId = this.getReplyUserId(e)
    const wzryId = e.msg.replace(/^#绑定营地\s*/, '')
    const { userData } = this.getUserData(userId)

    if (userData[userId].ids.includes(wzryId)) {
      await e.reply('该ID已经绑定过了')
      return
    }

    authStore.bindCampUserId(userId, wzryId)
    await this.replyBindResultCard(e, userId, wzryId)
  }

  // 切换ID
  async switchWzryId(e) {
    let userId = this.getReplyUserId(e)
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
    let userId = this.getReplyUserId(e)
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
    let userId = this.getReplyUserId(e)
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

  getPendingWechatLogin(botUserId) {
    return pendingWechatLoginMap.get(botUserId) || null
  }

  clearPendingWechatLogin(botUserId) {
    const pending = this.getPendingWechatLogin(botUserId)
    if (pending?.recallTimer) {
      clearTimeout(pending.recallTimer)
    }
    if (pending?.scanStatusRecallTimer) {
      clearTimeout(pending.scanStatusRecallTimer)
    }
    pendingWechatLoginMap.delete(botUserId)
    return pending
  }

  async recallReplyMessage(e, messageId) {
    if (!messageId) {
      return false
    }

    try {
      let recall = null
      if (e.group?.recallMsg) recall = e.group.recallMsg.bind(e.group)
      else if (e.friend?.recallMsg) recall = e.friend.recallMsg.bind(e.friend)
      else if (e.bot?.recallMsg) recall = e.bot.recallMsg.bind(e.bot)
      else return false

      await recall(messageId)
      return true
    } catch (error) {
      logger.warn(`[营地登录] 撤回二维码消息失败: ${error.message}`)
      return false
    }
  }

  async recallWechatLoginMessages(e, pending) {
    if (!pending) {
      return
    }

    await this.recallReplyMessage(e, pending.qrMessageId)
    await this.recallReplyMessage(e, pending.scanStatusMessageId)
    pending.qrMessageId = ''
    pending.scanStatusMessageId = ''
    pending.scanStatusRecallTimer = null
  }

  async handleWechatLoginStatusChange(e, botUserId, taskId, status = {}) {
    const pending = this.getPendingWechatLogin(botUserId)
    if (!pending || pending.taskId !== taskId) {
      return
    }

    if (status.statusCode === 404) {
      pending.hasScanned = true

      if (!pending.scanStatusMessageId) {
        const scanReply = await e.reply('已扫码，请在手机上确认营地登录。若长时间未确认，本次登录会自动超时。')
        pending.scanStatusMessageId = scanReply?.message_id || ''
        pending.scanStatusRecallTimer = setTimeout(() => {
          void this.recallReplyMessage(e, pending.scanStatusMessageId)
            .finally(() => {
              pending.scanStatusMessageId = ''
            })
        }, LOGIN_SCAN_STATUS_RECALL_SECONDS * 1000)
      }
    }
  }

  async startWechatLogin(e, botUserId, options = {}) {
    if (this.getPendingWechatLogin(botUserId)) {
      await e.reply('当前已有一个营地登录任务在进行中，请先完成当前二维码或稍后再试')
      return true
    }

    const {
      mode = 'personal',
      qrPromptLines = []
    } = options

    let session
    try {
      session = await createWechatLoginSession()
    } catch (error) {
      logger.error(`[营地登录] 生成二维码失败: ${error.message}`)
      await e.reply(`生成营地登录二维码失败：${error.message}`)
      return true
    }

    const taskId = `${botUserId}:${mode}:${Date.now()}`
    const qrReply = await e.reply([
      ...qrPromptLines,
      '\n',
      segment.image(`base64://${session.qrcodeBuffer.toString('base64')}`)
    ])

    const pendingInfo = {
      taskId,
      mode,
      qrMessageId: qrReply?.message_id || '',
      scanStatusMessageId: '',
      hasScanned: false,
      scanStatusRecallTimer: null,
      recallTimer: setTimeout(() => {
        void this.recallReplyMessage(e, pendingInfo.qrMessageId)
          .finally(() => {
            pendingInfo.qrMessageId = ''
          })
      }, LOGIN_QR_RECALL_SECONDS * 1000)
    }
    pendingWechatLoginMap.set(botUserId, pendingInfo)

    void this.waitForWechatLoginResult(e, botUserId, taskId, session, mode)
    return true
  }

  async wechatScanLogin(e) {
    const botUserId = this.getReplyUserId(e)
    return this.startWechatLogin(e, botUserId, {
      mode: 'personal',
      qrPromptLines: [
      `请扫描二维码完成营地登录，二维码 3 分钟内有效，将在 ${LOGIN_QR_RECALL_SECONDS} 秒后自动撤回。`,
      '\n登录成功后会自动保存登录态，并把返回的营地 userId 绑定为当前默认 ID。',
      '\n如果你之后希望把这个账号加入公用池，可由主人使用【#共享营地账号 营地ID】开启共享。'
      ]
    })
  }

  async wechatGlobalScanLogin(e) {
    const botUserId = e.user_id
    return this.startWechatLogin(e, botUserId, {
      mode: 'global',
      qrPromptLines: [
        `请扫描二维码完成营地全局登录，二维码 3 分钟内有效，将在 ${LOGIN_QR_RECALL_SECONDS} 秒后自动撤回。`,
        '\n登录成功后会直接更新默认全局账号的 token 和鉴权信息。'
      ]
    })
  }

  async finishPersonalWechatLogin(e, botUserId, result) {
    const account = authStore.upsertAccount({
      ...result.account,
      ownerBotUserId: botUserId,
      resetAuthState: true
    })
    authStore.bindCampUserId(botUserId, account.userId)

    logger.debug('[营地登录] 登录态写入完成', {
      botUserId,
      campUserId: account.userId,
      loginPlatform: account.loginPlatform,
      nickname: account.nickname || account.userName || '',
      shared: account.shared
    })

    await this.replyBindResultCard(e, botUserId, account.userId)
  }

  async finishGlobalWechatLogin(e, result) {
    const account = result.account || {}
    const savedAccount = authStore.upsertGlobalAccount(account)

    logger.info('[营地全局账号] 已通过扫码更新默认全局账号', {
      userId: savedAccount.userId,
      nickname: savedAccount.nickname || savedAccount.userName || ''
    })

    await e.reply([
      '默认全局账号已更新。',
      `\n营地ID：${savedAccount.userId || '未获取'}`,
      `\n昵称：${savedAccount.nickname || savedAccount.userName || '未命名'}`
    ])
  }

  async waitForWechatLoginResult(e, botUserId, taskId, session, mode = 'personal') {
    const pending = this.getPendingWechatLogin(botUserId)
    try {
      const result = await waitForWechatLogin(session, {
        onStatusChange: (status) => {
          void this.handleWechatLoginStatusChange(e, botUserId, taskId, status)
        }
      })
      if (this.getPendingWechatLogin(botUserId)?.taskId !== taskId) {
        return
      }

      await this.recallWechatLoginMessages(e, pending)

      if (mode === 'global') {
        await this.finishGlobalWechatLogin(e, result)
      } else {
        await this.finishPersonalWechatLogin(e, botUserId, result)
      }
    } catch (error) {
      if (this.getPendingWechatLogin(botUserId)?.taskId !== taskId) {
        return
      }

      await this.recallWechatLoginMessages(e, pending)
      logger.error(`[营地登录] 登录流程失败: ${error.message}`)

      if (error.code === 'QR_EXPIRED') {
        await e.reply('营地登录二维码已过期，请重新发起')
      } else if (error.code === 'QR_CANCELED') {
        await e.reply('营地登录已取消，请重新发起')
      } else if (error.code === 'QR_TIMEOUT') {
        if (pending?.hasScanned) {
          await e.reply('已扫码，但长时间未确认，营地登录已超时，请重新发起')
        } else {
          await e.reply('营地登录等待超时，请重新发起')
        }
      } else {
        await e.reply(`营地登录失败：${error.message}`)
      }
    } finally {
      if (this.getPendingWechatLogin(botUserId)?.taskId === taskId) {
        this.clearPendingWechatLogin(botUserId)
      }
    }
  }

  async showAuthPool(e) {
    const overviewData = this.buildAuthPoolOverviewData()

    try {
      const img = await this.generateAuthPoolOverviewHTML(overviewData)
      await e.reply(img)
    } catch (error) {
      logger.error(`[王者用户统计] 渲染统计面板失败: ${error.message}`)
      await e.reply([
        '用户统计面板渲染失败，已回退为文本摘要。',
        `\n绑定营地ID的QQ：${overviewData.overviewCards[0]?.value || 0}`,
        `\n已绑定营地ID总数：${overviewData.overviewCards[1]?.value || 0}`,
        `\n拥有登录态的QQ：${overviewData.overviewCards[2]?.value || 0}`,
        `\n账号池登录态总数：${overviewData.overviewCards[3]?.value || 0}`,
        `\n可用登录态：${overviewData.overviewCards[4]?.value || 0}`,
        `\n失效登录态：${overviewData.overviewCards[5]?.value || 0}`
      ])
    }
    return true
  }

  async shareCampAuth(e) {
    const campUserId = e.msg.replace(/^#共享营地账号\s*/, '').trim()

    try {
      const account = authStore.setShared(campUserId, true)
      await e.reply(`已将营地账号 ${account.userId} 加入共享账号池，当前状态：${account.authInvalid ? '失效' : '正常'}`)
    } catch (error) {
      await e.reply(error.message)
    }
    return true
  }

  async unshareCampAuth(e) {
    const campUserId = e.msg.replace(/^#取消共享营地账号\s*/, '').trim()

    try {
      const account = authStore.setShared(campUserId, false)
      await e.reply(`已将营地账号 ${account.userId} 从共享账号池移除，当前状态：${account.authInvalid ? '失效' : '正常'}`)
    } catch (error) {
      await e.reply(error.message)
    }
    return true
  }

  async clearInvalidCampAuth(e) {
    const {
      removedAccounts = [],
      skippedGlobalAccounts = []
    } = authStore.clearInvalidAccounts()

    if (!removedAccounts.length && !skippedGlobalAccounts.length) {
      await e.reply('当前没有已标记失效的营地登录态，无需清理')
      return true
    }

    const lines = []
    if (removedAccounts.length) {
      lines.push(`已清理 ${removedAccounts.length} 个失效营地登录态。`)
      lines.push('这些账号只会从本地账号池移除，不会删除用户已绑定的营地ID：')
      lines.push(...removedAccounts.map((account, index) => {
        const nickname = account.nickname || '未命名'
        const ownerText = account.ownerBotUserId ? ` owner:${account.ownerBotUserId}` : ''
        const sharedText = account.shared ? '共享' : '私有'
        return `${index + 1}. [${sharedText}] ${account.userId} ${nickname}${ownerText}`
      }))
    }

    if (skippedGlobalAccounts.length) {
      lines.push(
        removedAccounts.length ? '' : '本次未删除任何账号。',
        `已跳过 ${skippedGlobalAccounts.length} 个失效的默认全局账号，失效标记会保留，后续可通过【#营地wx全局登录】或锅巴更新后恢复。`
      )
    }

    await e.reply(lines.filter(Boolean).join('\n'))
    return true
  }
}
