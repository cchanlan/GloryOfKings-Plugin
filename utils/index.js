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
import {
  isProfileHidden,
  markProfileHidden,
  listHiddenProfiles,
  clearHiddenProfile,
  clearAllHiddenProfiles,
  HIDDEN_TTL_MS
} from './hiddenProfiles.js'
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
import {
  getBlackList,
  isBlackUser,
  isBlockedEvent,
  addBlackUser,
  removeBlackUser,
  followGlobalBlack,
  getHostBlackList
} from './blackList.js'
import { getImgType } from './imageType.js'
import { Config } from '#components'

export {
  // 出图格式（锅巴「输出图片类型」）。37 处出图统一从这里取，别在各 app 里写死 ——
  // 详见 utils/imageType.js 顶部关于「微信下 webp 会变成文件」的说明
  getImgType,
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
  isProfileHidden,
  markProfileHidden,
  listHiddenProfiles,
  clearHiddenProfile,
  clearAllHiddenProfiles,
  HIDDEN_TTL_MS,
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
  Button,
  getBlackList,
  isBlackUser,
  isBlockedEvent,
  addBlackUser,
  removeBlackUser,
  followGlobalBlack,
  getHostBlackList
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

/**
 * 本地绑定表的读取在这里，实现在 utils/localBind.js。
 * 单独一个文件是为了避开和共享库（utils/shareStore.js）之间的循环依赖——
 * 共享库要靠「本地优先」判断该不该去查，这边又要转出共享库的接口。
 */
export { getCurrentId, getBoundIds, readUserData } from './localBind.js'

/**
 * 营地ID 共享库客户端。
 *
 * ⚠️ `resolveCurrentId` 是**异步**的，只该用在「用户当场发的查询指令」里。
 * 推送、排行榜、`#谁在打游戏`、日报周报一律继续用同步的 getCurrentId——
 * 那些路径要么在同步的 read-modify-write 块里，要么会把营地ID 固化进订阅文件。
 * 详细理由见 utils/shareStore.js 顶部注释。
 */
export {
  resolveCurrentId,
  resolveUserData,
  maskToken,
  invalidateShareCache,
  isShareReady,
  readShareConfig,
  getShareStatus,
  getCacheInfo,
  pushBind,
  revokeBind,
  probeShare,
  reconcileNow,
  querySharedBind,
  dropAdoptedBind,
  resetCircuitBreaker,
  NOT_BOUND_HINT,
  SHARE_DEGRADED_HINT
} from './shareStore.js'

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

