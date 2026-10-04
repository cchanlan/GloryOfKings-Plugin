/**
 * 营地消息 —— 锅巴扩展页面（可视化管理）。
 *
 * ## 为什么单独做一个页面
 * 锅巴的静态 schema（`guoba.support.js`）只能渲染「固定结构 + 动态数据」，
 * 没法做「每账号一行、带头像/在线状态/独立开关」这种运行时形状的列表。
 * 所以走 `guoba/` 目录的自定义页面路线（锅巴启动时自动扫描，见
 * `Guoba-Plugin/server/service/both/CustomPageService.js` 的 `PAGE_DIRS`）。
 *
 * ## 接口挂在哪
 * `ctx.registerApi` 注册的接口自动挂到 `/api/custom/<插件目录名>/...` 下，
 * 并且**自动带登录鉴权** —— 别绕过它去裸挂 express（那样没有鉴权）。
 *
 * ## 页面怎么拿接口地址
 * 页面从 `location.search` 读 `__apiBase` / `token`，**不要硬编码**
 * （前缀里含锅巴的挂载段，各环境不一样）。
 */
import authStore from '../utils/authStore.js'
import * as store from '../utils/campImStore.js'
import { ownerOf } from '../utils/campImPush.js'

/**
 * 锅巴面板用的账号快照。
 *
 * ⚠️⚠️ 列的**只是「收消息名单」里的号** —— 这份名单跟「轮询用的全局账号池」
 *    （`AuthPool.json`）是两回事：账号池扫进来是给查询/推送轮询用的，
 *    **不代表它要挂 ws 收消息**。早先这里是把池子里的号全列出来、默认开，
 *    账号一多就没法管（2026-09-20 主人指出「谁说扫了全局账号就一定要做收消息」）。
 *
 * 没进名单的号放在 `available` 里，页面上用「＋ 添加」挑。
 */
function snapshot () {
  const switches = store.getAccountSwitches()          // { userId: true }
  const all = authStore.listAccounts().filter(a => a?.userId && a?.userSig)
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

  const accounts = Object.keys(switches).map(uid => build(uid, true))

  // 登录过、但还没进收消息名单的号（给「＋ 添加」用）
  const available = all
    .filter(a => !switches[String(a.userId)])
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
  // ⚠️⚠️ `style` 字段**必须写**：锅巴的 `resolveAsset()` 按白名单放行静态资源，
  //    没在描述符里声明的文件会被 403（页面里自己写 `<link href="page.css">` 也拿不到）。
  //
  // ⚠️⚠️ **但这也意味着 CSS 会被注入到【面板主文档】的 `<head>`**（见锅巴前端
  //    `views/custom/index.vue` 的 `injectAssets()`）—— 是**全局**的，不是 iframe 内。
  //    所以类名**必须加前缀**，否则会和别的插件的自定义页面互相覆盖
  //    （实测 `.card` / `.toggle` / `.list` 撞上了 Gscore-Adapter，把人家页面搞花了）。
  //    本页统一用 `gki-` 前缀（GloryOfKings IM）。
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
