/**
 * 定时任务的**运行时开关**：改完配置让 cron 立刻生效。
 *
 * ## 为什么需要它
 *
 * 框架的 `collectTask` 只收 `cron && fnc` **都有值**的项（见 JiuLi
 * `lib/core/loader.js:1050`，TRSS 同构）。所以定时任务有个硬伤：
 *
 * | 场景 | 不重排会怎样 |
 * |---|---|
 * | 配置为空时加载 → 用户运行中「开启」 | job **从来没注册过**，永远不会自动跑 |
 * | 配置非空时加载 → 用户运行中「关闭」 | job **还挂在调度器里**，第二天照样私聊 |
 *
 * 后者更糟：用户以为关掉了，结果照收 —— 比没有这个开关更让人恼火。
 *
 * ## 两条路都走（不是二选一）
 *
 * **A. 重排**（本文件）：改 `task.cron` 再让框架重建 job —— 立刻按新时间生效
 * **B. 闸门**（调用方）：`fnc` 每次触发时现读配置，关了就直接 return ——
 *    万一重排失败（框架路径变了、`createTask` 改名了），也绝不会误签
 *
 * 光有 A 不够稳（依赖框架内部结构），光有 B 不够快（job 还占着调度器、
 * 且「开启」时没有 job 可挡）。两个一起才是「关得掉、开得起」。
 *
 * ## ⚠️ 为什么不能靠「把 cron 置空」来关闭
 *
 * 实测（2026-10-10，node-schedule）：`scheduleJob('', fn)` **不抛错、还返回一个 job**。
 * 也就是说空 cron 会静默变成一个「永不触发但占着位置」的 job，
 * 而 `createTask()` 里那句 `i.job?.cancel?.()` 又确实会取消它 ——
 * 看起来能work，但**判据依赖 node-schedule 对空串的未定义行为**，
 * 换个版本（或换成别的调度库）就可能变成「每分钟都跑」。
 * 所以「关闭」走的是**显式 cancel + 从 task 数组摘掉**，不靠空串。
 *
 * ## 跨框架
 *
 * 框架 loader 的位置在两个生态里不同，按**候选列表**依次试，都拿不到就
 * 只靠 B 闸门兜底（返回 false，调用方照常把配置存好）：
 *   · `lib/plugins/loader.js` —— Yunzai 生态的标准位置（TRSS / Miao / JiuLi 都有）
 *   · `lib/core/loader.js`   —— JiuLi 的真实实现（`lib/plugins/loader.js` 只是转发）
 *
 * ⚠️ 插件里已经在用 `../../../lib/puppeteer/puppeteer.js`，说明这个相对深度成立；
 *    但 loader 的**导出形态**各家可能不同（default 单例 / 具名类），所以两种都试。
 */
import { PluginName } from '#components'

/**
 * 拿框架的 loader 单例。拿不到返回 null（**不抛**）。
 *
 * ⚠️ 用动态 `import()` 而不是顶层 import：这个模块被 `apps/signIn.js` 静态引用，
 *    顶层 import 一个「可能不存在」的路径会让整个插件在别的框架上加载失败 ——
 *    为了一个开关把插件搞挂不值得。
 *
 * @returns {Promise<object|null>}
 */
async function loadLoader () {
  const candidates = [
    '../../../lib/plugins/loader.js',
    '../../../lib/core/loader.js'
  ]

  for (const path of candidates) {
    try {
      const mod = await import(path)
      // default 单例优先；没有就用具名类（各家导出形态不同）
      const loader = mod?.default?.createTask ? mod.default : null
      if (loader) return loader
    } catch {
      // 这个路径在这套框架上不存在，试下一个
    }
  }

  return null
}

/**
 * 让**自己这个插件**的定时任务按新的 `cron` 立刻重排。
 *
 * 做法：把 `task.cron` 改成新值（或从数组里摘掉），再让框架重建。
 * 框架的 `createTask()` 会先 `job.cancel()` 再重新 `scheduleJob`，
 * 所以**不会残留旧 job**（实测 JiuLi `lib/core/loader.js:1076`）。
 *
 * ⚠️ `createTask()` 是**全局重排**：它会把所有插件的 job 都 cancel 重建一遍。
 *    对别的插件是无害的（cron 没变、重建后行为一样），但会打一行 debug 日志。
 *    之所以不用更精细的按 key 重排：那要碰 `taskMap` 和 `unloadPlugin` 的内部结构，
 *    版本差异更大、更容易炸 —— 全局重建是**公开方法**，稳得多。
 *
 * @param {object} task 本插件的 task 项（`this.task[0]` 那种）
 * @param {string} cron 新的 cron；**空串 = 关掉**（从数组摘掉，不靠空串调度）
 * @returns {Promise<boolean>} 是否成功重排（false = 拿不到 loader，调用方靠闸门兜底）
 */
export async function rescheduleOwnTask (task, cron) {
  const loader = await loadLoader()
  if (!loader || !Array.isArray(loader.task)) {
    logger?.warn?.(`[${PluginName}] 拿不到框架 loader，定时开关只写了配置（靠运行时闸门生效）`)
    return false
  }

  const next = String(cron || '').trim()
  const at = loader.task.indexOf(task)

  if (!next) {
    // 关闭：显式取消 + 从数组摘掉。**不置空 cron**（见文件头注释）
    task.job?.cancel?.()
    task.cron = ''
    if (at >= 0) loader.task.splice(at, 1)
  } else {
    task.cron = next
    if (at < 0) loader.task.push(task)   // 之前是关着的，现在要加回来
  }

  try {
    loader.createTask()
    logger?.info?.(`[${PluginName}] 定时任务已${next ? `改为 ${next}` : '关闭'}`)
    return true
  } catch (error) {
    logger?.warn?.(`[${PluginName}] 重排定时任务失败：${error?.message || error}`)
    return false
  }
}

/**
 * 读一个 cron 是否算「开着」。空串 / 纯空白都算关。
 *
 * ⚠️ 抽成函数是因为**判据必须和 `rescheduleOwnTask` 一致** ——
 *    两边各写一个 `String(x || '').trim()` 迟早漂移，
 *    漂移的表现是「显示开着但实际不跑」这种最难查的错。
 *
 * @param {string} cron
 * @returns {boolean}
 */
export function isCronOn (cron) {
  return Boolean(String(cron || '').trim())
}
