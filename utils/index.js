import ApiService from './api.js'
import {
  readJsonFile,
  writeJsonFile,
  getFilePath,
  getLocalImage,
  cleanImageCache,
  scanImageCache,
  resolveCacheMaxBytes,
  DEFAULT_CACHE_MAX_MB
} from './fileUtils.js'
import {
  readYamlFile,
  writeYamlFile
} from './yamlUtils.js'
import cache from './cache.js'
import authStore from './authStore.js'
import { getUserAvatar, getGroupAvatar, qlogoUrl, groupQlogoUrl, isQQNumber } from './avatar.js'
import { normalizeId, pickGroupSafe, pickMemberSafe, resolveMemberName } from './adapter.js'
import { AT_HEAD, AT_TAIL, pickAtText, stripAtText, resolveTargetUserId } from './atTarget.js'
import { getPvpSkinCover, getPvpHeroSkins } from './pvpSkinImage.js'
import {
  getCampSkinConf, getCampHeroSkins, isClassicSkin,
  SZ_ORDER, TIER_PRIORITY, tierRank, pickTierText, QUALITY_STATS, countQuality
} from './skinCatalog.js'
import {
  createWechatLoginSession,
  waitForWechatLogin,
  decodeEncodeResUserKey
} from './wechatLogin.js'
import Button from './button.js'
import path from 'path'
import { PluginData, Config } from '#components'

export {
  ApiService,
  readJsonFile,
  writeJsonFile,
  getFilePath,
  getLocalImage,
  cleanImageCache,
  scanImageCache,
  resolveCacheMaxBytes,
  DEFAULT_CACHE_MAX_MB,
  readYamlFile,
  writeYamlFile,
  cache,
  authStore,
  getUserAvatar,
  getGroupAvatar,
  qlogoUrl,
  groupQlogoUrl,
  isQQNumber,
  normalizeId,
  pickGroupSafe,
  pickMemberSafe,
  resolveMemberName,
  AT_HEAD,
  AT_TAIL,
  pickAtText,
  stripAtText,
  resolveTargetUserId,
  getPvpSkinCover,
  getPvpHeroSkins,
  getCampSkinConf,
  getCampHeroSkins,
  isClassicSkin,
  SZ_ORDER,
  TIER_PRIORITY,
  tierRank,
  pickTierText,
  QUALITY_STATS,
  countQuality,
  createWechatLoginSession,
  waitForWechatLogin,
  decodeEncodeResUserKey,
  Button
}

/**
 * 回复时是否引用触发指令那条消息，对应锅巴开关 config.quoteReply。
 * 改配置即时生效（Config 有文件监听会清缓存），读不到配置时按旧行为引用。
 * @returns {boolean} 传给 e.reply 的第二个参数
 */
export function shouldQuote () {
  try {
    return Config.getDefOrConfig('config')?.quoteReply !== false
  } catch {
    return true
  }
}

export function getCurrentId (userId) {
  const filePath = path.join(PluginData, 'UserData.yaml')
  const userData = readYamlFile(filePath)

  if (!userData[userId] || !userData[userId].ids.length) {
    return null
  }

  return userData[userId].ids[userData[userId].current]
}

/**
 * 解析「表现」类指令后面跟的参数，营地ID / 赛季号 / 数量 / all 混着写也能认出来。
 * 判定依据：s 开头是赛季号；纯数字 5 位以上是营地ID（营地ID都是 8~10 位），4 位以内是数量/赛季号。
 * @param {string} input 去掉指令前缀后的内容，如 "s40"、"1580886057 5"、"all"
 * @returns {{campId: string, season: number|null, count: number|null, all: boolean}}
 */
export function parsePerfArgs (input = '') {
  const out = { campId: '', season: null, count: null, all: false }
  let rest = String(input || '').trim()
  if (!rest) return out

  // 赛季号 s40 / S40，允许和营地ID连写（#排位表现1580886057s40）
  const sm = rest.match(/[sS](\d{1,3})(?!\d)/)
  if (sm) {
    out.season = Number(sm[1])
    rest = rest.replace(sm[0], ' ')
  }

  if (/all|全部/i.test(rest)) {
    out.all = true
    rest = rest.replace(/all|全部/gi, ' ')
  }

  for (const tok of rest.split(/[\s,，、]+/).filter(Boolean)) {
    if (!/^\d+$/.test(tok)) continue
    if (tok.length >= 5) out.campId = tok
    else if (out.count === null) out.count = Number(tok)
  }

  return out
}

/** 把赛季名（S44）转成数字，用于和用户输入的赛季号比对 */
export function seasonNo (seasonName) {
  const digits = String(seasonName || '').replace(/[^\d]/g, '')
  return digits ? Number(digits) : null
}

