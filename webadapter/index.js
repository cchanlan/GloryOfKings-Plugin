/**
 * 营地消息 —— Web 控制台扩展页面（可视化管理）。
 *
 * ## 为什么单独做一个页面
 * 控制台的静态表单（锅巴的 `guoba.support.js`）只能渲染「固定结构 + 动态数据」，
 * 没法做「每账号一行、带头像/归属/独立开关」这种运行时形状的列表，
 * 所以走插件自己目录下的扩展页面。
 *
 * ## 目录为什么是 `webadapter/`（而不是 `guoba/`）
 * **一份页面要让两套控制台都能装**，而两套认的目录不一样：
 *
 * | 宿主 | 扫描的目录 | 认不认另一个 |
 * | --- | --- | --- |
 * | QQBot-Web-Adapter | `plugins/<插件>/webadapter/` | **只认 `webadapter/`** |
 * | 锅巴 Guoba-Plugin | `PAGE_DIRS = ['guoba', 'webadapter']` | 两个都认，`guoba/` 优先 |
 *
 * 所以**只放 `webadapter/` 一份**就行：锅巴会 fallback 到它，WebAdapter 正着认它，
 * 两边通吃、不用维护两份、也不会互相漂移。
 * ⚠️ 反过来只放 `guoba/` 的话，WebAdapter 那边**整个页面都不会出现**
 *    —— 它只扫 `webadapter/`，看不见 `guoba/`。
 *
 * ## 接口挂在哪（两套不一样，页面里别写死）
 * | 宿主 | 接口实际前缀 | 页面能从哪拿到 |
 * | --- | --- | --- |
 * | 锅巴 | `<挂载前缀>/api/custom/<插件目录名>` | iframe query 的 `__apiBase` |
 * | WebAdapter | `<挂载前缀>/api` | 没有 `__apiBase`，用 `__webBase + '/api'` |
 *
 * 本文件两套都只注册**同一个路由**（`/gok-camp-im/accounts`），
 * 前缀由页面按上表自己推 —— 见 `page.html` 里的 `resolveApiBase()`。
 *
 * ## 鉴权（两套都由宿主自动套，别绕过）
 * - 锅巴：`ctx.registerApi` 挂到 `/api/custom/...`，落在它的 `TokenInterceptor` 里
 * - WebAdapter：`ctx.registerApi` 挂到 `<前缀>/api/...`，落在它的 `apiAuthGuard` 里
 * 两套都是「登录后才放行」。页面侧只有锅巴需要自己带凭证（token 在 iframe 的 query 上）。
 *
 * ⚠️ 一律用 `ctx.registerApi`，**不要**裸挂 `Bot.express` —— 那样没有登录鉴权。
 */
import authStore from '../utils/authStore.js'
import * as store from '../utils/campImStore.js'
import { ownerOf } from '../utils/campImPush.js'

/**
 * 控制台页面用的账号快照。
 *
 * ⚠️⚠️ 列的**只是「收消息名单」里的号** —— 这份名单跟「轮询用的全局账号池」
 *    （`AuthPool.json`）是两回事：账号池扫进来是给查询/推送轮询用的，
 *    **不代表它要挂 ws 收消息**。早先这里是把池子里的号全列出来、默认开，
 *    账号一多就没法管（2026-09-20 主人指出「谁说扫了全局账号就一定要做收消息」）。
 *
 * 没进名单的号放在 `available` 里，页面上用「＋ 添加」挑。
 */
