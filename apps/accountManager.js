/**
 * 王者账号管理
 *
 * 一个文件里装着几件互不相干的事，按下面这个顺序读：
 *   ① 绑定表（UserData.yaml）—— 所有指令的公共底座
 *   ② 出图 —— 账号管理卡片 + 账号池总览
 *   ③ 指令入口 —— 绑定 / 切换 / 删除 / 查询
 *   ④ 扫码登录 —— 微信、QQ 两条全局登录流程
 *   ⑤ 账号池运维 —— 统计、清理失效、隐藏主页名单
 *
 * ⚠️ 两处名字是**硬约束**，改了等于指令直接失效，别顺手重命名：
 *   · `rule[].fnc` 里按**字符串**引用的方法名（bindWzryId / switchWzryId /
 *     deleteWzryId / myWzryId / wechatGlobalScanLogin / qqGlobalScanLogin /
 *     showAuthPool / clearInvalidCampAuth / showHiddenProfiles / clearHiddenProfiles）。
 *     框架按名字取 `instance[fnc]`，改名不会有任何报错，只是这条指令不再响应
 *   · 传给 resources/html/*.html 的字段名（见 ② 各方法里的 data 对象）
 * 同理 `reg` 正则也不能动 —— 那是指令的匹配条件本身。
 *
 * 除上面那 10 个入口和 `describeCampAccount`（历史遗留，目前无人调用，见该方法注释）
 * 外，类内其余方法一律 `#` 私有：它们没有任何外部调用方，名字只是内部实现细节。
 */
import path from 'path'
import { getImgType, writeYamlFile, readYamlFile, Button, AT_HEAD, AT_TAIL, stripAtText, resolveTargetUserId, shouldQuote, invalidateShareCache, querySharedBind, listHiddenProfiles, clearHiddenProfile, clearAllHiddenProfiles } from '#utils'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginData, PluginPath } from '#components'
import authStore from '../utils/authStore.js'
import { syncUserBind } from '../utils/shareUsers.js'
import { fetchRoleNames } from '../utils/roleName.js'
import {
  createWechatLoginSession,
  waitForWechatLogin
} from '../utils/wechatLogin.js'
import {
  createQQLoginSession,
  waitForQQLogin
} from '../utils/qqLogin.js'

// ─────────────────────────────── 常量 ───────────────────────────────

/** 二维码发出后多久自动撤回（秒）。3 分钟有效期留一点余量 */
const LOGIN_QR_RECALL_SECONDS = 175
/** 「已扫码，待确认」那条提示多久自动撤回（秒） */
const LOGIN_SCAN_STATUS_RECALL_SECONDS = 60
const MS_PER_HOUR = 3600 * 1000

/** 账号池总览最多列几个主人（超出的只报个数），防止图长到没法看 */
const OVERVIEW_OWNER_LIMIT = 60

/** 绑定表的文件名，取数据和出图两处都要用，别再各写一遍字面量 */
const USER_DATA_FILE = 'UserData.yaml'
/** 未绑定时的教程图，裸发 #绑定营地 和本机没绑过的 #营地ID 都回它 */
const CAMP_ID_GUIDE_IMG = '营地ID获取.png'

/** 已有登录任务在跑时的统一挡回文案 */
const LOGIN_BUSY_HINT = '当前已有一个营地登录任务在进行中，请先完成当前二维码或稍后再试'
/** 序号越界 */
const INVALID_INDEX_HINT = '序号无效，请输入正确的序号'
/** 一条失效登录态都没有 */
const NO_INVALID_AUTH_HINT = '当前没有已标记失效的营地登录态，无需清理'
/** 扫码登录失败文案，按 error.code 分派 */
const QR_EXPIRED_HINT = '营地登录二维码已过期，请重新发起'
const QR_CANCELED_HINT = '营地登录已取消，请重新发起'
const QR_TIMEOUT_SCANNED_HINT = '已扫码，但长时间未确认，营地登录已超时，请重新发起'
const QR_TIMEOUT_HINT = '营地登录等待超时，请重新发起'
/** 两条扫码登录共用的后半段引导（只有开头那句要不要点明「手机 QQ」不一样） */
const SCAN_LOGIN_TAIL = '\n登录成功后会自动保存登录态并绑定这个营地号，发 #营地观战 就能看你营地好友里谁在打。'

/**
 * 进行中的扫码登录任务：botUserId → { taskId, qrMessageId, ... }。只活在进程内存里。
 *
 * ⚠️⚠️ 必须锚在 `globalThis` 上（2026-10-06 修）：它同时是「同一人别重复发起」的并发锁
 *    （见 #beginScanLogin 的 `#pendingLogin(botUserId)` 判据），而 JiuLi 的热重载会给
 *    plugins/ 下每个模块追加 `?jiuli_reload=<代数>` 重新求值（见 utils/hotState.js）——
 *    模块级 Map 每代都变成新的空 Map，锁被架空：同一个人可以再发一条指令、两个扫码
 *    登录并行，各自往同一个人身上 upsert 账号，用户看到的回执与最终生效的号可能不是同一个。
 *    同仓的 campRenew / campIm / watchBattle / pushStore 都按这个约定锚了 globalThis。
 */
const pendingWechatLoginMap = (globalThis.__gokPendingWechatLoginMap ||= new Map())

