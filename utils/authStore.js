/**
 * 账号池存储 —— 营地登录态（`AuthPool.json`）与机器人用户的营地绑定（`UserData.yaml`）。
 *
 * ## 这一层负责什么
 *
 *   · 读写上面两份数据文件，并且**坏文件绝不静默清空**（隔离留证交给 safeStore）
 *   · 账号的增删改查：字段归一化、按优先级排序、失效标记、去重
 *   · 给接口层挑「这次请求用哪个号」（`getAuthCandidates`）
 *   · 给锅巴面板读写账号快照（`getGuobaAccounts` / `replaceAccountsFromGuoba`）
 *
 * ## 两条不能动的约定
 *
 *   ① **落盘的字段名与键顺序**。`AuthPool.json` 是主人手工救数据时照着看的文件，
 *      字段表 `ACCOUNT_FIELDS` 的顺序就是文件里的键顺序 —— 重排会让整份文件 diff 全红。
 *   ② **导出的名字**。`isUsableAuth` / `authStore` 被 api.js、锅巴、apps/ 多处引用，
 *      改名等于全线报错。
 *
 * ## 为什么按「字段表 + 取值器」写
 *
 * 账号有 40 来个字段，其中三十多个都是同一套「新值取到就用、取不到沿用池里的旧值」。
 * 原先每个字段抄一行，加字段漏一行就是**静默丢数据**，而且光看代码看不出来。
 * 现在取值语义集中在 `FIELD_RESOLVERS` 里，加字段只加一行。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PluginData } from '#components'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'
import { writeFileAtomic, quarantineCorrupt } from './safeStore.js'

// ────────────────────────────────────────────────────────────────────────
// 文件位置与常量
// ────────────────────────────────────────────────────────────────────────

const AUTH_POOL_FILE = path.join(PluginData, 'AuthPool.json')
const LEGACY_AUTH_POOL_FILE = path.join(PluginData, 'AuthPool.yaml')
const USER_DATA_FILE = path.join(PluginData, 'UserData.yaml')

/** 本模块日志的统一前缀。原先散在七八处手写，写歪一处就搜不到了 */
const LOG_TAG = '[营地账号池]'

/**
 * 隔离坏文件时的日志前缀。
 *
 * ⚠️ 它和 `LOG_TAG` 不一样是**故意的**：这两个值都出现在日志里，
 * 主人排查时按前缀搜，改一个字就搜不到了。所以抽成具名常量、值照旧，
 * 而不是顺手统一成 `LOG_TAG`（差分测试会当场拦下来）。
 */
const QUARANTINE_TAG = '[王者账号]'

/**
 * 空池 / 空绑定表。
 * 交出去之前一律 `structuredClone` —— 直接给常量的话，调用方一改就把默认值改了，
 * 下一次回落读到的就是被污染的那份。
 */
const EMPTY_POOL = { accounts: {} }
const EMPTY_USER_DATA = {}

/** 没写 priority 的账号默认排在这一档（数字越小越先试） */
const DEFAULT_PRIORITY = 100

/**
 * 健康账号的 `lastSuccessAt` 最少隔多久才落盘一次。
 * 它只剩锅巴面板展示这一个消费方（见 markAuthSuccess 的注释），
 * 10 分钟的颗粒度足够「看看这个号最近活没活」。
 */
const LAST_SUCCESS_FLUSH_MS = 10 * 60 * 1000

// ────────────────────────────────────────────────────────────────────────
// 基础转换
// ────────────────────────────────────────────────────────────────────────

/**
 * 转字符串，`null` / `undefined` 一律给空串。
 *
 * 上游这里是两个函数（`toStringValue` 和 `normalizeUserId`），但两者的结果对
 * **任何**输入都相同（`''` 走 `String('')` 还是 `''`），分成两个名字只会让人
 * 以为它们有区别、进而怀疑某个调用点用错了。合成一个。
 */
function toText (value) {
  if (value === null || typeof value === 'undefined') {
    return ''
  }

  return String(value)
}

/** 转数字；转不出有限数就用 fallback（`Number('abc')` 是 NaN，不能直接落盘） */
function toNumber (value, fallback = 0) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

/**
 * 打日志用的脱敏：只留头尾，中间一律 `...`。
 * 令牌 / 密钥进日志前**都要**过这里，别在调用点手拼 —— 漏一处就是明文进日志。
 */
function maskSecret (value, keepStart = 6, keepEnd = 4) {
  const text = toText(value)
  if (!text) {
    return ''
  }

  if (text.length <= keepStart + keepEnd) {
    return text
  }

  return `${text.slice(0, keepStart)}...${text.slice(-keepEnd)}`
}

