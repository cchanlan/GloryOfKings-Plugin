import fs from 'node:fs'
import path from 'node:path'
import { PluginData } from '#components'
import { parseHeroPower } from './heroPowerColor.js'

const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_VERSION = 4
const MAX_CACHE_ENTRIES = 128
const MAX_DETAIL_LOOKUPS = 3
const services = new WeakMap()
const copy = value => JSON.parse(JSON.stringify(value))
const matchCount = value => ((typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) && Number.isSafeInteger(Number(value)) && Number(value) >= 0) ? Number(value) : null
// 营地曲线日期是北京时间的 MM-DD，不用宿主机的本地日界线。
const campDate = ms => new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(5, 10)
const successData = result => (result?.returnCode == null || Number(result.returnCode) === 0) ? result?.data : undefined

export const DEFAULT_MY_HERO_COUNT = 10
export const compareMyHeroRows = (a, b) => b.displayPower - a.displayPower || b.playNum - a.playNum

function readProfileRate (profile) {
  const mods = profile?.head?.mods
  const rate = Array.isArray(mods) ? mods.find(mod => Number(mod?.modId) === 409)?.content : null
  return typeof rate === 'string' && /^\d{1,3}(?:\.\d+)?%$/.test(rate) && Number(rate.slice(0, -1)) <= 100 ? rate : ''
}

async function optionalLookup (label, lookup) {
  try {
    return successData(await lookup())
  } catch (error) {
    globalThis.logger?.warn?.(`[我的英雄] ${label}暂不可用：${error.message}`)
    return undefined
  }
}

function fillCurrentPower (heroes, list, source, openEntry = hero => hero) {
  if (!Array.isArray(list)) return
  for (const raw of list) {
    const entry = openEntry(raw)
    const row = heroes.get(String(entry?.heroId))
    const power = parseHeroPower(entry?.heroFightPower)
    if (!row || row.seasonPower != null || power == null || (power === 0 && source !== 'season-list')) continue
    row.seasonPower = power
    row.seasonPowerSource = source
    row.displayPower = row.historyPower || power
  }
}

/** 原生英雄页的场次为生涯胜负场；赛季列表的同名字段不能代替它。 */
function readCareerRows (result, roleId) {
  const data = result?.data ?? result
  if ((result?.returnCode != null && Number(result.returnCode) !== 0) || !Array.isArray(data?.heroData)) {
    throw new Error('营地生涯英雄数据暂时不可用，请稍后重试')
  }
  if (Number(data.isHideMatch || data.isHideMatchDetail || 0) !== 0) {
    throw new Error('对方隐藏了英雄战绩，无法查看我的英雄')
  }
  const seen = new Set()
  const heroes = []
  let ownCount = 0
  for (const hero of data.heroData) {
    const id = String(hero?.heroId || '')
    const owned = hero?.notOwnedFlag
    const play = matchCount(hero?.playNum)
    const win = matchCount(hero?.winNum)
    const fail = matchCount(hero?.failNum)
    if (!/^\d+$/.test(id) || seen.has(id) || ![0, 1, '0', '1'].includes(owned) ||
      play == null || win == null || fail == null || win + fail !== play) {
      throw new Error('营地生涯场次数据不完整，请稍后重试')
    }
    seen.add(id)
    if (Number(owned) === 0) ownCount++
    // 未拥有但用限免/体验打过的英雄也属于生涯统计，不能丢掉这些场次。
    if (Number(owned) !== 0 && play === 0) continue
    let returnedRoleId = ''
    try { returnedRoleId = new URL(hero.frequencyHeroUrl).searchParams.get('roleId') || '' } catch { /* 下方统一校验 */ }
    // targetRoleId 会被该接口忽略并返回登录账号的默认角色，必须核对实际角色。
    if (returnedRoleId !== roleId) throw new Error('营地返回的英雄角色信息不一致，请稍后重试')
    heroes.push(hero)
  }
  return { heroes, ownCount }
}

/** 只保存页面要用的业务字段；不能把原始响应、鉴权账号或令牌写进缓存。 */
function cleanSnapshot (value) {
  if (!value || value.source !== 'native-career' || !Array.isArray(value.heroes)) return null
  if (!value.roleId || !Number.isFinite(value.at)) return null
  if (value.heroes.some(hero => !hero || !/^\d+$/.test(String(hero.heroId)) || matchCount(hero.playNum) == null || matchCount(hero.winNum) == null || matchCount(hero.failNum) == null || Number(hero.winNum) + Number(hero.failNum) !== Number(hero.playNum))) return null
  const fields = ['heroId', 'name', 'url', 'heroType', 'skilledLevel', 'playNum', 'winNum', 'failNum', 'winRate', 'historyPower', 'seasonPower', 'seasonPowerSource', 'displayPower', 'honorText']
  return {
    source: 'native-career',
    roleId: String(value.roleId),
    at: value.at,
    heroes: value.heroes.map(hero => Object.fromEntries(fields.map(key => [key, hero[key] ?? (key === 'seasonPower' ? null : '')]))),
    ownCount: Number(value.ownCount) || 0,
    totalRate: typeof value.totalRate === 'string' ? value.totalRate : '—',
    profileRate: typeof value.profileRate === 'string' ? value.profileRate : '',
    dataScopeLabel: '全部竞技模式 · 生涯累计',
    playScopeLabel: '生涯',
    previewNote: typeof value.previewNote === 'string' ? value.previewNote : ''
  }
}

