/**
 * 单场战绩详情图。
 *
 * 这块逻辑原先长在 apps/queryGameStats.js 里，现在战绩推送也要发同样的详情图，
 * 所以抽出来共用。两边的调用方式：
 *   #查询战绩 N  -> fetchBattleDetail() + renderBattleDetail()
 *   战绩推送     -> 同上，只是数据来自轮询而不是用户指令
 *
 * localImg / resolveMvp / resolveEvaluate 也一并搬来，因为战绩「列表图」还要用它们
 * （queryGameStats 的 toListItem）。
 */
import fs from 'node:fs'
import path from 'path'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { PluginPath } from '#components'
import ApiService from './api.js'

// 评价图标分两套，同一场高分局会同时下发：
//   分路评价 —— custom_wzry_battledetail_tags/<md5>.png，198×48 长条，图上直接印着「档位 + 分路」
//   角色奖牌 —— evaluateV3/<档位>_<职业>.png（V2）、evaluate-v2/<档位>_<职业>_<n>.png（V1），180×48
// 两者档位并不同步（同一场可能是铜牌打野 + 银牌坦克），所以不能用奖牌去反推分路评价。
// 分路评价共 20 张（顶级/金牌/银牌/铜牌 × 5 分路），文件名是无规律哈希，逐张下载核对后登记在
// 下表并存到 resources/img/branch_<档位>_<分路>.png。列表接口的 branchEvaluate 只覆盖金银两档
// （奇数金、偶数银，按对抗/中/发育/打野/游走 成对排），顶级和铜牌一律为 0，没法当判据。
const BRANCH_TAG_RE = /custom_wzry_battledetail_tags/
const BRANCH_TAGS = {
  '5db4fef1bfc72dd2c5ae71b01ef3951b': ['top', 'warrior'],
  '4b4f396f8e6d18bdf8bf699b8c5d9be4': ['top', 'mid'],
  '926ba0111984464ad46e72dc93157fcd': ['top', 'marksman'],
  '9eb904626303912a65d9b69bc8d88aa9': ['top', 'jungle'],
  'a8b5101bc81ae64cf96c67ed1ab21975': ['top', 'roam'],
  c30089b8daf9a4792f85c8a6d97a3e9c: ['gold', 'warrior'],
  f63de8a7f98863ab3a34aada6bc4bd6f: ['gold', 'mid'],
  c717aab51e99a4bfa9c6d2e024e97512: ['gold', 'marksman'],
  '5142af35177e111837efbf85071f373b': ['gold', 'jungle'],
  '1147db2cd2a46031783a9a0fc34f7f3c': ['gold', 'roam'],
  '116bb42c52b7d83b9d80ac9dd9580607': ['silver', 'warrior'],
  a2c96893471637e5cf5c0a1e2c9829f3: ['silver', 'mid'],
  '7577421618c781e7a59b81904937a8a0': ['silver', 'marksman'],
  '39d8211165f3730700fc6db10abd170e': ['silver', 'jungle'],
  '977937945942799fd618773e5c378d3a': ['silver', 'roam'],
  e8602ae4b427f06dd1349438fbeab68f: ['bronze', 'warrior'],
  '029706c958a71f2aa5c187e2ef021430': ['bronze', 'mid'],
  af6fd95b08fd1b58340b48374707262c: ['bronze', 'marksman'],
  c8a09fe55b4614d0307a6161f32ae479: ['bronze', 'jungle'],
  '3159d2f1733203167a9a3d5d3e4656ad': ['bronze', 'roam']
}
const BRANCH_TIER = { top: '顶级', gold: '金牌', silver: '银牌', bronze: '铜牌' }
const BRANCH_LANE = { warrior: '对抗路', mid: '中路', marksman: '发育路', jungle: '打野', roam: '游走' }
// 奖牌逐个探测确认过：只有 gold、silver 两档，职业 6 种，没有铜牌
const MEDAL_RE = /\/(gold|silver)_(warrior|archer|mage|support|assassin|tank)(?:_\d+)?\.png/
const MEDAL_TIER = { gold: '金牌', silver: '银牌' }
const MEDAL_ROLE = { warrior: '战士', archer: '射手', mage: '法师', support: '辅助', assassin: '刺客', tank: '坦克' }

