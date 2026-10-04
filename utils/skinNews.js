/**
 * 皮肤上新的数据层。
 *
 * 数据源是官网资料库的皮肤总表 `heroskinlist.json`（ApiService.getPvpSkinList，约 780KB / 818 条），
 * **每条自带上线日期 `sxsjlb_1516`（YYYYMMDD）**——这是关键：有了日期就不必靠「和上次快照比 diff」
 * 才能知道谁是新皮肤，未上线的皮肤也会提前几天带着未来日期进这张表，所以
 * 「即将上线」和「已上线」用同一个字段就能分开。
 * 实测 818 条里 646 条有日期，最早 20150811（墨子·金属风暴），最新一条是未来日期。
 *
 * 快照（pushed 列表）只用来防重复推送，不用来判断「是不是新的」：
 * 用 diff 判新的话，第一次运行会把 818 条全当成新皮肤。
 */
import path from 'path'
import { ApiService, cache, readYamlFile, writeYamlFile } from '#utils'
import { quarantineCorrupt } from './safeStore.js'
import { PVP_FIELDS as F, getHeroCatalog } from './heroGuide.js'
import { PluginData } from '#components'

const SKIN_PUSH_FILE = path.join(PluginData, 'SkinNewsPush.yaml')

/** 皮肤总表的内存缓存时长（秒）。官网一天也就更一次，1 小时足够 */
const CALENDAR_TTL = 3600

/** 防重复推送的记录最多留多少条（一年新皮肤约 100 张，200 条够两年） */
const PUSHED_KEEP = 200

/** 品质配色，和图上其它「强弱」语言保持一致 */
export const QUALITY_COLOR = {
  典藏: '#ff5b7c',
  传说: '#f5d76e',
  史诗: '#c77dff',
  无双: '#ff8fa8',
  勇者: '#6f8ef5',
  伴生: '#7ee0a8',
  荣耀典藏: '#ff5b7c'
}

/** YYYYMMDD -> 2026-09-01 */
export function formatDate (raw) {
  const text = String(raw || '')
  if (!/^\d{8}$/.test(text)) return text
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
}

/** 今天的 YYYYMMDD（本地时区，和官网写的日期同一个口径） */
export function today () {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}${mm}${dd}`
}

/**
 * 皮肤日历：按上线日期倒序的皮肤清单（只保留有日期的）。
 * 顺带把英雄头像补上——皮肤条目里只有皮肤自己的封面，英雄头像要从英雄表按名字取。
 * @returns {Promise<object[]>}
 */
export async function getSkinCalendar () {
  const hit = cache.get('gok:skinCalendar')
  if (hit) return hit

  const [raw, catalog] = await Promise.all([ApiService.getPvpSkinList(), getHeroCatalog()])
  const list = (raw?.[F.skinList] || [])
    .map(s => {
      const heroName = String(s[F.skinHero] || '')
      return {
        id: String(s[F.skinId] || ''),
        name: String(s[F.skinName] || ''),
        hero: heroName,
        heroAvatar: catalog.byName.get(heroName)?.avatar || '',
        quality: String(s[F.skinQuality] || ''),
        online: String(s[F.skinOnline] || ''),
        intro: String(s[F.skinIntro] || ''),
        getWay: String(s[F.skinGet] || ''),
        cover: String(s[F.skinCover] || '')
      }
    })
    .filter(s => s.id && s.name && /^\d{8}$/.test(s.online))
    .sort((a, b) => b.online.localeCompare(a.online))

  cache.set('gok:skinCalendar', list, CALENDAR_TTL)
  return list
}

/**
 * 分成「即将上线」和「最近上线」两段。
 * 边界含今天：今天上线的算「今天」，单独一段，推送时也是它最该被推。
 * @param {object[]} list getSkinCalendar 的结果
 * @param {number} recentLimit 最近上线最多取几条
 */
export function splitCalendar (list, recentLimit = 8) {
  const now = today()
  const upcoming = []
  const todayList = []
  const recent = []

  for (const skin of list) {
    if (skin.online > now) upcoming.push(skin)
    else if (skin.online === now) todayList.push(skin)
    else if (recent.length < recentLimit) recent.push(skin)
  }

  // 即将上线按时间正序（最近要来的排最前），和「倒计时」的直觉一致
  upcoming.sort((a, b) => a.online.localeCompare(b.online))
  return { upcoming, todayList, recent }
}

/* ---------------------------------------------------------------- 订阅存取 */

/**
 * 读订阅表，坏了返回空表——绝不让定时任务因为这个文件挂掉。
 * 解析失败先隔离坏文件，否则空表会被下一次保存固化，订阅静默消失（同 groupReportStore）。
 * @returns {{pushList: object, pushed: string[]}}
 */
export function loadSkinNewsStore () {
  try {
    const data = readYamlFile(SKIN_PUSH_FILE)
    return {
      pushList: data?.pushList && typeof data.pushList === 'object' ? data.pushList : {},
      pushed: Array.isArray(data?.pushed) ? data.pushed.map(String) : []
    }
  } catch (error) {
    quarantineCorrupt(SKIN_PUSH_FILE, error, '[王者皮肤上新]')
    return { pushList: {}, pushed: [] }
  }
}

export function saveSkinNewsStore (store) {
  writeYamlFile(SKIN_PUSH_FILE, {
    pushList: store?.pushList || {},
    // 只留最近的，否则这个数组会一直长
    pushed: (store?.pushed || []).slice(-PUSHED_KEEP)
  })
}

/**
 * 开 / 关一个群的皮肤上新推送。关掉就删记录，不留空壳。
 * @returns {{changed: boolean}} changed 为假表示状态本来就是这样
 */
export function setSkinNewsSub (groupId, enable, extra = {}) {
  const key = String(groupId || '')
  if (!key) return { changed: false }

  const store = loadSkinNewsStore()
  const on = Boolean(store.pushList[key])

  if (on === enable) return { changed: false }

  if (enable) {
    store.pushList[key] = { enabled: true, since: Date.now(), ...extra }
  } else {
    delete store.pushList[key]
  }

  saveSkinNewsStore(store)
  return { changed: true }
}

/**
 * 这一轮该推哪些皮肤。
 *
 * 两类都推，因为对用户是两件事：
 *   - 今天上线的（可以去买了）
 *   - 新进清单、还没上线的（爆料，可以期待）
 * 都按皮肤 ID 去重，`pushed` 里有的不再推。**首次运行不会把历史皮肤全推一遍**：
 * 判据是「上线日期 >= 今天」，历史皮肤天然不入选。
 *
 * @returns {Promise<{items: object[], store: object}>} items 为空表示这轮没什么可推
 */
export async function collectSkinNews () {
  const store = loadSkinNewsStore()
  const list = await getSkinCalendar()
  const { upcoming, todayList } = splitCalendar(list, 0)
  const pushed = new Set(store.pushed)

  const items = [...todayList, ...upcoming]
    .filter(skin => !pushed.has(skin.id))
    .map(skin => ({ ...skin, isToday: skin.online === today() }))

  return { items, store }
}

/** 把这批皮肤记进已推列表 */
export function markSkinNewsPushed (store, items) {
  const ids = items.map(s => String(s.id))
  store.pushed = [...store.pushed.filter(id => !ids.includes(id)), ...ids]
  saveSkinNewsStore(store)
}