export class AccountManager extends plugin {
  // ══════════════════════════ 指令注册 ══════════════════════════
  constructor() {
    super({
      name: '王者账号管理',
      dsc: '王者账号管理',
      event: 'message',
      priority: 1,
      rule: [
        {
          reg: new RegExp(`${AT_HEAD}#(?:营地|我的(?:王者|荣耀|农药)|(?:王者|荣耀|农药))ID${AT_TAIL}`, 'i'),
          fnc: 'myWzryId'
        },
        // ⚠️ 原来这里还有一条 `^#(?:获取|怎么看|如何获取)营地ID$` → howToGetWzryId。
        //    已删：新用户第一反应是发 `#绑定营地`，让他再记一条「怎么查ID」的指令是多余的一步。
        //    现在 `#绑定营地` 后面**没跟数字**就直接出那张教程图（见 bindWzryId 开头）。
        {
          reg: `${AT_HEAD}#绑定营地\\s*(.*)$`,
          fnc: 'bindWzryId'
        },
        {
          reg: `${AT_HEAD}#切换营地\\s*(.*)$`,
          fnc: 'switchWzryId'
        },
        {
          reg: `${AT_HEAD}#删除营地\\s*(.*)$`,
          fnc: 'deleteWzryId'
        },
        // 两条全局登录**所有人都能发**：登录态记在扫码人自己名下（ownerBotUserId），
        // #营地观战 就靠它认「谁的营地好友」。谁扫的号只喂谁的观战名单，
        // 不会因为开放就串到别人的好友列表上。
        // 扫码成功后顺手把这个号绑定给扫码人，省掉再发一条 #绑定营地。
        {
          reg: new RegExp('^#营地wx全局登录$', 'i'),
          fnc: 'wechatGlobalScanLogin'
        },
        // 两条登录一律带 `i`：手机上打「qq」「wx」比大写顺手，
        // 用户不该为了大小写重发一遍。字符串形式的 reg 没法写内联标志，
        // 但 Yunzai 收 RegExp 对象（同文件那几条 ID 指令就是这么写的）
        {
          reg: new RegExp('^#营地QQ全局登录$', 'i'),
          fnc: 'qqGlobalScanLogin'
        },
        {
          reg: '^#王者用户统计$',
          fnc: 'showAuthPool',
          permission: 'master'
        },

        {
          reg: '^#清理失效营地账号$',
          fnc: 'clearInvalidCampAuth',
          permission: 'master'
        },
        {
          reg: '^#隐藏主页名单$',
          fnc: 'showHiddenProfiles',
          permission: 'master'
        },
        {
          reg: '^#清除隐藏主页\\s*(.*)$',
          fnc: 'clearHiddenProfiles',
          permission: 'master'
        }
      ]
    })
  }

  // ══════════════════════ ① 绑定表（UserData.yaml） ══════════════════════

  // 获取用户数据
  #loadUserData(userId) {
    const filePath = path.join(PluginData, USER_DATA_FILE)
    const userData = readYamlFile(filePath) || {}

    // ⚠️ 判据是「条目存在**且 ids 是数组**」，不是「条目存在」（2026-10-06 修）。
    //    空对象 `{}` 是 truthy，`!userData[userId]` 为 false → 不补默认值 →
    //    紧接着 `userData[userId].ids.length` 抛 TypeError。
    //    触发面：手改 YAML、备份还原、旧版本写坏（`{}` / `{current:0}` / `{ids:null}`）。
    //    实测三种脏形态都抛 `Cannot read properties of undefined/null (reading 'length')`，
    //    而完全没这个键的新用户反而正常（走补默认值那条）。
    //    `authStore.bindCampUserId` 早就是这么写的，这里对齐它的口径。
    const entry = userData[userId]
    if (!entry || !Array.isArray(entry.ids)) {
      userData[userId] = { ...(entry || {}), ids: [], current: 0 }
    }