// 图标全部落地到本地，避免渲染时等远程 CDN；缺图时回退接口给的远程地址
const IMG_DIR = path.join(PluginPath, 'resources', 'img')
let LOCAL_IMGS = new Set()
try {
  LOCAL_IMGS = new Set(fs.readdirSync(IMG_DIR))
} catch (err) {
  logger.error(`[战绩详情] 读取图标目录失败: ${err.message}`)
}

export const localImg = (name, fallback = '') =>
  LOCAL_IMGS.has(name) ? `file://${path.join(IMG_DIR, name)}` : fallback

/**
 * 全场最佳。mvp.png 是胜方，svp.png 是败方，图上都印着 MVP，只是配色不同。
 * @returns {{ label: string, icon: string }}
 */
export function resolveMvp ({ mvpUrlV3, mvpUrlV2 } = {}) {
  const url = mvpUrlV3 || mvpUrlV2
  if (!url) return { label: '', icon: '' }
  const isSvp = /svp/i.test(url)
  return {
    label: isSvp ? 'SVP' : 'MVP',
    icon: localImg(isSvp ? 'svp.png' : 'mvp.png', url)
  }
}

/**
 * 解析评价图标。分路评价比角色奖牌具体（带档位和分路），优先用。
 * 之前只认 5 个顶级哈希，金/银/铜分路的哈希对不上就整个标签丢空，
 * 表现出来就是「顶级以下的评分不显示」。
 * @param {Array<string|undefined>} urls 候选图标 URL，按 V3 -> V2 -> V1 顺序传入
 * @returns {{ label: string, icon: string }}
 */
export function resolveEvaluate (urls) {
  const list = (urls || []).filter(Boolean)

  const branchUrl = list.find(u => BRANCH_TAG_RE.test(u))
  if (branchUrl) {
    const [tier, lane] = BRANCH_TAGS[branchUrl.match(/([0-9a-f]{32})\.png/)?.[1]] || []
    if (tier) {
      return {
        label: `${BRANCH_TIER[tier]}${BRANCH_LANE[lane]}`,
        icon: localImg(`branch_${tier}_${lane}.png`, branchUrl)
      }
    }
    // 新出的图没登记过：图上本来就印着文案，直接挂远程地址，别把标签丢空
    logger.debug(`[战绩详情] 未登记的分路评价图标: ${branchUrl}`)
    return { label: '分路评价', icon: branchUrl }
  }

  const medal = list.map(u => MEDAL_RE.exec(u)).find(Boolean)
  if (medal) {
    const [, tier, role] = medal
    return {
      label: `${MEDAL_TIER[tier]}${MEDAL_ROLE[role]}`,
      icon: localImg(`${tier}_${role}.png`, medal.input)
    }
  }

  return { label: '', icon: '' }
}

/**
 * 拉单场战绩详情。
 *
 * 需要的参数全在战绩列表项里，不用额外请求：battleType / gameSvrId / relaySvrId / gameSeq，
 * 以及从 battleDetailUrl 里正则抠出来的 toAppRoleId（就是详情接口要的 targetRoleId）。
 *
 * @param {string|number} ID 营地ID
 * @param {object} battle 战绩列表里的一项
 * @param {string} requesterBotUserId 属主QQ，authStore 按它取鉴权候选，不能省
 * @returns {Promise<object|null>} 详情数据，失败返回 null
 */
export async function fetchBattleDetail (ID, battle, requesterBotUserId = '') {
  const { battleType, gameSvrId, relaySvrId, gameSeq, battleDetailUrl } = battle || {}
  const targetRoleId = String(battleDetailUrl || '').match(/toAppRoleId=(\d+)/)?.[1]

  let detail
  try {
    ({ data: detail } = await ApiService.getBattledetail(
      ID, battleType, gameSvrId, relaySvrId, targetRoleId, gameSeq, requesterBotUserId
    ))
  } catch (error) {
    logger.error(`[战绩详情] 获取详情失败: ${error.message}`)
    return null
  }

  if (!detail) {
    logger.error('[战绩详情] 获取战斗详情失败：接口返回空数据')
    return null
  }

  if (!detail?.head?.acntCamp) {
    logger.error('[战绩详情] 战斗详情数据不完整，缺少acntCamp字段')
    return null
  }

  return detail
}

