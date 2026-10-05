/**
 * 热重载安全的状态盒。
 *
 * ## 为什么需要它
 *
 * JiuLi 内核热重载时会给 `plugins/` 下**每个**模块追加 `?jiuli_reload=<代数>`
 * （见 `lib/core/reload-hooks.js` 的 `stamp()`），整张插件模块图以全新 URL
 * **重新求值**。于是模块顶层的 `let` / 对象字面量都变成了**全新的变量/对象**：
 *
 *   · 纯缓存      → 无害，重新预热而已
 *   · 并发锁      → **有害**：旧实例那一轮还在跑，新实例却看到 `false`，
 *                   cron 再触发就**并发**跑第二轮（实测：两轮轮询重叠 → 请求量翻倍 → 吃 -30107）
 *   · 游标/水位   → **有害**：归零后从头重查，或跳过本该查的那批
 *   · 待落盘队列  → **有害**：攒着没写盘的 patch 直接丢
 *
 * 已实证（`/tmp/hh9_locksim.mjs`，用真实 `?jiuli_reload=N` 机制复现）：
 * ```
 *   第一代：进入运行态 → {"running":true,"cursor":7}
 *   热重载后新实例看到 → {"running":false,"cursor":0}   ← 锁被架空、游标归零
 *   锚到 globalThis 后  → {"running":true,"cursor":7}   ← 锁仍有效
 * ```
 *
 * ## 用法
 *
 * ```js
 * const S = hotBox('gameRecordPush', { running: false, cursor: 0 })
 * // 之后一律用 S.running / S.cursor，不要再声明模块级 let
 * ```
 *
 * ⚠️ 只放**该跨代共享**的东西：锁、游标、去重表、水位。别把「一次调用内的局部状态」
 *    塞进来 —— 那会让两代实例真的互相干扰（该隔离的反而不隔离了）。
 *
 * ⚠️ 盒子里存的是**跨代共享的可变对象**，所以取出来后不要整体替换
 *    （`S = {...}` 无效，要逐个字段赋值）。
 *
 * @param {string} key 唯一键（建议用「模块名.用途」，如 `'pushStore.pendingPatches'`）
 * @param {object} initial 初始字段。只在**第一次**创建时生效；后续代次拿到的是已有盒子
 * @returns {object} 挂在 globalThis 上的同一个盒子
 */
export function hotBox (key, initial) {
  const K = `__gokHotBox__${key}`
  const existing = globalThis[K]
  if (existing) return existing
  const box = { ...initial }
  globalThis[K] = box
  return box
}