/** 我的英雄独立读模型：不再请求被限流的游戏侧 /play/h5getherolist。 */
export class MyHeroRosterReader {
  constructor (api, { cacheFile = path.join(PluginData, 'MyHeroRosterCache.json'), now = Date.now } = {}) {
    this.api = api
    this.cacheFile = cacheFile
    this.now = now
    this.entries = new Map()
    this.pending = new Map()
    this.loadCache()
  }

  loadCache () {
    try {
      const saved = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'))
      if (saved.version !== CACHE_VERSION || !Array.isArray(saved.entries)) return
      for (const [key, data] of saved.entries) {
        const clean = cleanSnapshot(data)
        if (typeof key === 'string' && clean && this.isFresh(clean)) this.entries.set(key, clean)
      }
    } catch {
      // 缺文件或损坏时重新读取接口，不使用不完整数据。
    }
  }

  isFresh (data) {
    const now = this.now()
    const age = now - data.at
    return age >= 0 && age < CACHE_TTL_MS && campDate(now) === campDate(data.at)
  }

  saveCache () {
    for (const [key, entry] of this.entries) if (!this.isFresh(entry)) this.entries.delete(key)
    this.entries = new Map([...this.entries].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CACHE_ENTRIES))
    const temporary = `${this.cacheFile}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true })
      fs.writeFileSync(temporary, JSON.stringify({ version: CACHE_VERSION, entries: [...this.entries] }), { mode: 0o600 })
      fs.renameSync(temporary, this.cacheFile)
    } catch (error) {
      globalThis.logger?.warn?.(`[我的英雄] 缓存写入失败，本次数据仍可显示：${error.message}`)
      try { fs.unlinkSync(temporary) } catch { /* 不影响本次查询 */ }
    }
  }

  async read (campId, requester = '') {
    const target = String(campId || '').trim()
    if (!/^\d+$/.test(target)) throw new Error('营地ID应为纯数字')
    // 不同查询者不共用缓存，避免把一方可见的数据借给另一方；也隔离并发请求。
    const who = String(requester || '')
    const key = JSON.stringify([who, target])
    const hit = this.entries.get(key)
    if (hit && this.isFresh(hit)) return copy(hit)
    if (this.pending.has(key)) return copy(await this.pending.get(key))
    const task = this.fetch(target, who)
    this.pending.set(key, task)
    try {
      const value = await task
      if (value.heroes.length) {
        this.entries.set(key, copy(value))
        this.saveCache()
      }
      return copy(value)
    } finally {
      this.pending.delete(key)
    }
  }

  async fetch (campId, requester) {
    const profile = await this.api.getProfile(campId, requester)
    if (Number(profile?.returnCode) === -10107) throw new Error('对方隐藏了主页信息，无法查看我的英雄')
    const roleId = String(profile?.data?.targetRoleId || '')
    if (!roleId) throw new Error('未获取到游戏角色，请先在王者营地绑定角色')
    if (!/^\d+$/.test(roleId)) throw new Error('营地角色信息不完整，请稍后重试')
    const career = readCareerRows(await this.api.getCareerHeroList(campId, roleId, requester), roleId)
    // 历史赛季仅提供历史峰值和当时称号，不参与场次、胜率和当前战力统计。
    const historical = new Map()
    const history = await optionalLookup('历史称号', () => this.api.getSeasonUsuallyHeroList(roleId, requester, 0))
    const historicalAvailable = Array.isArray(history?.list)
    if (historicalAvailable) {
      for (const hero of history.list) if (hero) historical.set(String(hero.heroId), hero)
    }
    const unique = new Map()
    for (const hero of career.heroes) {
      const id = String(hero.heroId)
      const past = historical.get(id)
      const historyPower = parseHeroPower(past?.maxHeroFightPower) || 0
      const seasonPower = parseHeroPower(hero.heroFightPower)
      unique.set(id, {
        heroId: id,
        name: String(hero.heroName || id),
        // 原生接口的url是横向立绘；沿用已验收的方形heroIcon，避免再次裁脸。
        url: String(hero.heroIcon || ''),
        heroType: String(hero.heroType || ''),
        skilledLevel: Number(hero.skilledLevel) || 0,
        playNum: Number(hero.playNum),
        winNum: Number(hero.winNum),
        failNum: Number(hero.failNum),
        winRate: typeof hero.winRate === 'string' ? hero.winRate : (hero.playNum > 0 ? `${(hero.winNum / hero.playNum * 100).toFixed(1)}%` : '—'),
        historyPower,
        seasonPower,
        seasonPowerSource: seasonPower == null ? '' : 'career-list',
        displayPower: historyPower || seasonPower || 0,
        honorText: String(past?.honorTitle?.desc?.full || '')
      })
    }
    const heroes = [...unique.values()]
    const played = heroes.filter(hero => hero.playNum > 0)
    const at = this.now()
    if (played.some(hero => hero.seasonPower == null)) {
      const current = await optionalLookup('当季英雄战力', () => this.api.getSeasonUsuallyHeroList(roleId, requester, -1))
      fillCurrentPower(unique, current?.list, 'season-list')
      await this.enrichCurrentPower({ unique, played, current, profile: profile.data, roleId, campId, requester, at })
    }

    const totalPlay = played.reduce((sum, hero) => sum + hero.playNum, 0)
    const totalWin = played.reduce((sum, hero) => sum + hero.winNum, 0)
    return cleanSnapshot({
      source: 'native-career', roleId, at, heroes, ownCount: career.ownCount,
      totalRate: totalPlay > 0 ? `${(totalWin / totalPlay * 100).toFixed(2)}%` : '—',
      profileRate: readProfileRate(profile.data),
      previewNote: historicalAvailable ? '' : '历史战力和称号暂未获取，本次按当前战力排序。'
    })
  }

  async enrichCurrentPower ({ unique, played, current, profile, roleId, campId, requester, at }) {
    const hasMissing = () => played.some(hero => hero.seasonPower == null)
    if (hasMissing() && typeof this.api.getProfileHeroList === 'function') {
      const data = await optionalLookup('主页英雄榜', () => this.api.getProfileHeroList(campId, roleId, requester))
      fillCurrentPower(unique, data?.heroList, 'profile-list', row => row?.basicInfo)
    }
    const currentName = Array.isArray(current?.season) ? current.season.find(item => Number(item?.seasonId) === -1)?.seasonName : ''
    if (hasMissing() && currentName && typeof this.api.getSeasonpage === 'function') {
      const index = await optionalLookup('赛季目录', () => this.api.getSeasonpage(roleId, requester, 0))
      const seasons = index?.historyList
      const id = Array.isArray(seasons) ? Number(seasons.find(item => item?.seasonName === currentName)?.seasonId) : NaN
      if (Number.isSafeInteger(id) && id > 0) {
        const data = await optionalLookup('当季常用英雄', () => this.api.getSeasonpage(roleId, requester, id))
        fillCurrentPower(unique, data?.behavior?.rankInfo?.heros, 'season-page')
        fillCurrentPower(unique, data?.behavior?.masterInfo?.heros, 'season-page')
      }
    }
    // 只补默认展示范围的缺项，不按解锁数量逐个访问详情。旧日期、隐私和空壳响应一律不补。
    if (!hasMissing() || typeof this.api.getHeroRecordDetails !== 'function') return
    const role = Array.isArray(profile.roleList) ? profile.roleList.find(item => String(item?.roleId) === roleId) : null
    if (!role?.serverId || Number(role.hideMatch || 0) !== 0) return
    const toFill = played.slice().sort(compareMyHeroRows).slice(0, DEFAULT_MY_HERO_COUNT)
      .filter(hero => hero.seasonPower == null).slice(0, MAX_DETAIL_LOOKUPS)
    const day = campDate(at)
    for (const row of toFill) {
      if (campDate(this.now()) !== day) break
      const data = await optionalLookup('英雄战力曲线', () => this.api.getHeroRecordDetails(roleId, row.heroId, {
        roleName: role.roleName || '', serverId: String(role.serverId)
      }, campId, requester))
      if (!data) break
      if (String(data.heroId) !== row.heroId || Number(data.isHideMatch || 0) !== 0 || Number(data.isHideMatchDetail || 0) !== 0) continue
      const last = Array.isArray(data.powerData) ? data.powerData.at(-1) : null
      const power = parseHeroPower(last?.value)
      if (last?.data !== day || campDate(this.now()) !== day || power == null || power === 0) continue
      fillCurrentPower(unique, [{ heroId: row.heroId, heroFightPower: power }], 'today-curve')
    }
  }
}

export function getMyHeroRoster (api, campId, requester = '') {
  if (!services.has(api)) services.set(api, new MyHeroRosterReader(api))
  return services.get(api).read(campId, requester)
}