function snapshot () {
  // ⚠️⚠️ 同 guoba.support.js：prune 的 keep 集合是「池子里所有有 userId 的号」（pool），
  //    「＋添加」的候选才是「能收营地消息的号」（all，有 userSig）。
  //    共用一份会把只有 token 的 QQ 区号当僵尸号从收消息名单里真删掉（2026-10-06 修）。
  const pool = authStore.listAccounts().filter(a => a?.userId)
  const all = pool.filter(a => a?.userSig)
  // ⚠️⚠️ **先跟账号池对账，再读名单**（2026-10-05 修）。
  //    收消息名单是独立白名单，号从账号池删掉之后白名单里那条不会自己走 ——
  //    不对账的话下面就会把池子里根本不存在的号也列出来，开关还是开的。
  //    详见 utils/campImStore.js 的 pruneAccounts。
  store.pruneAccounts(pool.map(a => a.userId))
  const switches = store.getAccountSwitches()          // { userId: true }
  const infoOf = new Map(all.map(a => [String(a.userId), a]))

  const build = (userId, enable) => {
    const a = infoOf.get(String(userId)) || {}
    return {
      userId: String(userId),
      nickname: a.nickname || a.userName || '',
      avatar: a.avatar || a.icon || '',
      // 归属人：没有就是空串（那批 2026-09-17 之前扫的老号，不推消息）
      owner: ownerOf(userId),
      ownerMasked: mask(ownerOf(userId)),
      enable
    }
  }

  // ⚠️ 再 filter 一道兜底：对账后名单里不该还有池子外的号，但**绝不能靠这个假设** ——
  //    万一哪天 prune 没跑到，宁可少列也不能把不存在的号显示成「在收消息」
  const accounts = Object.keys(switches)
    .filter(uid => infoOf.has(String(uid)))
    // ⚠️ 照实反映名单里的值（与 isAccountEnabled 同一判据），别硬编码 true（2026-10-06 修）
    .map(uid => build(uid, switches[uid] === true))

  // 登录过、但还没进收消息名单的号（给「＋ 添加」用）
  const available = all
    // ⚠️ 与 isAccountEnabled 同一判据：残留的 `false` 不该让同一个号既在名单又在候选里
    .filter(a => switches[String(a.userId)] !== true)
    .map(a => ({
      userId: String(a.userId),
      nickname: a.nickname || a.userName || '',
      owner: ownerOf(a.userId),
      ownerMasked: mask(ownerOf(a.userId))
    }))

  // 没归属人的排后面，其余按昵称
  accounts.sort((x, y) => {
    if (Boolean(x.owner) !== Boolean(y.owner)) return x.owner ? -1 : 1
    return String(x.nickname).localeCompare(String(y.nickname), 'zh')
  })

  return {
    accounts,
    available,
    total: accounts.length,
    enabled: accounts.length,
    ownered: accounts.filter(a => a.owner).length
  }
}

/** QQ 号打码（页面上只给主人看，不用全露） */
function mask (id) {
  const s = String(id || '')
  if (s.length <= 4) return s
  return s.slice(0, 2) + '*'.repeat(Math.max(0, s.length - 4)) + s.slice(-2)
}

export function init (ctx) {
  // ⚠️⚠️ `style` 字段**两套都得写**：它同时是「渲染用的样式」和「静态资源白名单」，
  //    没声明的文件请求会被 403（页面里自己写的 `<link href="page.css">` 也拿不到）：
  //      - 锅巴 `resolveAsset()`：只放行描述符里的 `[src, style, script]`
  //      - WebAdapter `webPageAllowed`：同样只放行这三个
  //
  // ⚠️ iframe 模式（有 `src`）下两套都**不会**把 CSS 注入到控制台主文档，
  //    页面里必须自己 `<link>` 引（两套前端都只在片段/html 模式注入）。
  //    类名仍然统一带 `gki-` 前缀（GloryOfKings IM）—— 防的是片段模式和别的插件页面撞车
  //    （实测通用的 `.card` / `.toggle` / `.list` 撞上过 Gscore-Adapter 的页面）。
  ctx.registerPage({
    id: 'gok-camp-im',
    title: '营地消息',
    icon: '📨',
    priority: 50,
    src: 'page.html',
    style: 'page.css'
  })

  // 读：账号列表 + 开关状态
  ctx.registerApi('get', '/gok-camp-im/accounts', async (_req, res) => {
    try {
      res.json({ ok: true, ...snapshot() })
    } catch (error) {
      ctx.logger.error('[营地消息] 读账号列表失败', error)
      res.status(500).json({ ok: false, error: error.message || '读取失败' })
    }
  })

  // 写：保存收消息名单
  //
  // ⚠️⚠️ **以提交上来的列表为准**（不在列表里的 = 从名单里移出）。
  //    早先是「只逐个 set」，于是「删掉一行」永远不生效 —— 因为删掉的行根本不在提交里。
  //    前端是**全量提交**当前名单的，所以这里必须做差集。
  ctx.registerApi('post', '/gok-camp-im/accounts', async (req, res) => {
    try {
      // body 没解析出来时**直接报错**，别当成「清空名单」把人家全删了
      if (!req.body || !Array.isArray(req.body.accounts)) {
        return res.status(400).json({ ok: false, error: '没收到名单数据' })
      }
      const wanted = new Set(
        req.body.accounts
          .filter(i => i?.enable === true)
          .map(i => String(i.userId || '').trim())
          .filter(Boolean)
      )
      // 先移出：名单里有、但这次没提交的
      for (const uid of Object.keys(store.getAccountSwitches())) {
        if (!wanted.has(uid)) store.setAccountEnabled(uid, false)
      }
      // 再加入
      for (const uid of wanted) store.setAccountEnabled(uid, true)
      // 让插件重读（否则它内存里的缓存还是旧的）
      store.invalidate()
      const after = snapshot()
      ctx.logger.mark(`[营地消息] 收消息名单已更新：${after.total} 个号（${[...wanted].join(',') || '空'}）`)
      res.json({ ok: true, ...after, message: '已保存' })
    } catch (error) {
      ctx.logger.warn('[营地消息] 保存名单失败', error)
      res.status(400).json({ ok: false, error: error.message || '保存失败' })
    }
  })
}