    return { userData, filePath }
  }

  // 保存用户数据
  #saveUserData(filePath, userData) {
    writeYamlFile(filePath, userData)
  }

  /**
   * 本地绑定变动后和共享库对一次账。
   *
   * 两件事：
   *  - 清掉这个 QQ 的共享缓存。本地值本来就会压住缓存值，但**删除/切换时必须清**——
   *    否则那份从共享库拿来的旧值会在本地已经没有之后继续被解析出来
   *  - 开了共享的人顺带把新绑定传上去。**故意不 await**：共享库是别人搭的外部依赖，
   *    它慢或者挂了都不该拖住「绑定成功」这个动作
   */
  #syncShareAfterBind(userId) {
    invalidateShareCache(userId)
    syncUserBind(userId).catch(() => {})
  }

  // 主人可以艾特别人代为操作（真 at 段与纯文本 @昵称都认），其他人只能操作自己
  // 返回空串表示 @ 的人没认出来，提示已经回给用户了
  async #resolveReplyUserId(e) {
    const { userId, hint } = await resolveTargetUserId(e, { requireMaster: true })
    if (hint) {
      await e.reply(hint)
      return ''
    }
    return userId
  }

  /**
   * 「按序号操作」类指令（#切换营地 / #删除营地）的公共前置。
   *
   * 解析操作人 → 摘掉指令前缀取序号 → 读绑定表 → 校验序号，任一步不成立就把提示
   * 回出去并返回 null。两条指令「还没绑定」的文案不同（删除那条顺手带一个绑定按钮），
   * 所以空列表的回复由调用方给。
   *
   * @param {RegExp} prefixRe 要摘掉的指令前缀
   * @param {string|Array} emptyReply 一条 ID 都没绑时回什么
   * @returns {Promise<{userId: string, index: number, userData: object, filePath: string}|null>}
   */
  async #resolveIndexTarget(e, prefixRe, emptyReply) {
    const userId = await this.#resolveReplyUserId(e)
    if (!userId) return null

    // ⚠️⚠️ 序号必须**先判是不是整数**，再拿去算下标（2026-10-06 修）。
    //    `parseInt('')` / `parseInt('abc')` / `parseInt('１')`（全角）**都返回 NaN**，
    //    而 `NaN < 0` 和 `NaN >= len` **都是 false** —— 下面那道越界拦截整个失效。
    //    接着 `ids.splice(NaN, 1)`：JS 把 NaN 当 0 → **静默删掉第一个营地号**。
    //    实测（逐字复刻本函数，真实 ids 三个）：
    //      `#删除营地`     → index=NaN 拦截=false → 删掉第一个 ❌
    //      `#删除营地abc`  → index=NaN 拦截=false → 删掉第一个 ❌
    //      `#删除营地１`   → index=NaN 拦截=false → 删掉第一个 ❌
    //      `#删除营地0`    → index=-1  拦截=true  → 正确拦住 ✅
    //    同一条路也服务 `#切换营地`，NaN 落盘后 YAML 会写成 `current: .nan`，
    //    下游 `ids[NaN]` 直接给用户 `undefined`。
    //    另：`parseInt` 要显式带基数 10（`parseInt('0x10')` 在无基数时是 16）。
    const parsed = parseInt(stripAtText(e.msg).replace(prefixRe, ''), 10)
    if (!Number.isInteger(parsed)) {
      await e.reply(INVALID_INDEX_HINT)
      return null
    }
    const index = parsed - 1

    const { userData, filePath } = this.#loadUserData(userId)

    // 条目的 ids 兜底见 #loadUserData；这里再挡一道，防手改/还原出来的脏数据
    if (!userData[userId]?.ids?.length) {
      await e.reply(emptyReply)
      return null
    }

    if (index < 0 || index >= userData[userId].ids.length) {
      await e.reply(INVALID_INDEX_HINT)
      return null
    }

    return { userId, index, userData, filePath }
  }

  // ══════════════════════════ ② 出图 ══════════════════════════

  // 新增公共方法处理HTML生成
  async #renderAccountManageCard(type, wzryId, idList, wzryName = '') {
    const parsedFuncs = [
      { cmd: '#绑定营地', example: '示例: #绑定营地 123' },
      // ⚠️ 这里列的必须是正则真支持的（2026-10-06 修）：规则是
      //    `#(?:营地|我的(?:王者|荣耀|农药)|(?:王者|荣耀|农药))ID`，「我的」后面必须跟限定词，
      //    裸的 `#我的ID` 匹配不上任何规则 —— 用户照着发会石沉大海。
      //    与 README / 帮助图保持一致（那两处也只列三个）。
      { cmd: '#营地ID / #王者ID / #我的王者ID', example: '示例: #我的王者ID' },
      { cmd: '#切换营地', example: '示例: #切换营地2' },
      { cmd: '#删除营地', example: '示例: #删除营地2' },
      { cmd: '#营地wx全局登录 / #营地QQ全局登录', example: '示例: #营地wx全局登录' },
      { cmd: '#王者主页 / #全部王者主页', example: '示例: #王者主页2' },
      { cmd: '#查询战绩 / #查询N战绩', example: '示例: #查询2战绩' },
      { cmd: '#王者帮助', example: '示例: #王者帮助' }
    ]

    return await puppeteer.screenshot('accountManage', {
      imgType: getImgType(),
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/accountManage.html',
      type,
      wzryId,
      wzryName,
      idList,
      parsedFuncs,
      timestamp: new Date().toLocaleString()
    })
  }

  async #renderAuthPoolOverview(data) {
    return await puppeteer.screenshot('authPoolOverview', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/authPoolOverview.html',
      imgType: getImgType(),
      ...data
    })
  }

  /**
   * 把「ID 列表卡片 + 尾部按钮」拼好发出去。
   *
   * 绑定/切换/删除/查询四条指令的回复形状完全一样（`[图片, 按钮]`），差别只在
   * type、当前 ID 和那颗按钮上。按钮做成 thunk 传进来：卡片渲染完才构造它，
   * 跟原实现的时点一致。
   *
   * @param {Function} tailButton 返回按钮段的函数，如 `() => Button.homepage(id)`
   */
  async #replyIdCard(e, type, currentId, userInfo, nameMap, tailButton) {
    const idList = this.#formatIdList(userInfo, nameMap)
    const html = await this.#renderAccountManageCard(type, currentId, idList, nameMap[currentId])
    await e.reply([html, tailButton()])
  }

  // 格式化ID列表显示
  #formatIdList(userInfo, nameMap = {}) {
    return userInfo.ids.map((id, index) => {
      const prefix = index === userInfo.current ? '✅' : '☑️'
      const roleName = nameMap[id]
      return `${prefix} ${index + 1}. ${id}${roleName ? `  ${roleName}` : ''}`
    }).join('\n')
  }

  #maskId(value, keepStart = 3, keepEnd = 3) {
    const text = String(value || '')
    if (!text) {
      return '未绑定'
    }

    if (text.length <= keepStart + keepEnd) {
      return text
    }

    return `${text.slice(0, keepStart)}***${text.slice(-keepEnd)}`
  }

  /** QQ 号打码：留头 3 尾 2（号长，尾部多留一位更好认） */
  #maskQqId(value) {
    return this.#maskId(value, 3, 2)
  }

  /** 营地ID 打码：留头 3 尾 3 */
  #maskCampUserId(value) {
    return this.#maskId(value, 3, 3)
  }

  /**
   * 组装账号池总览的数据。
   *
   * 输出字段名就是 resources/html/authPoolOverview.html 的契约，改名要连着模板一起改：
   * timestamp / overviewCards[{label,value,tone}] / ownerSections[] / omittedOwnerCount /
   * unownedAccounts[]，其中 ownerSections 每项带 maskedQqId、currentMaskedCampId、
   * tokenCount、validTokenCount、invalidTokenCount、uidEntries[{campUserId,
   * maskedCampUserId, isCurrent, badgeText, badgeClass}]。
   *
   * 分四步：规范化本机绑定 → 建「人 → 登录态」索引 → 摊平每个人的 ID 条目 → 算卡片。
   */
  #collectAuthPoolOverview() {
    // ⚠️ 这次 getPool() 的返回值用不上，但**不能删**：它内部会顺手做一次
    //    AuthPool.yaml → AuthPool.json 的历史迁移，删掉这条路径就少一次迁移机会
    authStore.getPool()
    const accounts = authStore.listAccounts()
    const userData = readYamlFile(path.join(PluginData, USER_DATA_FILE)) || {}

    const boundUsers = this.#normalizeBoundUsers(userData)
    const { ownerMap, unownedAccounts } = this.#indexAccountsByOwner(boundUsers, accounts)
    const allOwnerSections = this.#buildOwnerSections(ownerMap)
    const displayedOwnerSections = allOwnerSections.slice(0, OVERVIEW_OWNER_LIMIT)

    return {
      timestamp: new Date().toLocaleString(),
      overviewCards: this.#buildOverviewCards(boundUsers, allOwnerSections, accounts),
      ownerSections: displayedOwnerSections,
      omittedOwnerCount: Math.max(0, allOwnerSections.length - displayedOwnerSections.length),
      unownedAccounts
    }
  }

  /** 绑定表 → 「绑过号的人」列表。一个号都没绑的记录直接丢掉 */
  #normalizeBoundUsers(userData) {
    return Object.entries(userData)
      .map(([qqId, info]) => ({
        qqId: String(qqId),
        ids: Array.isArray(info?.ids) ? info.ids.map(id => String(id)) : [],
        current: Number(info?.current || 0)
      }))
      .filter(item => item.ids.length)
  }

  /**
   * 建「人 → 他名下的登录态」索引。
   *
   * 先按本机绑过的人铺骨架，再拿账号池里的 ownerBotUserId 往上挂 token —— 这样
   * 「绑了但没登录态」和「有登录态但本机没绑」两种人都会出现在同一张表里。
   * 没有 ownerBotUserId 的号归到 unownedAccounts（孤儿号）。
   */
  #indexAccountsByOwner(boundUsers, accounts) {
    const ownerMap = new Map()
    for (const boundUser of boundUsers) {
      const currentCampId = boundUser.ids[boundUser.current] || boundUser.ids[0] || ''
      ownerMap.set(boundUser.qqId, {
        qqId: boundUser.qqId,
        maskedQqId: this.#maskQqId(boundUser.qqId),
        boundCampIds: boundUser.ids,
        currentCampId,
        currentMaskedCampId: this.#maskCampUserId(currentCampId),
        tokens: []
      })
    }

    const unownedAccounts = []
    for (const account of accounts) {
      const ownerBotUserId = String(account.ownerBotUserId || '')
      const tokenItem = {
        campUserId: account.userId,
        maskedCampUserId: this.#maskCampUserId(account.userId),
        nickname: account.nickname || account.userName || '未命名账号',
        statusClass: account.authInvalid ? 'invalid' : 'valid'
      }

      if (!ownerBotUserId) {
        unownedAccounts.push(tokenItem)
        continue
      }

      if (!ownerMap.has(ownerBotUserId)) {
        ownerMap.set(ownerBotUserId, {
          qqId: ownerBotUserId,
          maskedQqId: this.#maskQqId(ownerBotUserId),
          boundCampIds: [],
          currentCampId: '',
          currentMaskedCampId: '未绑定',
          tokens: []
        })
      }
      ownerMap.get(ownerBotUserId).tokens.push(tokenItem)
    }

    return { ownerMap, unownedAccounts }
  }

  /**
   * 把每个人摊平成模板要的 section：绑定ID 与持有 Token 的 ID 去重后逐个列出来，
   * 标上有没有 token、是不是当前默认，再带上有效/失效的计数。
   */
  #buildOwnerSections(ownerMap) {
    return [...ownerMap.values()]
      .sort((left, right) => left.qqId.localeCompare(right.qqId))
      .map(owner => {
        const tokenMap = new Map(owner.tokens.map(item => [item.campUserId, item]))
        const mergedCampIds = [...new Set([
          ...owner.boundCampIds,
          ...owner.tokens.map(item => item.campUserId)
        ])]
        const validTokenCount = owner.tokens.filter(item => item.statusClass === 'valid').length
        return {
          ...owner,
          tokenCount: owner.tokens.length,
          validTokenCount,
          invalidTokenCount: owner.tokens.length - validTokenCount,
          uidEntries: mergedCampIds.map(campUserId => {
            const token = tokenMap.get(campUserId)
            return {
              campUserId,
              maskedCampUserId: this.#maskCampUserId(campUserId),
              // ⚠️ 保留 `&&` 的原始结果（可能是空串而不是 false）：模板只拿它做真值判断，
              //    但传给模板的 data 对象本身要逐字段一致，别顺手改成 Boolean(...)
              isCurrent: owner.currentCampId && owner.currentCampId === campUserId,
              badgeText: token ? 'Token' : '无',
              badgeClass: token ? token.statusClass : 'none'
            }
          })
        }
      })
  }

  /**
   * 顶部六张统计卡。⚠️ 顺序和 tone 是模板与 showAuthPool 文本兜底写死的
   * （兜底按下标取 overviewCards[0..5]），调整顺序要连着那边一起改。
   */
  #buildOverviewCards(boundUsers, allOwnerSections, accounts) {
    return [
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
  }

  // ══════════════ ③ 指令入口：绑定 / 切换 / 删除 / 查询 ══════════════

  // 绑定ID
  async bindWzryId(e) {
    // 只在群里绑：这张绑定表（UserData.yaml）只存 QQ ↔ 营地ID，本身不带群信息，
    // 而绑定之后的用途（群推送、#谁在打游戏 名单）全是按群来的 —— 私聊里绑出来
    // 的绑定没有能用的地方，拦掉免得用户绑完不知道去哪儿开。
    if (!e.isGroup) {
      await e.reply(['绑定营地需要在群里进行，请到群里发送 #绑定营地 [营地ID]', Button.bind()])
      return
    }

    const userId = await this.#resolveReplyUserId(e)
    if (!userId) return
    // 指令与ID之间允许有空格：#绑定营地123 与 #绑定营地 123 等价
    const wzryId = stripAtText(e.msg).replace(/^#绑定营地\s*/, '').trim()

    // ⭐ 只发 `#绑定营地`、后面什么都没跟 = **第一次来的用户不知道该填什么**。
    //    直接出那张「营地ID从哪看」的教程图，别只甩一句「仅支持数字」让他自己猜
    //    （原来那条 `#获取营地ID` 指令已删，教程图的入口就剩这一个）。
    if (!wzryId) {
      await this.#replyCampIdGuide(e)
      return
    }

    if (!/^\d+$/.test(wzryId)) {
      await e.reply(['营地ID仅支持数字，示例: #绑定营地123 或 #绑定营地 123', Button.bind()])
      return
    }
    const { userData } = this.#loadUserData(userId)

    if (userData[userId].ids.includes(wzryId)) {
      // 重复绑定也把昵称带上，不然用户看着两个数字对不上是谁
      const nameMap = await fetchRoleNames([wzryId], userId)
      await e.reply([`该ID已经绑定过了${nameMap[wzryId] ? `：${wzryId} ${nameMap[wzryId]}` : ''}`, Button.homepage(wzryId)])
      return
    }

    authStore.bindCampUserId(userId, wzryId)
    this.#syncShareAfterBind(userId)
    await this.#replyBindResultCard(e, userId, wzryId)
  }

  async #replyBindResultCard(e, botUserId, wzryId) {
    const { filePath } = this.#loadUserData(botUserId)
    const nextUserData = readYamlFile(filePath) || {}
    const currentUserInfo = nextUserData[botUserId] || {
      ids: [wzryId],
      current: 0
    }

    // 昵称跟 ID 一起给：只看一串数字认不出是谁的号
    const nameMap = await fetchRoleNames(currentUserInfo.ids, botUserId)
    await this.#replyIdCard(e, '绑定', wzryId, currentUserInfo, nameMap, () => Button.homepage(wzryId))
  }

  // 切换ID
  async switchWzryId(e) {
    const target = await this.#resolveIndexTarget(e, /^#切换营地\s*/, ['您还没有绑定任何ID，请先绑定', Button.bind()])
    if (!target) return
    const { userId, index, userData, filePath } = target

    userData[userId].current = index
    this.#saveUserData(filePath, userData)
    this.#syncShareAfterBind(userId)

    const currentId = userData[userId].ids[index]
    const nameMap = await fetchRoleNames(userData[userId].ids, userId)
    await this.#replyIdCard(e, '切换', currentId, userData[userId], nameMap, () => Button.homepage(currentId))
  }

  // 删除ID
  async deleteWzryId(e) {
    const target = await this.#resolveIndexTarget(e, /^#删除营地\s*/, ['您还没有绑定任何ID', Button.bind()])
    if (!target) return
    const { userId, index, userData, filePath } = target

    const deletedId = userData[userId].ids[index]
    const wasCurrent = Number(userData[userId].current) || 0
    userData[userId].ids.splice(index, 1)

    // 调整current索引。
    //
    // ⚠️⚠️ 删掉的下标**严格小于** current 时，current 必须跟着左移一位（2026-10-06 修）。
    //    `splice` 之后后面所有元素整体前移，但 current 只是个下标、不会自己动，
    //    于是「当前选中的号」**静默换成了后一个**。实测（ids=[A,B,C]）：
    //      current=1(选中B) 删第 1 个 → current 仍 1 → 选中变成 C ❌
    //      current=0(选中A) 删第 1 个 → current 仍 0 → 选中变成 B ❌
    //      current=2(选中C) 删第 1 个 → current=1 → 选中仍是 C ✅（那是夹位公式碰巧对了）
    //    第 3 行这种「碰巧对」正是这个 bug 一直没被发现的原因 —— 只在删**低序号**时暴露。
    if (index < wasCurrent) userData[userId].current = wasCurrent - 1

    // 再夹一次边界：删的是当前号、或删完只剩更少条目时，current 不能越界
    if (userData[userId].current >= userData[userId].ids.length) {
      userData[userId].current = Math.max(0, userData[userId].ids.length - 1)
    }

    this.#saveUserData(filePath, userData)
    this.#syncShareAfterBind(userId)

    // 被删的 ID 已经不在列表里了，单独带上一起查，卡片顶部才认得出删的是谁
    const nameMap = await fetchRoleNames([deletedId, ...userData[userId].ids], userId)
    await this.#replyIdCard(e, '删除', deletedId, userData[userId], nameMap, () => Button.account(userData[userId].ids))
  }

  // 展示ID列表
  async myWzryId(e) {
    const userId = await this.#resolveReplyUserId(e)
    if (!userId) return
    const { userData } = this.#loadUserData(userId)

    if (!userData[userId]?.ids.length) {
      // 本机没绑过 —— 但共享库里可能有他（在别的机器人上绑过）。
      // 早先这里直接回一张「怎么获取营地ID」的教程图，用户一看就像在说
      // 「你还没绑定」，可他库里明明有。所以先问一次库。
      const shared = await querySharedBind(userId)
      if (shared.found && shared.campIds?.length) {
        const list = {
          ids: shared.campIds,
          current: Math.max(0, shared.campIds.indexOf(shared.current))
        }
        const nameMap = await fetchRoleNames(shared.campIds, userId)
        const idList = this.#formatIdList(list, nameMap)
        const currentId = shared.campIds[list.current] || shared.campIds[0]
        const html = await this.#renderAccountManageCard('查询', currentId, idList, nameMap[currentId])

        return e.reply([
          '这些是从共享库拿到的，本机还没绑（推送类功能要本机绑一次）',
          html,
          Button.bind()
        ], shouldQuote())
      }

      return e.reply(this.#campIdGuidePayload(), shouldQuote())
    }

    const nameMap = await fetchRoleNames(userData[userId].ids, userId)
    const currentId = userData[userId].ids[userData[userId].current] || userData[userId].ids[0]
    await this.#replyIdCard(e, '查询', currentId, userData[userId], nameMap, () => Button.account(userData[userId].ids))
  }

  // 营地ID获取教程
  async #replyCampIdGuide(e) {
    await e.reply(this.#campIdGuidePayload(), shouldQuote())
  }

  /** 「营地ID 从哪看」那张教程图 + 绑定按钮，两处回复共用同一份载荷 */
  #campIdGuidePayload() {
    return [
      segment.image(path.join(PluginPath, 'resources', 'img', CAMP_ID_GUIDE_IMG)),
      Button.bind()
    ]
  }

  // ══════════════════ ④ 扫码登录（微信 / QQ） ══════════════════

  #pendingLogin(botUserId) {
    return pendingWechatLoginMap.get(botUserId) || null
  }

  #clearPendingLogin(botUserId) {
    const pending = this.#pendingLogin(botUserId)
    if (pending?.recallTimer) {
      clearTimeout(pending.recallTimer)
    }
    if (pending?.scanStatusRecallTimer) {
      clearTimeout(pending.scanStatusRecallTimer)
    }
    pendingWechatLoginMap.delete(botUserId)
    return pending
  }

  async #recallMessage(e, messageId) {
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

  async #recallLoginMessages(e, pending) {
    if (!pending) {
      return
    }

    await this.#recallMessage(e, pending.qrMessageId)
    await this.#recallMessage(e, pending.scanStatusMessageId)
    pending.qrMessageId = ''
    pending.scanStatusMessageId = ''
    // ⚠️⚠️ 置空前**必须先 clearTimeout**（2026-10-05 修）。
    //    收尾的 `#clearPendingLogin` 是拿 `if (pending.scanStatusRecallTimer)` 判的，
    //    这里直接置 null，它之后就**再也不会去清**那个定时器了 ——
    //    定时器会一直挂到自然到期，而它的闭包抓着整个 `e`（消息事件），
    //    等于每次登录成功都白留一份会话上下文到最后期限。
    if (pending.scanStatusRecallTimer) {
      clearTimeout(pending.scanStatusRecallTimer)
      pending.scanStatusRecallTimer = null
    }
  }

  async #onLoginStatusChange(e, botUserId, taskId, status = {}) {
    const pending = this.#pendingLogin(botUserId)
    if (!pending || pending.taskId !== taskId) {
      return
    }

    if (status.statusCode === 404) {
      pending.hasScanned = true

      if (!pending.scanStatusMessageId) {
        const scanReply = await e.reply('已扫码，请在手机上确认营地登录。若长时间未确认，本次登录会自动超时。')
        pending.scanStatusMessageId = scanReply?.message_id || ''
        pending.scanStatusRecallTimer = setTimeout(() => {
          void this.#recallMessage(e, pending.scanStatusMessageId)
            .finally(() => {
              pending.scanStatusMessageId = ''
            })
        }, LOGIN_SCAN_STATUS_RECALL_SECONDS * 1000)
      }
    }
  }

  /**
   * 二维码消息的引导文案。两条登录只有开头那句不一样（要不要点明「用手机 QQ」），
   * 撤回秒数和后半段完全一致，抽出来免得改一处漏一处。
   */
  #scanLoginPromptLines(scanHint) {
    return [
      `${scanHint}，二维码 3 分钟内有效，将在 ${LOGIN_QR_RECALL_SECONDS} 秒后自动撤回。`,
      SCAN_LOGIN_TAIL
    ]
  }

  /**
   * 两条扫码登录的公共前半程：查重 → 建会话 → 发二维码 → 登记 pending。
   *
   * ⚠️ 平台差异全由参数带进来，其中两条是**故意的、不许抹平**：
   *   · 发二维码失败时 QQ 要 close 掉外置浏览器会话并把异常咽掉；微信这条原本就
   *     不兜底（异常直接抛给框架），所以 `closeSessionOnReplyFail` 默认为假 —— 真抛
   *   · 建会话失败的文案两边不同（微信把 error.message 带给用户，QQ 给固定文案）
   *
   * @returns {Promise<{taskId: string, session: object}|null>} null 表示没发出去
   */
  async #beginScanLogin(e, botUserId, {
    createSession,
    logTag,
    taskIdSuffix = '',
    qrPromptLines,
    qrFailReply,
    closeSessionOnReplyFail = false
  }) {
    if (this.#pendingLogin(botUserId)) {
      await e.reply(LOGIN_BUSY_HINT)
      return null
    }

    let session
    try {
      session = await createSession()
    } catch (error) {
      logger.error(`${logTag} 生成二维码失败: ${error.message}`)
      await e.reply(qrFailReply(error))
      return null
    }

    const taskId = `${botUserId}:${taskIdSuffix}${Date.now()}`
    let qrReply = null
    try {
      qrReply = await e.reply([
        ...qrPromptLines,
        '\n',
        segment.image(`base64://${session.qrcodeBuffer.toString('base64')}`)
      ])
    } catch (error) {
      if (!closeSessionOnReplyFail) throw error
      await session.close()
      logger.error(`${logTag} 发送二维码失败: ${error.message}`)
      return null
    }

    const pendingInfo = {
      taskId,
      qrMessageId: qrReply?.message_id || '',
      scanStatusMessageId: '',
      hasScanned: false,
      scanStatusRecallTimer: null,
      recallTimer: setTimeout(() => {
        void this.#recallMessage(e, pendingInfo.qrMessageId)
          .finally(() => {
            pendingInfo.qrMessageId = ''
          })
      }, LOGIN_QR_RECALL_SECONDS * 1000)
    }
    pendingWechatLoginMap.set(botUserId, pendingInfo)

    return { taskId, session }
  }

  async wechatGlobalScanLogin(e) {
    const botUserId = e.user_id

    const started = await this.#beginScanLogin(e, botUserId, {
      createSession: () => createWechatLoginSession(),
      logTag: '[营地登录]',
      qrPromptLines: this.#scanLoginPromptLines('请扫描二维码完成营地登录'),
      qrFailReply: (error) => `生成营地登录二维码失败：${error.message}`
    })
    if (!started) return true

    void this.#awaitWechatLoginResult(e, botUserId, started.taskId, started.session)
    return true
  }

  async qqGlobalScanLogin(e) {
    const botUserId = e.user_id

    const started = await this.#beginScanLogin(e, botUserId, {
      createSession: () => createQQLoginSession(e),
      logTag: '[营地QQ登录]',
      taskIdSuffix: 'qq:',
      qrPromptLines: this.#scanLoginPromptLines('请用手机 QQ 扫描二维码完成营地登录'),
      qrFailReply: () => '生成营地登录二维码失败，请稍后重试',
      closeSessionOnReplyFail: true
    })
    if (!started) return true

    void this.#awaitQQLoginResult(e, botUserId, started.taskId, started.session)
    return true
  }

  /**
   * 两条扫码登录的公共后半程：等扫码 → 撤回二维码 → 落库回执 → 收尾清 pending。
   *
   * ⚠️ 收尾上的两处平台差异**按原样保留**：
   *   · QQ 一定要 close 会话（外置浏览器得收掉）；微信的会话由 wechatLogin 自己管，
   *     这里不 close
   *   · 没识别的错误 QQ 回固定文案，微信把 error.message 带给用户
   */
  async #awaitScanLoginResult(e, botUserId, taskId, session, {
    waitFor,
    logTag,
    unknownFailReply,
    closeSessionInFinally = false
  }) {
    const pending = this.#pendingLogin(botUserId)
    try {
      const result = await waitFor(session, {
        onStatusChange: (status) => {
          // ⚠️ 回调是**同步**调的，里面 `#onLoginStatusChange` 又有 `await e.reply(...)`，
          //    不接住的话回复失败（适配器报错 / 风控 / 发送超时）就是未捕获 rejection
          //    （Node 15+ 默认 throw）。同文件另外两处 void 都挂了 .finally，这里是遗漏。
          void this.#onLoginStatusChange(e, botUserId, taskId, status)
            .catch(error => logger.warn(`[营地登录] 处理扫码状态回调失败: ${error?.message || error}`))
        }
      })
      if (this.#pendingLogin(botUserId)?.taskId !== taskId) {
        return
      }

      await this.#recallLoginMessages(e, pending)

      await this.#commitGlobalLogin(e, botUserId, result)
    } catch (error) {
      if (this.#pendingLogin(botUserId)?.taskId !== taskId) {
        return
      }

      await this.#recallLoginMessages(e, pending)
      logger.error(`${logTag} 登录流程失败: ${error.message}`)

      await e.reply(this.#scanLoginFailMessage(error, pending, unknownFailReply))
    } finally {
      if (closeSessionInFinally) {
        await session.close()
      }
      if (this.#pendingLogin(botUserId)?.taskId === taskId) {
        this.#clearPendingLogin(botUserId)
      }
    }
  }

  /**
   * 扫码登录失败该说什么。QR_TIMEOUT 要分「扫了没确认」和「压根没扫」两种说法 ——
   * pending.hasScanned 就是 #onLoginStatusChange 收到 404 时打的标记。
   */
  #scanLoginFailMessage(error, pending, unknownFailReply) {
    if (error.code === 'QR_EXPIRED') return QR_EXPIRED_HINT
    if (error.code === 'QR_CANCELED') return QR_CANCELED_HINT
    if (error.code === 'QR_TIMEOUT') {
      return pending?.hasScanned ? QR_TIMEOUT_SCANNED_HINT : QR_TIMEOUT_HINT
    }
    return unknownFailReply(error)
  }

  async #awaitWechatLoginResult(e, botUserId, taskId, session) {
    return this.#awaitScanLoginResult(e, botUserId, taskId, session, {
      waitFor: waitForWechatLogin,
      logTag: '[营地登录]',
      unknownFailReply: (error) => `营地登录失败：${error.message}`
    })
  }

  async #awaitQQLoginResult(e, botUserId, taskId, session) {
    return this.#awaitScanLoginResult(e, botUserId, taskId, session, {
      waitFor: waitForQQLogin,
      logTag: '[营地QQ登录]',
      unknownFailReply: () => '营地登录失败，请稍后重试；若反复失败请反馈给主人',
      closeSessionInFinally: true
    })
  }

  async #commitGlobalLogin(e, botUserId, result) {
    const account = result.account || {}
    // ⚠️ ownerBotUserId 必须写：#营地观战 靠它认「这个号是谁扫的」，
    // 只把发起人自己扫的号拿去查好友。漏了这个字段，这个号在观战里就等于不存在。
    const savedAccount = authStore.upsertGlobalAccount({
      ...account,
      ownerBotUserId: botUserId
    })
    // 扫码即绑定：早先的「个人登录」就是「存登录态 + 顺手绑定」两件事，
    // 现在只留全局登录一条入口，把绑定并进来，用户不用再发一条 #绑定营地
    if (savedAccount.userId) {
      authStore.bindCampUserId(botUserId, savedAccount.userId)
      this.#syncShareAfterBind(botUserId)
    }
    // 全局账号是可以有多个的（轮询池），所以扫码后要报当前池子大小，
    // 否则主人扫第二个号时会以为把第一个覆盖了。
    const globalCount = authStore.listAccounts().filter(item => item.isGlobalDefault).length

    logger.info('[营地全局账号] 已通过扫码写入全局账号池', {
      botUserId,
      userId: savedAccount.userId,
      nickname: savedAccount.nickname || savedAccount.userName || '',
      globalCount
    })

    const lines = [
      '登录成功，已绑定这个营地号。',
      `\n营地ID：${savedAccount.userId || '未获取'}`,
      `\n昵称：${savedAccount.nickname || savedAccount.userName || '未命名'}`,
      '\n发送 #营地观战 看你营地好友里谁在打。',
      '\n有效期约 30 天，失效了重发这条指令。'
    ]
    // 池子大小只报给主人：他要靠这个数判断请求摊得够不够开，普通用户看了没用
    if (e.isMaster) {
      lines.splice(1, 0, `\n当前账号池共 ${globalCount} 个全局账号。`)
    }
    await e.reply(lines)
  }

  // ══════════════════ ⑤ 账号池运维（主人指令） ══════════════════

  async showAuthPool(e) {
    const overviewData = this.#collectAuthPoolOverview()

    try {
      const img = await this.#renderAuthPoolOverview(overviewData)
      await e.reply(img, shouldQuote())
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

  /**
   * 营地账号的显示名：优先游戏昵称，取不到退回营地昵称，都没有就只剩 ID。
   *
   * ⚠️ 目前**没有任何调用方**（全仓 grep 过，只剩定义）。保留是因为它名字没进 `fnc`
   *    但属于历史公开面，删掉怕别处按名字反射调用；要清理的话请主人确认后一起删。
   */
  async describeCampAccount(account) {
    const campUserId = String(account?.userId || '')
    if (!campUserId) return ''

    let roleName = ''
    try {
      const nameMap = await fetchRoleNames([campUserId], account.ownerBotUserId || '')
      roleName = nameMap[campUserId] || ''
    } catch (error) {
      logger.debug(`[营地账号] 获取 ${campUserId} 昵称失败: ${error.message}`)
    }

    const name = roleName || account.nickname || account.userName || ''
    return name ? `${campUserId} ${name}` : campUserId
  }

  async clearInvalidCampAuth(e) {
    const {
      removedAccounts = [],
      skippedGlobalAccounts = []
    } = authStore.clearInvalidAccounts()

    if (!removedAccounts.length && !skippedGlobalAccounts.length) {
      await e.reply(NO_INVALID_AUTH_HINT)
      return true
    }

    await e.reply(this.#buildClearInvalidReport(removedAccounts, skippedGlobalAccounts))
    return true
  }

  /**
   * 「清理失效营地账号」的结果报告。分两段：删掉的逐条列出来，跳过的单独说明
   * ——全局账号的失效标记要保留（那是主人的号，清了就没法用扫码恢复了）。
   */
  #buildClearInvalidReport(removedAccounts, skippedGlobalAccounts) {
    const lines = []

    if (removedAccounts.length) {
      lines.push(`已清理 ${removedAccounts.length} 个失效营地登录态。`)
      lines.push('这些账号只会从本地账号池移除，不会删除用户已绑定的营地ID：')
      lines.push(...removedAccounts.map((account, index) => {
        const nickname = account.nickname || '未命名'
        const ownerText = account.ownerBotUserId ? ` owner:${account.ownerBotUserId}` : ''
        return `${index + 1}. ${account.userId} ${nickname}${ownerText}`
      }))
    }

    if (skippedGlobalAccounts.length) {
      lines.push(
        removedAccounts.length ? '' : '本次未删除任何账号。',
        `已跳过 ${skippedGlobalAccounts.length} 个失效的全局账号，失效标记会保留，后续可通过【#营地wx全局登录】/【#营地QQ全局登录】或锅巴更新后恢复。`
      )
    }

    return lines.filter(Boolean).join('\n')
  }

  /**
   * #隐藏主页名单（主人）
   *
   * 列出被标注「隐藏了主页」的营地ID。这些号 24 小时内不会被主动查询
   * （战绩推送轮询、排位刷榜、日报周报、群报），但用户点名查的指令不受影响。
   */
  async showHiddenProfiles(e) {
    const list = listHiddenProfiles()

    if (!list.length) {
      await e.reply('当前没有被标注「隐藏了主页」的营地ID。', shouldQuote())
      return true
    }

    const lines = list.map((item, index) => {
      // 不足 1 小时也显示成 1，别出现「还有约 0 小时」
      const hours = Math.max(1, Math.ceil(item.remainMs / MS_PER_HOUR))
      const name = item.nickname ? ` ${item.nickname}` : ''
      return `${index + 1}. ${item.campId}${name} —— 还有约 ${hours} 小时`
    })

    await e.reply([
      `被标注「隐藏了主页」的营地ID（共 ${list.length} 个）：`,
      ...lines,
      '',
      '这些号 24 小时内不会被主动查询：战绩推送轮询、排位刷榜、日报周报、群报。',
      '用户点名查（#王者主页 / #查询战绩 等）不受影响。',
      '清除：#清除隐藏主页 <营地ID>，或 #清除隐藏主页 all'
    ].join('\n'), shouldQuote())
    return true
  }

  /** #清除隐藏主页 <营地ID|all>（主人） */
  async clearHiddenProfiles(e) {
    const arg = String(e.msg || '').replace(/^#清除隐藏主页\s*/, '').trim()

    if (!arg) {
      await e.reply('用法：#清除隐藏主页 <营地ID>，或 #清除隐藏主页 all', shouldQuote())
      return true
    }

    if (/^all$/i.test(arg)) {
      const count = clearAllHiddenProfiles()
      await e.reply(
        count
          ? `已清除全部 ${count} 条隐藏主页标注，下一次轮询会重新查询它们。`
          : '当前没有标注可清除。',
        shouldQuote()
      )
      return true
    }

    const campId = arg.replace(/[^\d]/g, '')
    if (!campId) {
      await e.reply('没认出营地ID（要纯数字），或用 all 清除全部。', shouldQuote())
      return true
    }

    const removed = clearHiddenProfile(campId)
    await e.reply(
      removed
        ? `已清除 ${campId} 的隐藏主页标注，下一次轮询会重新查询它。`
        : `${campId} 不在标注名单里。`,
      shouldQuote()
    )
    return true
  }
}
