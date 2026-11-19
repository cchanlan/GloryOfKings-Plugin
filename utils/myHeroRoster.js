import fs from 'node:fs'
import path from 'node:path'
import { PluginData } from '#components'

const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE_ENTRIES = 128
const services = new WeakMap()
const copy = value => JSON.parse(JSON.stringify(value))
const nonNegative = value => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0

/** 只保存页面要用的业务字段；不能把原始响应、鉴权账号或令牌写进缓存。 */
function cleanSnapshot (value) {
  if (!value || value.source !== 'native-all-seasons' || !Array.isArray(value.heroes)) return null
  if (!value.roleId || !Number.isFinite(value.at)) return null
  if (value.heroes.some(hero => !hero || !/^\d+$/.test(String(hero.heroId)) || !nonNegative(hero.playNum))) return null
  const fields = ['heroId', 'name', 'url', 'heroType', 'skilledLevel', 'playNum', 'winRate', 'historyPower', 'seasonPower', 'displayPower', 'honorText']
  return {
    source: 'native-all-seasons',
    roleId: String(value.roleId),
    at: value.at,
    heroes: value.heroes.map(hero => Object.fromEntries(fields.map(key => [key, hero[key] ?? (key === 'seasonPower' ? null : '')]))),
    ownCount: Number(value.ownCount) || 0,
    totalRate: typeof value.totalRate === 'string' ? value.totalRate : '—',
    dataScopeLabel: '全部赛季 · 营地统计口径',
    playScopeLabel: '全部赛季',
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
      if (saved.version !== 2 || !Array.isArray(saved.entries)) return
      for (const [key, data] of saved.entries) {
        const clean = cleanSnapshot(data)
        if (typeof key === 'string' && clean && this.isFresh(clean)) this.entries.set(key, clean)
      }
    } catch {
      // 缺文件或损坏时重新读取接口，不使用不完整数据。
    }
  }

  isFresh (data) {
    const age = this.now() - data.at
    return age >= 0 && age < CACHE_TTL_MS
  }

  saveCache () {
    for (const [key, entry] of this.entries) if (!this.isFresh(entry)) this.entries.delete(key)
    this.entries = new Map([...this.entries].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CACHE_ENTRIES))
    const temporary = `${this.cacheFile}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true })
      fs.writeFileSync(temporary, JSON.stringify({ version: 2, entries: [...this.entries] }), { mode: 0o600 })
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
    const current = await this.api.getSeasonUsuallyHeroList(roleId, requester, -1)
    if (!Array.isArray(current?.data?.list)) throw new Error('营地本赛季英雄数据暂时不可用，请稍后重试')
    // 从服务端菜单找“全部赛季”，不能把0“历史赛季”或当前赛季top5冒充全量。
    const menu = current?.data?.season
    const option = Array.isArray(menu) ? menu.find(item => item?.seasonName === '全部赛季') : null
    if (!option || !Number.isInteger(Number(option.seasonId)) || ['', '0', '-1'].includes(String(option.seasonId))) {
      throw new Error('营地未返回“全部赛季”选项，暂时无法读取完整英雄列表')
    }
    const all = await this.api.getSeasonUsuallyHeroList(roleId, requester, Number(option.seasonId))
    if (!Array.isArray(all?.data?.list)) throw new Error('营地全部赛季英雄数据暂时不可用，请稍后重试')
    const currentPowers = new Map(current.data.list.filter(hero => /^\d+$/.test(String(hero?.heroId)) && nonNegative(hero.heroFightPower)).map(hero => [String(hero.heroId), Number(hero.heroFightPower)]))
    // 全部赛季列表的honorTitle是当前称号；历史列必须单独补历史赛季称号，不能混用。
    const historical = new Map()
    let historicalAvailable = false
    try {
      const history = await this.api.getSeasonUsuallyHeroList(roleId, requester, 0)
      if (Array.isArray(history?.data?.list)) {
        for (const hero of history.data.list) historical.set(String(hero.heroId), hero)
        historicalAvailable = true
      }
    } catch (error) {
      globalThis.logger?.warn?.(`[我的英雄] 历史称号暂不可用，本次不展示称号：${error.message}`)
    }
    const unique = new Map()
    for (const hero of all.data.list) {
      const id = String(hero?.heroId || '')
      if (!/^\d+$/.test(id) || (hero.notOwnedFlag != null && Number(hero.notOwnedFlag) !== 0)) continue
      const past = historical.get(id)
      const historyPower = nonNegative(past?.maxHeroFightPower) ? Number(past.maxHeroFightPower) : (nonNegative(hero.maxHeroFightPower) ? Number(hero.maxHeroFightPower) : 0)
      const seasonPower = currentPowers.has(id) ? currentPowers.get(id) : null
      unique.set(id, {
        heroId: id,
        name: String(hero.szTitle || hero.name || id),
        url: String(hero.szHeroIcon || hero.heroIcon || ''),
        heroType: String(hero.heroType || ''),
        skilledLevel: Number(hero.skilledLevel) || 0,
        playNum: nonNegative(hero.playNum) ? Number(hero.playNum) : 0,
        winRate: typeof hero.winRate === 'string' ? hero.winRate : '—',
        historyPower,
        seasonPower,
        displayPower: historyPower || seasonPower || 0,
        honorText: String(past?.honorTitle?.desc?.full || '')
      })
    }
    const heroes = [...unique.values()]
    // 原始胜率经过四舍五入，没有总胜场就不能倒算累计胜率。
    const played = [...new Map(all.data.list.filter(hero => unique.has(String(hero?.heroId)) && Number(hero.playNum) > 0).map(hero => [String(hero.heroId), hero])).values()]
    const hasExactWins = played.length > 0 && played.every(hero => nonNegative(hero.winNum) && Number(hero.winNum) <= Number(hero.playNum))
    const totalPlay = heroes.reduce((sum, hero) => sum + hero.playNum, 0)
    const totalWin = hasExactWins ? played.reduce((sum, hero) => sum + Number(hero.winNum), 0) : 0
    return cleanSnapshot({
      source: 'native-all-seasons', roleId, at: this.now(), heroes, ownCount: heroes.length,
      totalRate: hasExactWins && totalPlay > 0 ? `${(totalWin / totalPlay * 100).toFixed(1)}%` : '—',
      previewNote: `当前战力只展示本赛季接口有记录的英雄，其余为“—”。${hasExactWins ? '' : '营地未提供总胜场，累计胜率不作估算。'}${historicalAvailable ? '' : '历史称号暂未获取，本次不展示称号。'}`
    })
  }
}

export function getMyHeroRoster (api, campId, requester = '') {
  if (!services.has(api)) services.set(api, new MyHeroRosterReader(api))
  return services.get(api).read(campId, requester)
}
