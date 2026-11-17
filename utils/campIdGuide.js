/**
 * 「还没绑定营地ID」时的统一回复载荷：示例文案 + 小程序入口 + 教程图 + 绑定按钮。
 *
 * 原来各指令的未绑定分支各写各的，多数只甩一张「营地ID从哪看」的教程图，
 * 用户看完不知道该发什么（截图里就是这张图孤零零挂在群里）。
 * 文案格式和示例统一收在这里，改一处全体生效，别再各写一份。
 */
import path from 'path'
import { PluginPath } from '#components'
import Button from './button.js'

/** 教程图文件名（resources/img 下） */
const CAMP_ID_GUIDE_IMG = '营地ID获取.png'

/** 教程图配的文案：光有图用户不知道该发什么，格式和示例都得写出来 */
export const CAMP_ID_GUIDE_HINT = '绑定方式：#绑定营地 + 营地ID（纯数字）\n示例：#绑定营地 123456'

/**
 * 营地小程序入口：QQ 短链来自实际收到的官方分享卡片，AppID 为 wx898cb4b08963dccb；
 * 微信分享口令由用户提供。QQ 可承载微信小程序，不以分享口令前缀判断客户端能力。
 * HTTP 跳转页已在 Linux 验证，手机内的授权与资料页导航尚待真机验收；
 * 不把短链当作登录凭证，也不从分享人的页面参数自动绑定账号。
 */
const CAMP_ID_QQ_MINI_PROGRAM_LINK = 'https://m.q.qq.com/a/s/1bacb484aaf1419520802da0b1204504'
const CAMP_ID_WECHAT_MINI_PROGRAM_LINK = '#小程序://王者营地/7NoAEzcBCr2YH8I'
const CAMP_ID_MINI_PROGRAM_GUIDE = [
  '查看营地ID：打开「王者营地」小程序，授权登录后进入「我的 → 编辑资料」，复制「营地ID」。',
  `QQ入口：${CAMP_ID_QQ_MINI_PROGRAM_LINK}`,
  '微信入口：',
  CAMP_ID_WECHAT_MINI_PROGRAM_LINK,
  '入口打不开时，在微信搜索「王者营地」小程序，授权登录后进入「我的 → 编辑资料」。'
].join('\n')

/** 支持「指令后附带营地ID」的那几条指令用这句：两条路都告诉用户，别让他以为只能先绑定 */
export const CAMP_ID_SUFFIX_HINT = '未查询到营地ID：可以直接在指令后附带营地ID，也可以先绑定'

/**
 * 未绑定营地ID的标准回复：示例文案 + 小程序入口 + 教程图 + 绑定按钮。
 * segment 是 Yunzai 注入的全局对象，和 utils/button.js 用法一致。
 *
 * @param {string} [hint] 覆盖默认文案。支持「指令后附带营地ID」的指令用得上，
 *   免得用户以为只有先去绑定这一条路
 */
export function campIdGuidePayload (hint = CAMP_ID_GUIDE_HINT) {
  return [
    `${hint}\n\n${CAMP_ID_MINI_PROGRAM_GUIDE}`,
    segment.image(path.join(PluginPath, 'resources', 'img', CAMP_ID_GUIDE_IMG)),
    Button.bind()
  ]
}
