/**
 * 「艾特查询」的目标解析。
 *
 * 背景：QQ 客户端不一定会把 @ 发成 at 消息段 —— 从候选列表里点出来的是真 at
 * （raw_message 里有 [CQ:at,qq=xxx]，Yunzai 会填 e.at），但手打或粘贴出来的
 * 「@昵称」到 Bot 这边只是一段纯文本，e.at 是空的。更麻烦的是这段文本顶在指令
 * 前面，指令正则的 ^# 锚点直接匹配不上，整条消息不会有任何插件响应。
 *
 * 所以两种形态都得认：真 at 段取 e.at，纯文本 @昵称 去群成员列表里反查 QQ 号。
 * 正则那头用 AT_HEAD / AT_TAIL 替掉原来的 ^ 和 $，让指令前后能挂这段文本。
 */

// 昵称可能带空格（如「AAA大史山批发 (跑路版)」），所以一路吃到 # 为止
const AT_TEXT_HEAD_RE = /^\s*@([^#]*?)\s*(?=#)/
const AT_TEXT_TAIL_RE = /\s*@([^#]*?)\s*$/

// QQ 号是 5-12 位纯数字，够长的纯数字就直接当 QQ 号用，不必去查群成员
const QQ_NUMBER_RE = /^\d{5,12}$/

/**
 * 指令正则前缀，替代原来的 ^：允许指令前面挂一段纯文本 @昵称。
 * 这段 @ 必须紧贴着 # 才算（`@昵称 #王者主页` 认，`@昵称 你查战绩了吗` 不认），
 * 否则群里随便一句以 @ 开头、又刚好带「查…战绩」的闲聊就会被当成指令。
 */
export const AT_HEAD = '(?:^\\s*@[^#]*(?=#)|^)'

/** 指令正则后缀，替代原来的 $：允许指令后面跟一段纯文本 @昵称 */
export const AT_TAIL = '\\s*(?:@[^#]*)?$'

/** 取出纯文本 @ 的那段昵称/QQ号，没有则返回空串 */
export function pickAtText (msg = '') {
  const text = String(msg || '')
  const matched = text.match(AT_TEXT_HEAD_RE) || text.match(AT_TEXT_TAIL_RE)
  return matched ? matched[1].trim() : ''
}

/** 去掉纯文本 @ 的那一段，返回干净的指令文本，各指令再拿它解析参数 */
export function stripAtText (msg = '') {
  return String(msg || '')
    .replace(AT_TEXT_HEAD_RE, '')
    .replace(AT_TEXT_TAIL_RE, '')
    .trim()
}

/** 群成员列表：优先用 Bot 的缓存（cache_group_member），没有再拉一次 */
async function getMemberMap (e) {
  const cached = e?.bot?.gml?.get?.(e.group_id)
  if (cached?.size) return cached

  try {
    const map = await e?.group?.getMemberMap?.()
    if (map?.size) return map
  } catch (err) {
    logger?.debug?.(`[艾特查询] 拉取群成员列表失败: ${err.message}`)
  }

  return null
}

/** 拿群名片/昵称反查 QQ 号，找不到返回空串 */
async function findMemberByName (e, name) {
  const map = await getMemberMap(e)
  if (!map) return ''

  const key = name.toLowerCase()
  // 「@昵称 后面还跟了别的话」时 key 会比昵称长，取能对上的最长名字
  let prefixHit = { userId: '', length: 0 }

  for (const [userId, info] of map) {
    for (const raw of [info?.card, info?.nickname]) {
      const candidate = String(raw || '').trim().toLowerCase()
      if (!candidate) continue
      if (candidate === key) return String(userId)
      if (key.startsWith(candidate) && candidate.length > prefixHit.length) {
        prefixHit = { userId: String(userId), length: candidate.length }
      }
    }
  }

  return prefixHit.userId
}

/**
 * 解析这条指令要查谁：真 at 段 > 纯文本 @昵称/@QQ号 > 发送者自己。
 * @param {object} e 消息事件
 * @param {object} [opts]
 * @param {boolean} [opts.requireMaster] 只允许主人查别人（账号管理类指令用）
 * @returns {Promise<{userId: string, hint: string}>} hint 非空表示 @ 了人但没认出来，直接回给用户
 */
export async function resolveTargetUserId (e, { requireMaster = false } = {}) {
  const self = String(e.user_id)
  const canQueryOthers = !requireMaster || Boolean(e.isMaster)

  // e.atme 是部分 Yunzai 分支给的「@的是Bot自己」标记，TRSS 用的是 e.atBot（不会写进 e.at）
  if (e.at && !e.atme) {
    return { userId: canQueryOthers ? String(e.at) : self, hint: '' }
  }

  const name = pickAtText(e.msg)
  if (!name || !canQueryOthers) return { userId: self, hint: '' }

  if (QQ_NUMBER_RE.test(name)) return { userId: name, hint: '' }

  const found = await findMemberByName(e, name)
  if (found) return { userId: found, hint: '' }

  return {
    userId: self,
    hint: `没找到「${name}」这个人，请从 @ 列表里点选对方再发一次，或直接在指令后带上营地ID`
  }
}
