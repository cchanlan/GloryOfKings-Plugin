/**
 * 出图格式（锅巴里的「出图 → 输出图片类型」，对应 config.yaml 的 imgType）。
 *
 * ## 为什么单独一个文件
 *
 * 插件里 37 处出图原先都把格式写死成 webp。收口到一个函数之后，
 * `utils/campImPush.js` / `utils/battleDetailImage.js` / `utils/masterPanel.js`
 * 这三个 **utils 内部**的模块自己也要出图，若从 `#utils`（就是 index.js）取，
 * 就等于绕一圈回头引自己 —— 同 `localBind.js` 的理由，放在只依赖 `#components`
 * 的小模块里最省事，也从根上避开了循环依赖。
 *
 * ## 为什么默认 jpeg
 *
 * 出图后端（renderers/puppeteer 与 shotium）自己就默认 jpeg。webp 在 QQ / OneBot
 * 那边能省三成左右体积，但**微信（ComWeChat）适配器的图片接口不认 webp**：
 * 2026-09-24 实测，一张 958KB 的 webp 走 `CSendImage` 发出去，微信把它降级成了
 * 「文件」—— 群里收到的是 `xxx.webp` 文件卡片，不是图片。
 * 所以默认取最保险的 jpeg，想要小体积的自己按平台改。
 */
import { Config } from '#components'

/** 出图后端认的取值（见 renderers 下各后端 lib 里的 screenshot 实现） */
const VALID = ['jpeg', 'png', 'webp']

/**
 * 读配置拿出图格式。值非法 / 读不到配置一律退回 jpeg —— 出图路径上
 * 绝不能因为一个配置项写错就整张图发不出去。
 *
 * @returns {'jpeg'|'png'|'webp'}
 */
export function getImgType () {
  try {
    const raw = String(Config.getDefOrConfig('config')?.imgType ?? '').trim().toLowerCase()
    // 后端只认 jpeg，顺手把 jpg 这种常见写法归一化掉
    if (raw === 'jpg') return 'jpeg'
    return VALID.includes(raw) ? raw : 'jpeg'
  } catch {
    return 'jpeg'
  }
}
