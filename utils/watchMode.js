/**
 * 「这个模式营地给不给观战」—— **唯一一份判据**。
 *
 * ⚠️⚠️ 为什么单独抽这个文件出来：这条判据以前**两份实现各写各的** ——
 *    插件端在 `utils/pushStore.js`（盯梢用），服务端在 `server/lib/camp.js`（列表预筛用），
 *    两处都是 `new Set([4, 14])`，注释里还写着「两处各一份是没办法，改判据时两边都要改」。
 *    但「两边都要改」是靠人记性的，一旦漏改就是**最难受的那种 bug**：
 *    列表预筛说「能看」（列出来给群友点）、盯梢说「不能看」（不发开播提示），
 *    或者反过来 —— 两个功能各说各话，日志里都对，只有用户撞上才发现。
 *
 * ⭐ 现在服务端**直接 import 这一个文件**（它零依赖：不碰 Yunzai、不碰 fs、不碰配置），
 *    插件端也从这里 re-export。改一处就够了，不可能再对不上。
 *
 * ⚠️ 约束：**本文件必须保持零依赖**（只能有纯 JS）。
 *    服务端是独立进程（跑在 Yunzai 之外），引入任何带副作用的模块都会让它起不来。
 */

/**
 * 能观战的模式（`gameType`）。
 * 实测：排位赛 = gameType 4 / battleType 17，巅峰赛 = gameType 14 / battleType 32。
 * 娱乐、模拟战一类营地不开放观战，取流恒回 `-1021`（等多久都没用）。
 */
export const WATCHABLE_GAME_TYPE = new Set([4, 14])

/** 这个模式营地给不给观战 */
export function isWatchableMode (gameType) {
  return WATCHABLE_GAME_TYPE.has(Number(gameType))
}
