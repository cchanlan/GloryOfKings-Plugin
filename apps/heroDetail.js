/**
 * 英雄详情：一个英雄的生涯场次胜率、近一个月荣誉、荣耀战力趋势、表现五维、最近对局。
 *
 * 数据源只有一个：营地 `/gametoolbox/hero/record/pagedetails`（`ApiService.getHeroRecordDetails`），
 * 一次请求就把整页数据全给了 —— 对比 `#查战绩` 那套「翻最多 10 页再筛」快一个量级，
 * 而且场次/胜率是**全生涯**口径（`#查战绩` 只能统计到翻到的那 100 场）。
 *
 * 这个接口要的是**角色 roleId**（`getProfile().data.targetRoleId`），不是营地ID，
 * 所以链路是 profile → pagedetails 两次请求，和其他 roleId 系接口一样。
 */
import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import {
  getImgType,
  ApiService, Button, AT_HEAD, stripAtText, resolveTargetUserId, resolveUserData,
  shouldQuote, getUserAvatar, resolveMemberName, isQQNumber
} from '#utils'
import { PluginPath } from '#components'
import { resolveHero } from '../utils/heroName.js'
import { buildHeroDetail } from '../utils/heroDetail.js'
import { privacyScope } from '../utils/seasonFallback.js'

export class HeroDetail extends plugin {
  constructor () {
    super({
      name: '查询王者英雄详情',
      dsc: '单个英雄的场次胜率、战力趋势、表现五维与最近对局',
      event: 'message',
      // 0 是为了抢在 queryGameStats 那几条宽匹配前面（见该文件顶部注释）
      priority: 0,
      rule: [
        {
          reg: `${AT_HEAD}#(王者)?英雄详情\\s*(.*)$`,
          fnc: 'heroDetail'
        }
      ]
    })
  }

  async heroDetail (e) {
    // 指令后面可以混着写英雄名和营地ID：营地ID是 5 位以上，4 位以内当绑定列表序号
    let heroInput = ''
    let campId = ''
    let slot = 0
    for (const tok of stripAtText(e.msg).replace(/^#(王者)?英雄详情\s*/, '').trim().split(/[\s,，、]+/).filter(Boolean)) {
      if (/^\d+$/.test(tok)) {
        if (tok.length >= 5) campId = tok
        else slot = Number(tok)
        continue
      }
      heroInput += tok
    }

    if (!heroInput) {
      await e.reply('请输入英雄名称，例如：#英雄详情 孙权', shouldQuote())
      return
    }

    let heroId, matchedName
    try {
      const hit = await resolveHero(heroInput)
      heroId = hit.heroId
      matchedName = hit.matchedName
    } catch (err) {
      await e.reply(err.message)
      return
    }

    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint)

    const userData = await resolveUserData(userId)
    const userInfo = userData[userId]

    if (!campId) {
      if (slot) {
        campId = userInfo?.ids?.[slot - 1] || ''
        if (!campId) {
          await e.reply(`序号无效，你当前只绑定了 ${userInfo?.ids?.length || 0} 个营地ID`)
          return
        }
      } else {
        campId = userInfo?.ids?.[userInfo.current || 0] || ''
      }
    }

    if (!campId) {
      await e.reply([
        segment.image(path.join(PluginPath, 'resources', 'img', '营地ID获取.png')),
        Button.bind()
      ], shouldQuote())
      return
    }

    let detail
    try {
      detail = await this.fetchDetail(campId, heroId, matchedName, userId, e)
    } catch (error) {
      logger.error(`[英雄详情] 查询 ${campId}/${matchedName} 失败: ${error.message}`)
      await e.reply(ApiService.formatUserFacingError(error, {
        isMaster: Boolean(e.isMaster),
        scene: '英雄详情查询异常'
      }))
      return
    }

    if (detail === null) {
      await e.reply(`该账号没有 ${matchedName} 的对局记录`)
      return
    }
    if (typeof detail === 'string') {
      await e.reply(detail, shouldQuote())
      return
    }

    const qqAvatar = await getUserAvatar(e, userId)
    const nickname = String(userId) !== String(e.user_id)
      ? await resolveMemberName(e.group, userId)
      : (e.sender?.card || e.sender?.nickname || e.nickname || (isQQNumber(userId) ? String(userId) : '召唤师'))

    const img = await puppeteer.screenshot('HeroDetail', {
      imgType: getImgType(),
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/HeroDetail.html',
      _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
      qqAvatar,
      nickname,
      ydId: String(campId),
      ...detail
    })

    await e.reply([img, Button.heroDetail(matchedName, campId)], shouldQuote())
  }

  /**
   * profile → pagedetails，整理成模板数据。
   * @returns {Promise<object|null|string>} 数据 / null（没玩过）/ 字符串（要直接回给用户的话）
   */
  async fetchDetail (campId, heroId, matchedName, userId, e) {
    const profile = await ApiService.getProfile(campId, String(userId))
    const roleId = profile?.data?.targetRoleId

    if (!roleId) {
      // 主页被隐藏时 data 是空的，别一律回「获取角色信息失败」，那会让人以为是插件坏了
      const hiddenScope = privacyScope(profile?.returnCode)
      return hiddenScope ? `对方隐藏了${hiddenScope}，英雄详情查不到` : '未获取到角色信息，请检查营地ID是否正确'
    }

    const role = (profile.data.roleList || []).find(r => String(r.roleId) === String(roleId)) || {}

    const res = await ApiService.getHeroRecordDetails(
      roleId,
      heroId,
      { roleName: role.roleName || '', serverId: role.serverId || '' },
      campId,
      String(userId)
    )

    return buildHeroDetail(res?.data, { fallbackName: matchedName })
  }
}