// ────────────────────────────────────────────────────────────────────────
// 安全读写
// ────────────────────────────────────────────────────────────────────────

/**
 * 「读文件 → 解析 → 出错隔离」的公共骨架，JSON / YAML 共用。
 *
 * 两种格式的容错要求**完全一样**：
 *   · 文件不在        → 回落默认值（深拷一份，别把常量递出去）
 *   · 解析抛错        → 先把坏文件挪走留证，再回落（见 safeStore 的说明）
 * 所以只把「怎么解析」当参数传进来，别的逻辑只写一遍。
 *
 * ⚠️ 解析成 `null` 时**不在这里兜底** —— 两个格式对它的处理历来不同
 *    （JSON 原样返回，YAML 回落默认值），兜底写在各 `parse` 里保持原样。
 *
 * @param {string} filePath
 * @param {object} fallback 文件缺失 / 解析失败时的回落值
 * @param {(filePath: string, fallback: object) => object} parse
 */
function readSafe (filePath, fallback, parse) {
  try {
    if (!fs.existsSync(filePath)) {
      return structuredClone(fallback)
    }

    return parse(filePath, fallback)
  } catch (error) {
    // AuthPool.json 存的是所有人的登录态、UserData.yaml 是绑定关系：
    // 坏了就是全员重新扫码 / 重新绑定。静默按默认值继续会让下一次写把默认值
    // 固化下来，所以先把坏文件挪走留证，再按空数据继续。
    quarantineCorrupt(filePath, error, QUARANTINE_TAG)
    return structuredClone(fallback)
  }
}

/** 读 JSON。解析成 `null` 时**原样返回**（老行为，别顺手改成回落） */
function readJsonSafe (filePath, fallback = EMPTY_POOL) {
  return readSafe(filePath, fallback, file => JSON.parse(fs.readFileSync(file, 'utf8')))
}

/** 读 YAML。解析成 `null`（空文件）时回落默认值 */
function readYamlSafe (filePath, fallback = EMPTY_USER_DATA) {
  return readSafe(filePath, fallback, (file, empty) => readYamlFile(file) ?? structuredClone(empty))
}

