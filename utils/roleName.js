import { ApiService, cache } from '#utils'
import { cleanName } from './rankStore.js'
import { mapConcurrent } from './parallel.js'

// 拿一次昵称要打营地接口，命中缓存就不用再打；空结果单独压短一点
const ROLE_NAME_TTL = 600
const EMPTY_ROLE_NAME_TTL = 60

/**
 * 按营地ID批量取游戏昵称与营地头像。
 *
 * 两者只有 profile 接口这一个来源：昵称是**游戏角色名**（不是营地登录账号的昵称），
 * 头像是营地头像——官方机器人拿不到 QQ 头像（user_id 是 openid 形态），
 * 展示层一律用营地头像，所以跟着昵称一起取，省一轮往返。
 *
 * 单个 ID 查失败只留空，不抛错 —— 展示层自己决定退回什么文案。
 * @param {Array<string|number>} ids 营地ID列表
 * @param {string|number} botUserId 属主，决定用谁的登录态去查
 * @returns {Promise<Object>} { [营地ID]: { name: string, icon: string } }
 */
export async function fetchRoleIdentities (ids = [], botUserId = '') {
  const identityMap = {}

  // 并发查：命中缓存的当场返回，没命中的那几发交给 api 层轮着分给不同账号
  await mapConcurrent(ids, async (id) => {
    const campId = String(id || '')
    if (!campId) return

    const cacheKey = `gok:roleName:${campId}`
    const cached = cache.get(cacheKey)
    if (cached !== undefined) {
      // 这个键在早期版本里只存昵称字符串，兼容一下；TTL 到期后自然被对象取代
      identityMap[campId] = typeof cached === 'string' ? { name: cached, icon: '' } : cached
      return
    }

    let info = { name: '', icon: '' }
    try {
      const profile = await ApiService.getProfile(campId, String(botUserId || ''))
      const { roleList = [], targetRoleId } = profile?.data || {}
      const role = roleList.find(item => item.roleId === targetRoleId) || roleList[0]
      // 昵称必须清洗：营地昵称里常带私有区图标（大神认证、赛事标）和不可见字符，
      // 换到别的字体就是豆腐块、或者整行看着空白。规则和排名快照那一路共用，
      // 否则同一个号「走快照」和「走补查」会显示成两个样子。
      info = { name: cleanName(role?.roleName), icon: role?.roleIcon || '' }
    } catch (error) {
      logger.debug(`[营地ID] 获取 ${campId} 游戏昵称失败: ${error.message}`)
    }

    // 空结果只压 60 秒：刚绑定还没登录态时拉不到昵称，压 10 分钟会让 ID 一直裸奔
    cache.set(cacheKey, info, info.name ? ROLE_NAME_TTL : EMPTY_ROLE_NAME_TTL)
    identityMap[campId] = info
  })

  return identityMap
}

/**
 * 只要昵称的老接口，给「营地ID 旁边显示是谁」那几处用。
 * @param {Array<string|number>} ids 营地ID列表
 * @param {string|number} botUserId 属主，决定用谁的登录态去查
 * @returns {Promise<Object>} { [营地ID]: 游戏昵称 }
 */
export async function fetchRoleNames (ids = [], botUserId = '') {
  const identityMap = await fetchRoleIdentities(ids, botUserId)
  const nameMap = {}
  for (const [campId, info] of Object.entries(identityMap)) nameMap[campId] = info.name
  return nameMap
}
