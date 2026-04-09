import fs from 'node:fs'
import path from 'node:path'
import { Config, PluginData } from '#components'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'

const AUTH_POOL_FILE = path.join(PluginData, 'AuthPool.json')
const LEGACY_AUTH_POOL_FILE = path.join(PluginData, 'AuthPool.yaml')
const LEGACY_AUTH_STATE_FILE = path.join(PluginData, 'LegacyAuthState.json')
const USER_DATA_FILE = path.join(PluginData, 'UserData.yaml')

const LEGACY_AUTH_CONFIG_KEYS = [
  'userId',
  'token',
  'userKey',
  'encodeRes',
  'openId',
  'gameOpenId',
  'gameRoleId',
  'gameServerId',
  'xLogUid',
  'traceparent'
]

function ensureDirectory(filePath) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function normalizeUserId(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return ''
  }

  return String(value)
}

function toStringValue(value) {
  if (value === null || typeof value === 'undefined') {
    return ''
  }

  return String(value)
}

function readJsonSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      return structuredClone(fallback)
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return structuredClone(fallback)
  }
}

function writeJsonPretty(filePath, data) {
  ensureDirectory(filePath)
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function readYamlSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      return structuredClone(fallback)
    }

    return readYamlFile(filePath) ?? structuredClone(fallback)
  } catch {
    return structuredClone(fallback)
  }
}

function isUsableAuth(auth) {
  return Boolean(auth?.token && auth?.userId && (auth?.userKey || auth?.encodeRes))
}

function toNumberValue(value, fallback = 0) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function maskValue(value, keepStart = 6, keepEnd = 4) {
  const text = toStringValue(value)
  if (!text) {
    return ''
  }

  if (text.length <= keepStart + keepEnd) {
    return text
  }

  return `${text.slice(0, keepStart)}...${text.slice(-keepEnd)}`
}