/** JSON 带缩进落盘（人可读，方便手工救数据），走原子写 */
function writeJsonPretty (filePath, data) {
  writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

// ────────────────────────────────────────────────────────────────────────
// 对外契约
// ────────────────────────────────────────────────────────────────────────

/**
 * 这份登录态有没有资格发请求（token / userId / 密钥三样齐）。
 * 导出给 api.js 用：它判「池里还有没有能用的账号」时要和选候选同一套判据，
 * 两边各写一份迟早漂移。
 */
export function isUsableAuth (auth) {
  return Boolean(auth?.token && auth?.userId && (auth?.userKey || auth?.encodeRes))
}

// ────────────────────────────────────────────────────────────────────────
// 账号字段表
// ────────────────────────────────────────────────────────────────────────

/**
 * 每种字段的取值方式。签名统一为 `(字段名, 新数据, 池里的旧数据, 当前时间戳)`。
 *
 *   text     —— `??` 语义：只有 `null` / `undefined` 算缺失
 *   id       —— `||` 语义：空串也算缺失（`userId` / `ownerBotUserId` 历来如此）
 *   flag     —— 新数据里是**显式布尔值**才改，否则沿用旧值的布尔化
 *   priority —— 数字，缺失落到 `DEFAULT_PRIORITY`
 *   count    —— 数字，缺失落到 0
 *   created  —— 旧值优先，没有就取当前时间
 *   updated  —— 恒为当前时间（每次归一化都算一次「动过」）
 *   login    —— 旧值优先，再退当前时间
 */
const FIELD_RESOLVERS = {
  text: (key, account, existing) => toText(account[key] ?? existing[key]),
  id: (key, account, existing) => toText(account[key] || existing[key]),
  flag: (key, account, existing) => (typeof account[key] === 'boolean'
    ? account[key]
    : Boolean(existing[key])),
  priority: (key, account, existing) => toNumber(
    account[key] ?? existing[key] ?? DEFAULT_PRIORITY,
    DEFAULT_PRIORITY
  ),
  count: (key, account, existing) => Number(account[key] ?? existing[key] ?? 0),
  created: (key, account, existing, timestamp) => existing[key] || timestamp,
  updated: (key, account, existing, timestamp) => timestamp,
  login: (key, account, existing, timestamp) => toText(account[key] ?? existing[key] ?? timestamp)
}

/**
 * 账号的全部字段：`[字段名, 取值方式]`。
 *
 * ⚠️⚠️ **这个顺序就是 `AuthPool.json` 里的键顺序，不许动。**
 *    写盘用的是给人看的缩进 JSON，重排会让整份文件 diff 全红
 *    （内容等价，但主人手工救数据时得照着它读）。
 *
 * 加字段就加一行；删字段要连锅巴快照（`getGuobaAccounts`）和
 * `replaceAccountsFromGuoba` 一起看，否则会出现「读得出来、存不回去」。
 */
const ACCOUNT_FIELDS = [
  ['userId', 'id'],
  ['token', 'text'],
  ['userKey', 'text'],
  ['encodeRes', 'text'],
  ['openId', 'text'],
  ['gameOpenId', 'text'],
  ['gameRoleId', 'text'],
  ['gameServerId', 'text'],
  ['gameAreaId', 'text'],
  ['gameUserSex', 'text'],
  ['kohDimGender', 'text'],
  ['xLogUid', 'text'],
  ['traceparent', 'text'],
  ['accessToken', 'text'],
  ['refreshToken', 'text'],
  ['appOpenid', 'text'],
  ['avatar', 'text'],
  ['bigAvatar', 'text'],
  ['icon', 'text'],
  ['nickname', 'text'],
  ['snsnickname', 'text'],
  ['userName', 'text'],
  ['sex', 'text'],
  ['expires', 'text'],
  ['uin', 'text'],
  ['userSig', 'text'],
  ['realRegisterTime', 'text'],
  ['ownerBotUserId', 'id'],
  ['loginPlatform', 'text'],
  ['remark', 'text'],
  ['isGlobalDefault', 'flag'],
  ['priority', 'priority'],
  ['authInvalid', 'flag'],
  ['authErrorCount', 'count'],
  ['lastAuthErrorAt', 'text'],
  ['lastAuthErrorMessage', 'text'],
  ['lastSuccessAt', 'text'],
  ['createdAt', 'created'],
  ['updatedAt', 'updated'],
  ['lastLoginAt', 'login']
]

/**
 * 账号摘要 —— 清理失效账号时「已删掉」和「跳过」两个名单共用这一份形状。
 * 原先两处各抄了一遍，改一处漏一处就会让返回值和日志对不上。
 */
function summarizeAccount (account) {
  return {
    userId: account.userId,
    ownerBotUserId: account.ownerBotUserId || '',
    nickname: account.nickname || account.userName || '',
    lastAuthErrorMessage: account.lastAuthErrorMessage || ''
  }
}

class AuthStore {
  /**
   * 全局账号轮询游标。只活在进程内存里，重启后从优先级最高的号重新开始。
   *
   * ⚠️ 当前**没有任何调用方**：`getAuthCandidates` 刻意不轮转（见那里的说明），
   *    轮转由 api.js 自己的游标做。这里留着是历史残留，行为上恒为 0。
   */
  #globalCursor = 0

  /**
   * 把本轮该用的全局账号转到队首，其余按原优先级跟在其后，并推进游标。
   *
   * ⚠️ 死代码：本类里没有调用点（`getAuthCandidates` 明确不轮转），
   *    实际轮转在 `utils/api.js` 的 `#rotateGlobals`。保留原样待主人定去留。
   */
  #rotateGlobals (accounts = []) {
    if (accounts.length <= 1) {
      return accounts
    }

    const offset = this.#globalCursor % accounts.length
    this.#globalCursor = (offset + 1) % accounts.length
    return [...accounts.slice(offset), ...accounts.slice(0, offset)]
  }

  /** 全局账号排前面，然后按 priority 升序，最后用 userId 兜底成全序（排序结果必须稳定可预期） */
  #sortAccountsByPriority (accounts = []) {
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

  /**
   * 把一个账号归一化成落盘形状：字段类型收口、缺的字段按旧值补。
   *
   * 先 `{ ...existing, ...account }` 保住**老字段和键顺序**（池里手工加过的字段
   * 不能因为这次归一化就丢掉），再按 `ACCOUNT_FIELDS` 逐字段覆盖 ——
   * 覆盖已存在的键不会改变它在对象里的位置，所以最终键顺序 = 旧对象顺序 + 表里新增的键。
   *
   * @param {object} account 新数据
   * @param {object} existing 池里已有的同号数据（新建账号时传空对象）
   */
  #normalizeAccount (account = {}, existing = {}) {
    const timestamp = new Date().toISOString()
    const normalized = { ...existing, ...account }

    for (const [key, kind] of ACCOUNT_FIELDS) {
      normalized[key] = FIELD_RESOLVERS[kind](key, account, existing, timestamp)
    }

    return normalized
  }

  /** 整池归一化：丢掉空 userId 的条目，其余逐个走 #normalizeAccount */
  #normalizePool (pool = {}) {
    const sourceAccounts = pool.accounts && typeof pool.accounts === 'object' ? pool.accounts : {}
    const accounts = {}

    for (const [userId, account] of Object.entries(sourceAccounts)) {
      const normalizedUserId = toText(userId || account?.userId)
      if (!normalizedUserId) {
        continue
      }

      accounts[normalizedUserId] = this.#normalizeAccount({
        ...account,
        userId: normalizedUserId
      })
    }

    return { accounts }
  }

  #savePool (pool) {
    writeJsonPretty(AUTH_POOL_FILE, this.#normalizePool(pool))
  }

  #saveUserData (userData) {
    // 目录由 writeFileAtomic 负责建，这里不用再来一次
    writeYamlFile(USER_DATA_FILE, userData)
  }

  /** 老的 `AuthPool.yaml` 只在「json 还没有、yaml 还在」时迁移一次 */
  #migrateLegacyPoolIfNeeded () {
    if (fs.existsSync(AUTH_POOL_FILE) || !fs.existsSync(LEGACY_AUTH_POOL_FILE)) {
      return
    }

    const legacyPool = readYamlSafe(LEGACY_AUTH_POOL_FILE, EMPTY_POOL)
    this.#savePool(legacyPool)
  }

  /**
   * 「找到账号 → 打补丁 → 落盘」的公共骨架。
   *
   * `markAuthFailure` / `markAuthSuccess` / `unmarkAuthFailure` 的补丁+落盘部分
   * 一模一样（空 userId 给 null、账号不存在给 null、归一化、写回、存盘），
   * 差别只在补丁内容与各自的前置判据（markAuthSuccess 有「无事早退」节流，
   * 见它自己的注释），所以骨架收在这里。
   *
   * 补丁用**回调**而不是现成对象：`authErrorCount` 要拿池里的旧值 +1，
   * 调用方必须先看到旧值才能算出来。
   *
   * @param {string} userId
   * @param {(previous: object) => object} makeChanges 基于旧值算出要改的字段
   * @returns {{ previous: object, next: object }|null}
   */
  #patchAccount (userId, makeChanges) {
    const normalizedUserId = toText(userId)
    if (!normalizedUserId) {
      return null
    }

    const pool = this.getPool()
    const previous = pool.accounts[normalizedUserId]
    if (!previous) {
      return null
    }

    const next = this.#normalizeAccount({ ...previous, ...makeChanges(previous) }, previous)
    pool.accounts[normalizedUserId] = next
    this.#savePool(pool)
    return { previous, next }
  }

  getPool () {
    this.#migrateLegacyPoolIfNeeded()
    return this.#normalizePool(readJsonSafe(AUTH_POOL_FILE, EMPTY_POOL))
  }

  getAccount (userId) {
    const normalizedUserId = toText(userId)
    if (!normalizedUserId) {
      return null
    }

    return this.getPool().accounts[normalizedUserId] || null
  }

  listAccounts () {
    return this.#sortAccountsByPriority(Object.values(this.getPool().accounts))
  }

  upsertAccount (account) {
    const userId = toText(account.userId)
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

    // 刻意不再「一山不容二虎」地清掉其他全局账号：全局账号现在是一个轮询池
    // （轮转在 api.js 的 #rotateGlobals），扫码登记第二个号不该把第一个顶掉。

    this.#savePool(pool)
    logger.debug(`${LOG_TAG} 已保存账号登录态`, {
      userId: next.userId,
      ownerBotUserId: next.ownerBotUserId,
      loginPlatform: next.loginPlatform,
      isGlobalDefault: next.isGlobalDefault,
      priority: next.priority,
      token: maskSecret(next.token),
      userKey: maskSecret(next.userKey),
      encodeRes: maskSecret(next.encodeRes),
      appOpenid: maskSecret(next.appOpenid),
      openId: maskSecret(next.openId),
      gameOpenId: maskSecret(next.gameOpenId),
      gameRoleId: next.gameRoleId,
      gameServerId: next.gameServerId,
      gameAreaId: next.gameAreaId,
      gameUserSex: next.gameUserSex,
      kohDimGender: next.kohDimGender,
      nickname: next.nickname || next.userName || ''
    })
    return next
  }

  /**
   * 标记登录态失效：累加错误次数、记下最后一条错因，并回一句「这次是不是**刚**失效」。
   * `newlyInvalid` 是给 api.js 用的 —— 它只在「刚失效」那一次私信主人，
   * 否则一个坏号会按请求量反复轰炸。
   */
  markAuthFailure (userId, message = '') {
    const patched = this.#patchAccount(userId, account => ({
      authInvalid: true,
      authErrorCount: Number(account.authErrorCount || 0) + 1,
      lastAuthErrorAt: new Date().toISOString(),
      lastAuthErrorMessage: toText(message)
    }))

    if (!patched) {
      return null
    }

    const { previous, next } = patched
    logger.warn(`${LOG_TAG} 已标记账号登录态失效`, {
      userId: next.userId,
      ownerBotUserId: next.ownerBotUserId,
      isGlobalDefault: next.isGlobalDefault,
      authErrorCount: next.authErrorCount,
      lastAuthErrorMessage: next.lastAuthErrorMessage
    })

    return {
      ...next,
      newlyInvalid: !Boolean(previous.authInvalid)
    }
  }

  /**
   * 登录成功：清掉失效标记和错误计数，记下成功时间。
   *
   * ⚠️ **无事早退**：账号本来就健康（没标 authInvalid、没有错误计数、没有
   *    lastAuthErrorAt/Message）时，一次成功请求没有任何**状态**要纠正，
   *    只读不写。这条路径原先是每个成功请求都全量重写 AuthPool.json
   *    （一天数千次磁盘放大，还把全池 updatedAt 刷成一样，审计意义归零）。
   *    读盘这一步省不掉：AuthPool 是唯一事实源，锅巴/手工随时会改它，
   *    不能加内存缓存假装没这回事——省掉的是写，不是读。
   *
   * ⚠️ `lastSuccessAt` 剩余的唯一语义是「大概最后一次成功」（锅巴面板展示用，
   *    grep 过全仓库没有任何逻辑消费它的新鲜度，campRenew 的注释也明确告诫
   *    别拿它当覆盖率指标），所以**节流写盘**：距上次落盘不足
   *    `LAST_SUCCESS_FLUSH_MS` 就只在内存里攒着，到点随下一次成功一起写。
   */
  markAuthSuccess (userId) {
    const normalizedUserId = toText(userId)
    if (!normalizedUserId) {
      return null
    }

    const account = this.getAccount(normalizedUserId)
    if (!account) {
      return null
    }

    const now = Date.now()

    const isHealthy = !account.authInvalid &&
      !Number(account.authErrorCount || 0) &&
      !toText(account.lastAuthErrorAt) &&
      !toText(account.lastAuthErrorMessage)

    // 健康账号：唯一的变化是 lastSuccessAt，节流——距上次落盘未到点就不写
    if (isHealthy) {
      const lastFlushedAt = Date.parse(toText(account.lastSuccessAt)) || 0
      if (now - lastFlushedAt < LAST_SUCCESS_FLUSH_MS) {
        return account
      }
    }

    const patched = this.#patchAccount(normalizedUserId, () => ({
      authInvalid: false,
      authErrorCount: 0,
      lastAuthErrorAt: '',
      lastAuthErrorMessage: '',
      lastSuccessAt: new Date().toISOString()
    }))

    return patched ? patched.next : null
  }

  /**
   * 撤销一轮「误判的失效标记」——给 api.js 候选循环末尾的
   * 「全部候选以相同原因失败 → 判定为配置/系统问题」保险用。
   *
   * ⚠️ `expectedMessage` 必须与该账号池里**当前**的 lastAuthErrorMessage 一致
   *    才撤销：并发请求可能刚用别的原因标过这个号，那种标记不归本轮管，
   *    撤了就是把别的事故现场抹掉。
   */
  unmarkAuthFailure (userId, expectedMessage = '') {
    const normalizedUserId = toText(userId)
    if (!normalizedUserId) {
      return null
    }

    const account = this.getAccount(normalizedUserId)
    if (!account || !account.authInvalid) {
      return null
    }

    if (toText(account.lastAuthErrorMessage) !== toText(expectedMessage)) {
      return null
    }

    const patched = this.#patchAccount(normalizedUserId, previous => ({
      authInvalid: false,
      // 错误计数本轮 +1 过了，撤回时也减回来（不到 0 以下），保持「计数 ≈ 真实失效次数」
      authErrorCount: Math.max(0, Number(previous.authErrorCount || 0) - 1),
      lastAuthErrorAt: '',
      lastAuthErrorMessage: ''
    }))

    if (patched) {
      logger.warn(`${LOG_TAG} 已撤销账号登录态失效标记（判定为系统/配置问题）`, {
        userId: patched.next.userId,
        ownerBotUserId: patched.next.ownerBotUserId,
        isGlobalDefault: patched.next.isGlobalDefault
      })
      return patched.next
    }

    return null
  }

  /**
   * 设置全局账号：传 userId 就把那一个设成全局、其余全部取消；传空串则全部取消。
   * 账号池里没有这个 userId 时抛错（静默成功会让主人以为设上了）。
   */
  setGlobalAccount (userId = '') {
    const normalizedUserId = toText(userId)
    const pool = this.getPool()
    let found = !normalizedUserId

    for (const [accountUserId, account] of Object.entries(pool.accounts)) {
      // ⚠️⚠️ 左边**必须再包一层 `Boolean`**（2026-10-05 修）。
      //
      // 裸写 `normalizedUserId && accountUserId === normalizedUserId` 时，
      // `&&` 短路返回的是**左操作数本身**：传空串时结果是 `''` 而不是 `false`。
      // 而 #normalizeAccount 的 flag 分支只认真正的布尔
      // （`typeof account[key] === 'boolean'`），拿到 `''` 会**沿用池里的旧标记** ——
      // 于是 `setGlobalAccount('')` 一个全局标记都清不掉（上游一直是这个行为）。
      //
      // 这不是「特意保留的怪癖」，上游就是错的：传空串的语义是「全部取消」，
      // 清不掉等于这个入口白给。包成布尔之后两条语义都对：
      //   传 userId → 那一个是 true、其余是 false
      //   传空串   → 全部是 false
      const shouldBeGlobal = Boolean(normalizedUserId) && accountUserId === normalizedUserId
      if (shouldBeGlobal) {
        found = true
      }

      if (Boolean(account.isGlobalDefault) === Boolean(shouldBeGlobal)) {
        continue
      }

      pool.accounts[accountUserId] = this.#normalizeAccount({
        ...account,
        isGlobalDefault: shouldBeGlobal
      }, account)
    }

    if (!found) {
      throw new Error(`账号池中不存在营地账号 ${normalizedUserId}`)
    }

    this.#savePool(pool)
    return normalizedUserId
  }

  /** 优先级最高的那个全局账号（多个全局号时只是「第一个」，实际用哪个由 api.js 轮转决定） */
  getGlobalAccount () {
    return this.listAccounts().find(account => account.isGlobalDefault) || null
  }

  getGlobalAccountId () {
    return this.getGlobalAccount()?.userId || ''
  }

  /**
   * 某个机器人用户自己扫码登记的全局账号（可用的那些）。
   *
   * 用途：`#营地观战` 要拿「发起人自己的营地好友」，就得知道哪些全局账号是他扫的。
   * `ownerBotUserId` 从 2026-09-17 起在全局登录时一起写入。
   *
   * ⚠️ `includeOrphan`：这之前扫的全局账号 `ownerBotUserId` 是空的（那时全局登录只有主人能发，
   * 所以那批号一律算主人的）。主人查询时传 true 才不会把老号漏掉。
   */
  listGlobalAccountsByOwner (botUserId, { includeOrphan = false } = {}) {
    const owner = toText(botUserId)
    return this.listAccounts().filter(account => {
      if (!account.isGlobalDefault || account.authInvalid || !isUsableAuth(account)) {
        return false
      }
      const accountOwner = toText(account.ownerBotUserId)
      if (!accountOwner) {
        return includeOrphan
      }
      return Boolean(owner) && accountOwner === owner
    })
  }

  /**
   * 把一个账号登记进全局账号池。
   *
   * 全局账号可以有多个（微信/QQ 扫出来的都行），请求会在它们之间轮换，
   * 所以这里是「加入」而不是「替换唯一的那一个」——扫码登记第二个号不该顶掉第一个。
   */
  upsertGlobalAccount (account = {}) {
    const next = this.upsertAccount({
      ...account,
      isGlobalDefault: true,
      resetAuthState: true
    })

    logger.info('[营地全局账号] 已更新全局账号池配置', {
      userId: next.userId,
      token: maskSecret(next.token),
      userKey: maskSecret(next.userKey),
      encodeRes: maskSecret(next.encodeRes)
    })

    return next
  }

  removeAccount (userId) {
    const normalizedUserId = toText(userId)
    if (!normalizedUserId) {
      return false
    }

    const pool = this.getPool()
    if (!pool.accounts[normalizedUserId]) {
      return false
    }

    delete pool.accounts[normalizedUserId]
    this.#savePool(pool)
    return true
  }

  /**
   * 清理失效登录态，**全局账号除外** —— 全局号失效要么重扫要么留着看错因，
   * 静默删掉会让主人不知道「为什么突然没号可用了」。
   *
   * @returns {{removedAccounts: object[], skippedGlobalAccounts: object[]}}
   */
  clearInvalidAccounts () {
    const pool = this.getPool()
    const removedAccounts = []
    const skippedGlobalAccounts = []

    for (const account of Object.values(pool.accounts)) {
      if (!account?.authInvalid) {
        continue
      }

      if (account.isGlobalDefault) {
        skippedGlobalAccounts.push(summarizeAccount(account))
        continue
      }

      removedAccounts.push(summarizeAccount(account))
      delete pool.accounts[account.userId]
    }

    if (!removedAccounts.length) {
      return { removedAccounts, skippedGlobalAccounts }
    }

    this.#savePool(pool)

    logger.info(`${LOG_TAG} 已清理失效登录态`, {
      removedCount: removedAccounts.length,
      skippedGlobalCount: skippedGlobalAccounts.length,
      removedAccounts,
      skippedGlobalAccounts
    })

    return { removedAccounts, skippedGlobalAccounts }
  }

  /**
   * 把营地ID绑到机器人用户身上（`UserData.yaml` 里 `{ ids: [], current: 0 }` 那套）。
   * 已绑过的号不重复入列，只把它切到 `current`。
   */
  bindCampUserId (botUserId, campUserId) {
    const normalizedBotUserId = toText(botUserId)
    const normalizedCampUserId = toText(campUserId)
    const userData = readYamlSafe(USER_DATA_FILE, EMPTY_USER_DATA)

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
    logger.debug(`${LOG_TAG} 已绑定营地ID到机器人用户`, {
      botUserId: normalizedBotUserId,
      campUserId: normalizedCampUserId,
      current: entry.current,
      ids: entry.ids
    })
    return entry
  }

  /**
   * 挑这次请求可以用的鉴权账号。
   *
   * 现在**只有全局账号**这一类候选。早先还有「共享账号」和「个人登录态兜底」两档，
   * 都是「全局账号都不可用才轮到」的兜底——多全局账号轮询 + 按账号冷却换号之后，
   * 那个前提基本不会发生，2026-09-13 一并删掉了（连字段一起）。
   *
   * `targetUserId` 参数留着是为了不给调用方添改动，实际已经用不到了。
   *
   * @param {string} targetUserId 已废弃，仅为兼容调用方保留
   * @param {{includeGlobal?: boolean}} options
   */
  getAuthCandidates (targetUserId, options = {}) {
    const { includeGlobal = true } = options
    const pool = this.getPool()
    const candidates = []
    const seen = new Set()

    const pushCandidate = (auth, source, label) => {
      if (!isUsableAuth(auth) || auth.authInvalid) {
        return
      }

      const key = toText(auth.userId)
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

    const globalAccounts = includeGlobal
      ? this.#sortAccountsByPriority(
        Object.values(pool.accounts).filter(account => account.isGlobalDefault)
      )
      : []
    // ⚠️⚠️ 这里**不要再 rotate**：api.js 的 `#getAuthCandidates` 已经转过一次了。
    //   两处都转 = 每次请求队首前进 **2** 格，池子大小是偶数时「奇数位永远当不上队首」
    //   → **一半的账号从来不会被用到**（2026-09-19 实测：8 个号实际只用到 4 个，
    //   另一半一直闲置到登录态失效，保活也救不到它们）。
    //   轮转的活儿交给调用方做（api.js 那边有游标和日志），这里只负责「给全 + 排好序」。
    for (const globalAccount of globalAccounts) {
      pushCandidate(globalAccount, 'global', `全局账号 ${globalAccount.userId}`)
    }

    return candidates
  }

  /**
   * 锅巴面板要的账号快照。
   *
   * ⚠️ 这份形状是锅巴表单的**数据契约**：字段名和 `replaceAccountsFromGuoba`
   *    的读取一一对应，两边同时加/删，否则会出现「表单里看不到」或「存回去就丢」。
   *    这里不做排序（`listAccounts` 已经排好）。
   */
  getGuobaAccounts () {
    return this.listAccounts().map(account => ({
      userId: account.userId,
      ownerBotUserId: account.ownerBotUserId,
      isGlobalDefault: Boolean(account.isGlobalDefault),
      priority: Number(account.priority || DEFAULT_PRIORITY),
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

  /**
   * 锅巴整表保存：用 payload 覆盖整池（payload 里没有的号就是被删了）。
   *
   * ⚠️⚠️ `isGlobalDefault` 只在 payload **明确给了布尔值**时才改，其余沿用池子里的现状。
   *
   * 原本写的是 `Boolean(item.isGlobalDefault)`：payload 里少了这个字段（undefined）
   * 就会被静默算成 false，把「扫码登录时设成的全局账号」一把刷回非全局。
   * 2026-09-20 实测踩到：主人用 #营地QQ全局登录 扫的号，锅巴保存一次之后就
   * 不在全局名单里了 —— #营地消息开 再也管不着它，而号本身还是好的
   * （token / userSig 都在），排查时极难对上账。
   *
   * 注意：拿 `existing.isGlobalDefault` 兜底而不是包成 Boolean(existing...)，
   * 是为了保留「面板上显式关掉某个全局号」的能力（那时 payload 带的是明确的 false）。
   */
  replaceAccountsFromGuoba (accounts = []) {
    const pool = this.getPool()
    const nextAccounts = {}

    for (const item of accounts) {
      const userId = toText(item.userId)
      if (!userId) {
        continue
      }

      const existing = pool.accounts[userId] || {}
      const isGlobalDefault = typeof item.isGlobalDefault === 'boolean'
        ? item.isGlobalDefault
        : Boolean(existing.isGlobalDefault)

      // 被从全局刷成非全局时留一条日志：这种改动以前是完全静默的，
      // 出事后只能靠翻 createdAt 反推。
      if (existing.isGlobalDefault === true && isGlobalDefault === false) {
        logger.warn(
          `${LOG_TAG} 全局账号 ${userId} 被标记为非全局（isGlobalDefault: true → false）`
        )
      }

      nextAccounts[userId] = this.#normalizeAccount({
        ...existing,
        userId,
        ownerBotUserId: toText(item.ownerBotUserId),
        isGlobalDefault,
        priority: toNumber(item.priority ?? existing.priority ?? DEFAULT_PRIORITY, DEFAULT_PRIORITY),
        authInvalid: Boolean(item.authInvalid),
        authErrorCount: Number(item.authErrorCount ?? existing.authErrorCount ?? 0),
        // ⚠️ 这里用 `??` 而不是 `||`（2026-10-05 修）：`||` 分不出
        //    「表单压根没带这个字段」和「表单明确把昵称清空了」——
        //    后者（`nickname: ''`）会被当成没带，又落回旧值 / `userName`，
        //    主人把昵称清空之后怎么保存都还在。
        nickname: toText(item.nickname ?? existing.nickname ?? existing.userName),
        userName: toText(item.userName),
        snsnickname: toText(item.snsnickname),
        remark: toText(item.remark),
        token: toText(item.token),
        userKey: toText(item.userKey),
        encodeRes: toText(item.encodeRes),
        accessToken: toText(item.accessToken),
        refreshToken: toText(item.refreshToken),
        appOpenid: toText(item.appOpenid),
        openId: toText(item.openId),
        gameOpenId: toText(item.gameOpenId),
        gameRoleId: toText(item.gameRoleId),
        gameServerId: toText(item.gameServerId),
        gameAreaId: toText(item.gameAreaId),
        gameUserSex: toText(item.gameUserSex),
        kohDimGender: toText(item.kohDimGender),
        avatar: toText(item.avatar),
        bigAvatar: toText(item.bigAvatar),
        icon: toText(item.icon),
        sex: toText(item.sex),
        expires: toText(item.expires),
        uin: toText(item.uin),
        userSig: toText(item.userSig),
        realRegisterTime: toText(item.realRegisterTime),
        loginPlatform: toText(item.loginPlatform),
        updatedAt: toText(item.updatedAt || existing.updatedAt),
        lastLoginAt: toText(item.lastLoginAt || existing.lastLoginAt),
        lastSuccessAt: toText(item.lastSuccessAt || existing.lastSuccessAt),
        lastAuthErrorAt: toText(item.lastAuthErrorAt || existing.lastAuthErrorAt),
        lastAuthErrorMessage: toText(item.lastAuthErrorMessage || existing.lastAuthErrorMessage)
      }, existing)
    }

    this.#savePool({ accounts: nextAccounts })
  }
}

export const authStore = new AuthStore()
export default authStore
