/**
 * 开黑的展示素材：分路图标 + 分路 → 图标名的映射。
 *
 * ## 为什么图标是内联 SVG 自己画的
 *
 * - `resources/img/branch_*.png` 那 20 张**不是分路图标**，是带「金牌打野」字样的
 *   198×48 长条奖牌（`utils/battleDetailImage.js` 在用），当不了位置标识
 * - 营地 APK 解出来的资源里也没有纯分路图标（2026-10-15 翻过 `/root/camp-assets`，439 张 png）
 * - 外链官方图标受网络和 CDN 影响，渲染时 404 就是一排空白
 *
 * ## 为什么单独一个模块，而不是写进模板里
 *
 * 列表图（`TeamList.html`）和播报图（`TeamBroadcast.html`）都要这套图标。
 * 两边各抄一份必然漂移 —— 改了一个忘了另一个，而这两个是同一功能的两种视图。
 * 所以图标只在这里定义，渲染时以 `laneIcons` 传给模板，模板用 `{{@laneIcons}}` 原样注入。
 *
 * ## 形状的取舍
 *
 * 对抗路和发育路最早都画成竖直的刃状物（剑 / 一支箭），**16px 下是同一个剪影**，
 * 谁也认不出哪个是哪个 —— 发育路改成「弓 + 横箭」才分得开。
 */
export const LANE_ICON_KEY = {
  对抗路: 'warrior',
  中路: 'mid',
  打野: 'jungle',
  发育路: 'marksman',
  辅助: 'roam'
}

/** 「都行」用的图标（四向点） */
export const LANE_ICON_ANY = 'any'

/**
 * SVG 雪碧图。模板里用 `<svg><use href="#lane-xxx"></use></svg>` 引用。
 */
export const LANE_ICON_SVG = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="lane-warrior" viewBox="0 0 24 24">
    <path d="M12 1.2 15.2 6.8 15.2 14.4 12 17 8.8 14.4 8.8 6.8Z"/>
    <rect x="5.2" y="15" width="13.6" height="2.6" rx="0.9"/>
    <rect x="10.7" y="17.6" width="2.6" height="5.2" rx="0.9"/>
  </symbol>
  <symbol id="lane-mid" viewBox="0 0 24 24">
    <path d="M12 1.4 14.6 9.4 22.6 12 14.6 14.6 12 22.6 9.4 14.6 1.4 12 9.4 9.4Z"/>
  </symbol>
  <symbol id="lane-jungle" viewBox="0 0 24 24">
    <ellipse cx="6.4" cy="8.6" rx="2.1" ry="3"/>
    <ellipse cx="12" cy="6.4" rx="2.2" ry="3.3"/>
    <ellipse cx="17.6" cy="8.6" rx="2.1" ry="3"/>
    <path d="M12 11.4c-3.9 0-6.3 2.9-6.3 5.4 0 2.6 2.7 4.2 6.3 4.2s6.3-1.6 6.3-4.2c0-2.5-2.4-5.4-6.3-5.4Z"/>
  </symbol>
  <symbol id="lane-marksman" viewBox="0 0 24 24">
    <path d="M7.4 1.8C13.4 6 13.4 18 7.4 22.2L9.8 22.2C15.4 17.8 15.4 6.2 9.8 1.8Z"/>
    <rect x="6.3" y="1.8" width="1.9" height="20.4" rx="0.9"/>
    <rect x="5.2" y="10.9" width="12.4" height="2.2" rx="0.9"/>
    <path d="M16.4 8.4 22.4 12 16.4 15.6Z"/>
  </symbol>
  <symbol id="lane-roam" viewBox="0 0 24 24">
    <path d="M12 1.6 20.4 4.8V12c0 5-3.6 8.6-8.4 10.4C7.2 20.6 3.6 17 3.6 12V4.8Z"/>
  </symbol>
  <symbol id="lane-any" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="3.3"/>
    <circle cx="12" cy="3.7" r="1.8"/>
    <circle cx="12" cy="20.3" r="1.8"/>
    <circle cx="3.7" cy="12" r="1.8"/>
    <circle cx="20.3" cy="12" r="1.8"/>
  </symbol>
</svg>`