class AuthStore {
  #getDefaultPool() {
    return {
      accounts: {},
      sharedIds: []
    }
  }

  #getDefaultUserData() {
    return {}
  }

  #getDefaultLegacyAuthState() {
    return {
      fingerprint: '',
      authInvalid: false,
      authErrorCount: 0,
      lastAuthErrorAt: '',
      lastAuthErrorMessage: '',
      lastSuccessAt: ''
    }
  }

  #normalizeLegacyAuthState(state = {}) {
    return {
      ...this.#getDefaultLegacyAuthState(),
      ...state,
      fingerprint: toStringValue(state.fingerprint),
      authInvalid: Boolean(state.authInvalid),
      authErrorCount: Number(state.authErrorCount || 0),
      lastAuthErrorAt: toStringValue(state.lastAuthErrorAt),
      lastAuthErrorMessage: toStringValue(state.lastAuthErrorMessage),
      lastSuccessAt: toStringValue(state.lastSuccessAt)
    }
  }

  #getLegacyAuthState() {
    return this.#normalizeLegacyAuthState(
      readJsonSafe(LEGACY_AUTH_STATE_FILE, this.#getDefaultLegacyAuthState())
    )
  }

  #saveLegacyAuthState(state) {
    writeJsonPretty(LEGACY_AUTH_STATE_FILE, this.#normalizeLegacyAuthState(state))
  }

  #getLegacyAuthFromConfig() {
    const auth = Config.getDefOrConfig('auth') || {}
    return {
      token: toStringValue(auth.token),
      userId: normalizeUserId(auth.userId),
      userKey: toStringValue(auth.userKey),
      encodeRes: toStringValue(auth.encodeRes),
      openId: toStringValue(auth.openId),
      gameOpenId: toStringValue(auth.gameOpenId),
      gameRoleId: toStringValue(auth.gameRoleId),
      gameServerId: toStringValue(auth.gameServerId),
      gameAreaId: toStringValue(auth.gameAreaId),
      gameUserSex: toStringValue(auth.gameUserSex),
      kohDimGender: toStringValue(auth.kohDimGender),
      xLogUid: toStringValue(auth.xLogUid),
      traceparent: toStringValue(auth.traceparent)
    }
  }

  #clearLegacyAuthConfig() {
    for (const key of LEGACY_AUTH_CONFIG_KEYS) {
      Config.modify('auth', key, '')
    }
  }

  #sortAccountsByPriority(accounts = []) {
    return [...accounts].sort((left, right) => {
      const globalCompare = Number(Boolean(right.isGlobalDefault)) - Number(Boolean(left.isGlobalDefault))
      if (globalCompare !== 0) {
        return globalCompare
      }

      const priorityCompare = Number(left.priority || 0) - Number(right.priority || 0)
      if (priorityCompare !== 0) {
        return priorityCompare
      }

      return String(left.userId).localeCompare(String(right.userId))
    })
  }

  #migrateLegacyGlobalAuthIfNeeded() {
    const legacyAuth = this.#getLegacyAuthFromConfig()
    if (!isUsableAuth(legacyAuth)) {
      return
    }

    const pool = this.#normalizePool(readJsonSafe(AUTH_POOL_FILE, this.#getDefaultPool()))
    const existingGlobalAccount = Object.values(pool.accounts).find(account => account.isGlobalDefault)
    if (existingGlobalAccount && normalizeUserId(existingGlobalAccount.userId) !== legacyAuth.userId) {
      this.#clearLegacyAuthConfig()
      logger.warn('[营地全局账号] 检测到旧 auth.yaml 全局配置，但账号池中已存在新的全局账号，已跳过旧配置迁移', {
        legacyUserId: legacyAuth.userId,
        currentGlobalUserId: existingGlobalAccount.userId
      })
      return
    }

    const existing = pool.accounts[legacyAuth.userId] || {}
    const legacyState = this.#getLegacyAuthState()
    const next = this.#normalizeAccount({
      ...existing,
      ...legacyAuth,
      userId: legacyAuth.userId,
      isGlobalDefault: true,
      shared: false,
      ownerBotUserId: normalizeUserId(existing.ownerBotUserId),
      loginPlatform: existing.loginPlatform || 'legacy',
      authInvalid: Boolean(existing.authInvalid || legacyState.authInvalid),
      authErrorCount: Number(existing.authErrorCount || legacyState.authErrorCount || 0),
      lastAuthErrorAt: existing.lastAuthErrorAt || legacyState.lastAuthErrorAt || '',
      lastAuthErrorMessage: existing.lastAuthErrorMessage || legacyState.lastAuthErrorMessage || '',
      lastSuccessAt: existing.lastSuccessAt || legacyState.lastSuccessAt || '',
      priority: Number(existing.priority || 0)
    }, existing)

    for (const account of Object.values(pool.accounts)) {
      account.isGlobalDefault = normalizeUserId(account.userId) === next.userId
    }

    pool.accounts[next.userId] = next
    pool.sharedIds = pool.sharedIds.filter(id => id && id !== next.userId && pool.accounts[id])
    this.#savePool(pool)
    this.#clearLegacyAuthConfig()

    logger.info('[营地全局账号] 已将 auth.yaml 旧全局配置迁移到 AuthPool.json', {
      userId: next.userId,
      authInvalid: next.authInvalid
    })
  }

  #normalizeAccount(account = {}, existing = {}) {
    const userId = normalizeUserId(account.userId || existing.userId)
    const timestamp = new Date().toISOString()
    const shared = typeof account.shared === 'boolean'
      ? account.shared
      : Boolean(existing.shared)
    const isGlobalDefault = typeof account.isGlobalDefault === 'boolean'
      ? account.isGlobalDefault
      : Boolean(existing.isGlobalDefault)
    const authInvalid = typeof account.authInvalid === 'boolean'
      ? account.authInvalid
      : Boolean(existing.authInvalid)
    const authErrorCount = Number(account.authErrorCount ?? existing.authErrorCount ?? 0)
    const priority = toNumberValue(account.priority ?? existing.priority ?? 100, 100)

    return {
      ...existing,
      ...account,
      userId,
      token: toStringValue(account.token ?? existing.token),
      userKey: toStringValue(account.userKey ?? existing.userKey),
      encodeRes: toStringValue(account.encodeRes ?? existing.encodeRes),
      openId: toStringValue(account.openId ?? existing.openId),
      gameOpenId: toStringValue(account.gameOpenId ?? existing.gameOpenId),
      gameRoleId: toStringValue(account.gameRoleId ?? existing.gameRoleId),
      gameServerId: toStringValue(account.gameServerId ?? existing.gameServerId),
      gameAreaId: toStringValue(account.gameAreaId ?? existing.gameAreaId),
      gameUserSex: toStringValue(account.gameUserSex ?? existing.gameUserSex),
      kohDimGender: toStringValue(account.kohDimGender ?? existing.kohDimGender),
      xLogUid: toStringValue(account.xLogUid ?? existing.xLogUid),
      traceparent: toStringValue(account.traceparent ?? existing.traceparent),
      accessToken: toStringValue(account.accessToken ?? existing.accessToken),
      refreshToken: toStringValue(account.refreshToken ?? existing.refreshToken),
      appOpenid: toStringValue(account.appOpenid ?? existing.appOpenid),
      avatar: toStringValue(account.avatar ?? existing.avatar),
      bigAvatar: toStringValue(account.bigAvatar ?? existing.bigAvatar),
      icon: toStringValue(account.icon ?? existing.icon),
      nickname: toStringValue(account.nickname ?? existing.nickname),
      snsnickname: toStringValue(account.snsnickname ?? existing.snsnickname),
      userName: toStringValue(account.userName ?? existing.userName),
      sex: toStringValue(account.sex ?? existing.sex),
      expires: toStringValue(account.expires ?? existing.expires),
      uin: toStringValue(account.uin ?? existing.uin),
      userSig: toStringValue(account.userSig ?? existing.userSig),
      realRegisterTime: toStringValue(account.realRegisterTime ?? existing.realRegisterTime),
      ownerBotUserId: normalizeUserId(account.ownerBotUserId || existing.ownerBotUserId),
      loginPlatform: toStringValue(account.loginPlatform ?? existing.loginPlatform),
      remark: toStringValue(account.remark ?? existing.remark),
      shared: isGlobalDefault ? false : shared,
      isGlobalDefault,
      priority,
      authInvalid,
      authErrorCount,
      lastAuthErrorAt: toStringValue(account.lastAuthErrorAt ?? existing.lastAuthErrorAt),
      lastAuthErrorMessage: toStringValue(account.lastAuthErrorMessage ?? existing.lastAuthErrorMessage),
      lastSuccessAt: toStringValue(account.lastSuccessAt ?? existing.lastSuccessAt),
      createdAt: existing.createdAt || timestamp,
      updatedAt: timestamp,
      lastLoginAt: toStringValue(account.lastLoginAt ?? existing.lastLoginAt ?? timestamp)
    }
  }

  #normalizePool(pool = {}) {
    const sourceAccounts = pool.accounts && typeof pool.accounts === 'object' ? pool.accounts : {}
    const accounts = {}

    for (const [userId, account] of Object.entries(sourceAccounts)) {
      const normalizedUserId = normalizeUserId(userId || account?.userId)
      if (!normalizedUserId) {
        continue
      }

      accounts[normalizedUserId] = this.#normalizeAccount({
        ...account,
        userId: normalizedUserId
      })
    }

    const sharedIds = Array.isArray(pool.sharedIds)
      ? [...new Set(pool.sharedIds.map(normalizeUserId).filter(id => id && accounts[id]))]
      : []

    return {
      accounts,
      sharedIds
    }
  }

  #savePool(pool) {
    writeJsonPretty(AUTH_POOL_FILE, this.#normalizePool(pool))
  }

  #saveUserData(userData) {
    ensureDirectory(USER_DATA_FILE)
    writeYamlFile(USER_DATA_FILE, userData)
  }

  #migrateLegacyPoolIfNeeded() {
    if (fs.existsSync(AUTH_POOL_FILE) || !fs.existsSync(LEGACY_AUTH_POOL_FILE)) {
      return
    }

    const legacyPool = readYamlSafe(LEGACY_AUTH_POOL_FILE, this.#getDefaultPool())
    this.#savePool(legacyPool)
  }

  getPool() {
    this.#migrateLegacyPoolIfNeeded()
    this.#migrateLegacyGlobalAuthIfNeeded()
    return this.#normalizePool(readJsonSafe(AUTH_POOL_FILE, this.#getDefaultPool()))
  }

  getAccount(userId) {
    const normalizedUserId = normalizeUserId(userId)
    if (!normalizedUserId) {
      return null
    }

    return this.getPool().accounts[normalizedUserId] || null
  }

  listAccounts() {
    return this.#sortAccountsByPriority(Object.values(this.getPool().accounts))
  }

  upsertAccount(account) {
    const userId = normalizeUserId(account.userId)
    if (!userId) {
      throw new Error('缺少营地 userId，无法保存登录态')
    }

    const pool = this.getPool()
    const existing = pool.accounts[userId] || {}
    const next = this.#normalizeAccount({
      ...account,
      userId
    }, existing)

    if (account.resetAuthState) {
      next.authInvalid = false
      next.authErrorCount = 0
      next.lastAuthErrorAt = ''
      next.lastAuthErrorMessage = ''
    }

    pool.accounts[userId] = next

    if (next.isGlobalDefault) {
      for (const [accountUserId, accountItem] of Object.entries(pool.accounts)) {
        if (accountUserId === userId) {
          continue
        }

        if (accountItem.isGlobalDefault) {
          pool.accounts[accountUserId] = this.#normalizeAccount({
            ...accountItem,
            isGlobalDefault: false
          }, accountItem)
        }
      }
    }

    if (next.shared) {
      if (!pool.sharedIds.includes(userId)) {
        pool.sharedIds.push(userId)
      }
    } else {
      pool.sharedIds = pool.sharedIds.filter(id => id !== userId)
    }

    this.#savePool(pool)
    logger.debug('[营地账号池] 已保存账号登录态', {
      userId: next.userId,
      ownerBotUserId: next.ownerBotUserId,
      loginPlatform: next.loginPlatform,
      isGlobalDefault: next.isGlobalDefault,
      priority: next.priority,
      shared: next.shared,
      token: maskValue(next.token),
      userKey: maskValue(next.userKey),
      encodeRes: maskValue(next.encodeRes),
      appOpenid: maskValue(next.appOpenid),
      openId: maskValue(next.openId),
      gameOpenId: maskValue(next.gameOpenId),
      gameRoleId: next.gameRoleId,
      gameServerId: next.gameServerId,
      gameAreaId: next.gameAreaId,
      gameUserSex: next.gameUserSex,
      kohDimGender: next.kohDimGender,
      nickname: next.nickname || next.userName || ''
    })
    return next
  }

  markAuthFailure(userId, message = '') {
    const normalizedUserId = normalizeUserId(userId)
    if (!normalizedUserId) {
      return null
    }

    const pool = this.getPool()
    const account = pool.accounts[normalizedUserId]
    if (!account) {
      return null
    }

    const next = this.#normalizeAccount({
      ...account,
      authInvalid: true,
      authErrorCount: Number(account.authErrorCount || 0) + 1,
      lastAuthErrorAt: new Date().toISOString(),
      lastAuthErrorMessage: toStringValue(message)
    }, account)

    pool.accounts[normalizedUserId] = next
    this.#savePool(pool)
    logger.warn('[营地账号池] 已标记账号登录态失效', {
      userId: next.userId,
      ownerBotUserId: next.ownerBotUserId,
      isGlobalDefault: next.isGlobalDefault,
      shared: next.shared,
      authErrorCount: next.authErrorCount,
      lastAuthErrorMessage: next.lastAuthErrorMessage
    })
    return {
      ...next,
      newlyInvalid: !Boolean(account.authInvalid)
    }
  }

  markAuthSuccess(userId) {
    const normalizedUserId = normalizeUserId(userId)
    if (!normalizedUserId) {
      return null
    }

    const pool = this.getPool()
    const account = pool.accounts[normalizedUserId]
    if (!account) {
      return null
    }

    const next = this.#normalizeAccount({
      ...account,
      authInvalid: false,
      authErrorCount: 0,
      lastAuthErrorAt: '',
      lastAuthErrorMessage: '',
      lastSuccessAt: new Date().toISOString()
    }, account)

    pool.accounts[normalizedUserId] = next
    this.#savePool(pool)
    return next
  }

  setGlobalAccount(userId = '') {
    const normalizedUserId = normalizeUserId(userId)
    const pool = this.getPool()
    let found = !normalizedUserId

    for (const [accountUserId, account] of Object.entries(pool.accounts)) {
      const shouldBeGlobal = normalizedUserId && accountUserId === normalizedUserId
      if (shouldBeGlobal) {
        found = true
      }

      if (Boolean(account.isGlobalDefault) === Boolean(shouldBeGlobal)) {
        continue
      }

      pool.accounts[accountUserId] = this.#normalizeAccount({
        ...account,
        isGlobalDefault: shouldBeGlobal,
        shared: shouldBeGlobal ? false : account.shared
      }, account)
    }

    if (!found) {
      throw new Error(`账号池中不存在营地账号 ${normalizedUserId}`)
    }

    pool.sharedIds = pool.sharedIds.filter(id => pool.accounts[id] && !pool.accounts[id].isGlobalDefault)
    this.#savePool(pool)
    return normalizedUserId
  }

  getGlobalAccount() {
    const globals = this.#sortAccountsByPriority(
      this.listAccounts().filter(account => account.isGlobalDefault)
    )

    return globals[0] || null
  }

  getGlobalAccountId() {
    return this.getGlobalAccount()?.userId || ''
  }

  upsertGlobalAccount(account = {}) {
    const next = this.upsertAccount({
      ...account,
      isGlobalDefault: true,
      shared: false,
      resetAuthState: true
    })

    this.#clearLegacyAuthConfig()

    logger.info('[营地全局账号] 已更新默认全局账号配置', {
      userId: next.userId,
      token: maskValue(next.token),
      userKey: maskValue(next.userKey),
      encodeRes: maskValue(next.encodeRes)
    })

    return next
  }

  removeAccount(userId) {
    const normalizedUserId = normalizeUserId(userId)
    if (!normalizedUserId) {
      return false
    }

    const pool = this.getPool()
    if (!pool.accounts[normalizedUserId]) {
      return false
    }

    delete pool.accounts[normalizedUserId]
    pool.sharedIds = pool.sharedIds.filter(id => id !== normalizedUserId)
    this.#savePool(pool)
    return true
  }

  clearInvalidAccounts() {
    const pool = this.getPool()
    const removedAccounts = []
    const skippedGlobalAccounts = []

    for (const account of Object.values(pool.accounts)) {
      if (!account?.authInvalid) {
        continue
      }

      if (account.isGlobalDefault) {
        skippedGlobalAccounts.push({
          userId: account.userId,
          ownerBotUserId: account.ownerBotUserId || '',
          nickname: account.nickname || account.userName || '',
          lastAuthErrorMessage: account.lastAuthErrorMessage || ''
        })
        continue
      }

      removedAccounts.push({
        userId: account.userId,
        ownerBotUserId: account.ownerBotUserId || '',
        shared: Boolean(account.shared),
        nickname: account.nickname || account.userName || '',
        lastAuthErrorMessage: account.lastAuthErrorMessage || ''
      })

      delete pool.accounts[account.userId]
    }

    if (!removedAccounts.length) {
      return {
        removedAccounts,
        skippedGlobalAccounts
      }
    }

    pool.sharedIds = pool.sharedIds.filter(id => pool.accounts[id])
    this.#savePool(pool)

    logger.info('[营地账号池] 已清理失效登录态', {
      removedCount: removedAccounts.length,
      skippedGlobalCount: skippedGlobalAccounts.length,
      removedAccounts,
      skippedGlobalAccounts
    })

    return {
      removedAccounts,
      skippedGlobalAccounts
    }
  }

  setShared(userId, shared) {
    const normalizedUserId = normalizeUserId(userId)
    if (!normalizedUserId) {
      throw new Error('缺少营地 userId')
    }

    const account = this.getAccount(normalizedUserId)
    if (!account) {
      throw new Error(`账号池中不存在营地账号 ${normalizedUserId}`)
    }

    return this.upsertAccount({
      ...account,
      shared: Boolean(shared)
    })
  }

  bindCampUserId(botUserId, campUserId) {
    const normalizedBotUserId = normalizeUserId(botUserId)
    const normalizedCampUserId = normalizeUserId(campUserId)
    const userData = readYamlSafe(USER_DATA_FILE, this.#getDefaultUserData())

    if (!userData[normalizedBotUserId]) {
      userData[normalizedBotUserId] = {
        ids: [],
        current: 0
      }
    }

    const entry = userData[normalizedBotUserId]

    if (!Array.isArray(entry.ids)) {
      entry.ids = []
    }

    let index = entry.ids.indexOf(normalizedCampUserId)
    if (index === -1) {
      entry.ids.push(normalizedCampUserId)
      index = entry.ids.length - 1
    }

    entry.current = index
    this.#saveUserData(userData)
    logger.debug('[营地账号池] 已绑定营地ID到机器人用户', {
      botUserId: normalizedBotUserId,
      campUserId: normalizedCampUserId,
      current: entry.current,
      ids: entry.ids
    })
    return entry
  }

  getAuthCandidates(targetUserId, options = {}) {
    const normalizedTargetUserId = normalizeUserId(targetUserId)
    const {
      requesterBotUserId = '',
      includeTarget = true,
      includeShared = true,
      includeGlobal = true
    } = options
    const normalizedRequesterBotUserId = normalizeUserId(requesterBotUserId)
    const pool = this.getPool()
    const candidates = []
    const seen = new Set()

    const pushCandidate = (auth, source, label) => {
      if (!isUsableAuth(auth)) {
        return
      }

      if (auth.authInvalid) {
        return
      }

      const key = normalizeUserId(auth.userId)
      if (!key || seen.has(key)) {
        return
      }

      seen.add(key)
      candidates.push({
        auth: {
          ...auth,
          enabled: true
        },
        source,
        label: label || key
      })
    }

    if (includeGlobal) {
      const globalAccounts = this.#sortAccountsByPriority(
        Object.values(pool.accounts).filter(account => account.isGlobalDefault)
      )
      for (const globalAccount of globalAccounts) {
        pushCandidate(globalAccount, 'global', `全局账号 ${globalAccount.userId}`)
      }
    }

    if (includeShared) {
      const sharedAccounts = this.#sortAccountsByPriority(
        pool.sharedIds
          .map(sharedId => pool.accounts[sharedId])
          .filter(account => account && !account.isGlobalDefault)
      )
      for (const sharedAccount of sharedAccounts) {
        const sharedId = normalizeUserId(sharedAccount.userId)
        pushCandidate(pool.accounts[sharedId], 'shared', `共享账号 ${sharedId}`)
      }
    }

    if (includeTarget && normalizedTargetUserId && pool.accounts[normalizedTargetUserId]) {
      const targetAccount = pool.accounts[normalizedTargetUserId]
      const ownerBotUserId = normalizeUserId(targetAccount.ownerBotUserId)
      if (ownerBotUserId && normalizedRequesterBotUserId && ownerBotUserId === normalizedRequesterBotUserId) {
        pushCandidate(targetAccount, 'target', `目标账号 ${normalizedTargetUserId}`)
      }
    }

    return candidates
  }

  getGuobaAccounts() {
    return this.listAccounts().map(account => ({
      userId: account.userId,
      ownerBotUserId: account.ownerBotUserId,
      isGlobalDefault: Boolean(account.isGlobalDefault),
      priority: Number(account.priority || 100),
      shared: Boolean(account.shared),
      authInvalid: Boolean(account.authInvalid),
      authErrorCount: Number(account.authErrorCount || 0),
      nickname: account.nickname || account.userName || '',
      userName: account.userName || '',
      snsnickname: account.snsnickname || '',
      remark: account.remark || '',
      token: account.token || '',
      userKey: account.userKey || '',
      encodeRes: account.encodeRes || '',
      accessToken: account.accessToken || '',
      refreshToken: account.refreshToken || '',
      appOpenid: account.appOpenid || '',
      openId: account.openId || '',
      gameOpenId: account.gameOpenId || '',
      gameRoleId: account.gameRoleId || '',
      gameServerId: account.gameServerId || '',
      gameAreaId: account.gameAreaId || '',
      gameUserSex: account.gameUserSex || '',
      kohDimGender: account.kohDimGender || '',
      avatar: account.avatar || '',
      bigAvatar: account.bigAvatar || '',
      icon: account.icon || '',
      sex: account.sex || '',
      expires: account.expires || '',
      uin: account.uin || '',
      userSig: account.userSig || '',
      realRegisterTime: account.realRegisterTime || '',
      loginPlatform: account.loginPlatform || '',
      updatedAt: account.updatedAt || '',
      lastLoginAt: account.lastLoginAt || '',
      lastSuccessAt: account.lastSuccessAt || '',
      lastAuthErrorAt: account.lastAuthErrorAt || '',
      lastAuthErrorMessage: account.lastAuthErrorMessage || ''
    }))
  }

  replaceAccountsFromGuoba(accounts = [], sharedIds = []) {
    const pool = this.getPool()
    const nextAccounts = {}
    const nextSharedIds = []
    const normalizedSharedIds = new Set((sharedIds || []).map(normalizeUserId).filter(Boolean))
    let selectedGlobalAccountId = ''

    for (const item of accounts) {
      const userId = normalizeUserId(item.userId)
      if (!userId) {
        continue
      }

      const existing = pool.accounts[userId] || {}
      const isRequestedGlobal = Boolean(item.isGlobalDefault)
      const isGlobalDefault = isRequestedGlobal && (!selectedGlobalAccountId || selectedGlobalAccountId === userId)
      if (isGlobalDefault) {
        selectedGlobalAccountId = userId
      }
      const next = this.#normalizeAccount({
        ...existing,
        userId,
        ownerBotUserId: normalizeUserId(item.ownerBotUserId),
        isGlobalDefault,
        priority: toNumberValue(item.priority ?? existing.priority ?? 100, 100),
        shared: isGlobalDefault ? false : (normalizedSharedIds.size ? normalizedSharedIds.has(userId) : Boolean(item.shared)),
        authInvalid: Boolean(item.authInvalid),
        authErrorCount: Number(item.authErrorCount ?? existing.authErrorCount ?? 0),
        nickname: toStringValue(item.nickname || existing.nickname || existing.userName),
        userName: toStringValue(item.userName),
        snsnickname: toStringValue(item.snsnickname),
        remark: toStringValue(item.remark),
        token: toStringValue(item.token),
        userKey: toStringValue(item.userKey),
        encodeRes: toStringValue(item.encodeRes),
        accessToken: toStringValue(item.accessToken),
        refreshToken: toStringValue(item.refreshToken),
        appOpenid: toStringValue(item.appOpenid),
        openId: toStringValue(item.openId),
        gameOpenId: toStringValue(item.gameOpenId),
        gameRoleId: toStringValue(item.gameRoleId),
        gameServerId: toStringValue(item.gameServerId),
        gameAreaId: toStringValue(item.gameAreaId),
        gameUserSex: toStringValue(item.gameUserSex),
        kohDimGender: toStringValue(item.kohDimGender),
        avatar: toStringValue(item.avatar),
        bigAvatar: toStringValue(item.bigAvatar),
        icon: toStringValue(item.icon),
        sex: toStringValue(item.sex),
        expires: toStringValue(item.expires),
        uin: toStringValue(item.uin),
        userSig: toStringValue(item.userSig),
        realRegisterTime: toStringValue(item.realRegisterTime),
        loginPlatform: toStringValue(item.loginPlatform),
        updatedAt: toStringValue(item.updatedAt || existing.updatedAt),
        lastLoginAt: toStringValue(item.lastLoginAt || existing.lastLoginAt),
        lastSuccessAt: toStringValue(item.lastSuccessAt || existing.lastSuccessAt),
        lastAuthErrorAt: toStringValue(item.lastAuthErrorAt || existing.lastAuthErrorAt),
        lastAuthErrorMessage: toStringValue(item.lastAuthErrorMessage || existing.lastAuthErrorMessage)
      }, existing)

      nextAccounts[userId] = next
      if (next.shared) {
        nextSharedIds.push(userId)
      }
    }

    this.#savePool({
      accounts: nextAccounts,
      sharedIds: nextSharedIds
    })
  }
}

export const authStore = new AuthStore()
export default authStore