/** 渲染单场战绩详情图 */
export async function renderBattleDetail ({ head, battle, redTeam, blueTeam, redRoles, blueRoles }) {
  const isBlue = head.acntCamp === blueTeam.acntCamp
  const [myTeam, enemyTeam] = isBlue ? [blueTeam, redTeam] : [redTeam, blueTeam]
  const [myRoles, enemyRoles] = isBlue ? [blueRoles, redRoles] : [redRoles, blueRoles]

  // 为每个玩家补上评价图标。详情接口的 mvp 只是布尔值，没给图，按胜负自己挑 MVP / SVP
  const myWin = !!head.gameResult
  for (const [roles, win] of [[myRoles, myWin], [enemyRoles, !myWin]]) {
    for (const role of roles) {
      const bs = role.battleStats
      if (!bs) continue
      const { label, icon } = resolveEvaluate([bs.evaluateIconV3, bs.evaluateIconV2, bs.evaluateIcon])
      bs.evalTag = label
      bs.evalIcon = icon
      if (bs.mvp) {
        bs.mvpTag = win ? 'MVP' : 'SVP'
        bs.mvpIcon = localImg(win ? 'mvp.png' : 'svp.png')
      }
    }
  }

  return puppeteer.screenshot('QueryGameRecordDetails', {
    tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordDetails.html',
    gameResult: head.gameResult ? '胜利' : '失败',
    gameResultEn: head.gameResult ? 'VICTORY' : 'DEFEAT',
    myTeamColor: isBlue ? '蓝' : '红',
    enemyTeamColor: isBlue ? '红' : '蓝',
    ...getTeamData(myTeam, enemyTeam, myRoles, enemyRoles, head, battle)
  })
}

const getTeamData = (myTeam, enemyTeam, myRoles, enemyRoles, head, battle) => ({
  tips: head.tips,
  mapName: head.mapName,
  startTime: battle.startTime,
  usedTime: ~~(battle.usedTime / 60),
  matchDesc: head.matchDesc,
  myEconomyRate: (myTeam.money / (myTeam.money + enemyTeam.money)) * 100,
  myMoney: formatMoney(myTeam.money),
  myTowerCnt: myTeam.towerCnt,
  enemyMoney: formatMoney(enemyTeam.money),
  enemyTowerCnt: enemyTeam.towerCnt,
  myKillDeadAssistCnt: `${myTeam.killCnt}/${myTeam.deadCnt}/${myTeam.assistCnt}`,
  enemyKillDeadAssistCnt: `${enemyTeam.killCnt}/${enemyTeam.deadCnt}/${enemyTeam.assistCnt}`,
  myRoles,
  enemyRoles,
  ...getBanData(myTeam, enemyTeam),
  ...getDragonStats(myTeam, enemyTeam)
})

/**
 * 禁用英雄（BP 的 ban 那半）。
 *
 * 只取 ban：pick 那半在下面的双方阵容里已经有了，实测 pickHeros 和各玩家的
 * battleRecords.usedHero 完全一致（只是顺序不同），再单独列一排是重复信息。
 *
 * 注意别拿 banCnt 去截断 banHeros：实测某局 banHeros 是 5 个而 banCnt=3，两者不是一回事。
 * 图片只有 heroIcon 有值，verticalIcon / skinIcon128128 等一律是空串。
 * 娱乐模式等没有 BP 阶段的对局 banHeros 是空数组，此时整个区块隐藏（hasBan）。
 */
const getBanData = (myTeam, enemyTeam) => {
  const pick = team => (team?.banHeros || []).filter(h => h?.heroIcon || h?.heroName)
  const myBanHeros = pick(myTeam)
  const enemyBanHeros = pick(enemyTeam)

  return {
    myBanHeros,
    enemyBanHeros,
    hasBan: myBanHeros.length > 0 || enemyBanHeros.length > 0
  }
}

const formatMoney = money => money > 1000 ? `${(money / 1000).toFixed(1)}k` : money

const getDragonStats = (my, enemy) => ({
  myBdragon1: my.bdragon1, myBdragon2: my.bdragon2, myBdragon3: my.bdragon3,
  myLdragon1: my.ldragon1, myLdragon2: my.ldragon2,
  enemyBdragon1: enemy.bdragon1, enemyBdragon2: enemy.bdragon2, enemyBdragon3: enemy.bdragon3,
  enemyLdragon1: enemy.ldragon1, enemyLdragon2: enemy.ldragon2
})
