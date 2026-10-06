import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import api from '../utils/api.js'
import { getImgType, Button, shouldQuote, AT_HEAD, stripAtText } from '#utils'

/**
 * `#查战力` —— 英雄在各省市/国服的**最低**战力线。
 *
 * 这个文件里有两块能脱开云崽单独看的东西，都放在类外面：
 *   · 元流之子的别名换算（输入展开、展示收缩）
 *   · 四个战力口径的最小值（模板拿它高亮「最低的那一档」）
 * 指令本身只剩「取参 → 查接口 → 交模板 → 回复」这条直线。
 */

/**
 * 元流之子的 5 个分身。接口只认半角括号的全名（`元流之子(法师)`），
 * 而群友习惯写「元法」这种缩写 —— 展开和收缩必须共用这张表，
 * 否则会出现「查得到、显示不出来」或者反过来的错位。
 */
const YUAN_FORMS = { 法: '法师', 射: '射手', 辅: '辅助', 坦: '坦克', 刺: '刺客' }

/** 输入侧展开：`元法` → `元流之子(法师)`；不是缩写就原样返回 */
function expandYuanName (name) {
  const abbr = name.match(/^元(.)$/)
  const form = abbr && YUAN_FORMS[abbr[1]]
  return form ? `元流之子(${form})` : name
}

/** 展示侧收缩：`元流之子(法师)` → `元法`。括号全半角都认，名字后头跟别的字也照收 */
function simplifyYuanName (text) {
  return String(text ?? '').replace(/元流之子\s*[（(]\s*(.)[^）)]*[）)]/g, '元$1')
}

/**
 * 战力的四个口径。顺序即模板里的展示顺序，也是 `minStats` 的键顺序。
 * 接口字段名直接当键用，所以这里同时是「字段名清单」。
 */
const POWER_FIELDS = ['guobiao', 'provincePower', 'cityPower', 'areaPower']

/**
 * 每个口径取所有区服里的最小值 —— 模板用它高亮「最低的那个区服」。
 * 数值化沿用 `Number(x || 0)`：接口偶尔给空串或 `null`，都要当 0 看。
 *
 * ⚠️ 形参名 `heroFightingCapacity` 是**故意**这么长的（不是 `rows`）：
 *    接口万一返回非数组，`.map` 抛的 TypeError 消息里带的就是这个形参名，
 *    会原样进 `logger.error`。日志文本属于行为，差分测试逐字节钉住了它。
 *
 * @param {object[]} heroFightingCapacity 接口返回的战力列表（调用方已确保非空）
 * @returns {{guobiao: number, provincePower: number, cityPower: number, areaPower: number}}
 */
function pickMinPowers (heroFightingCapacity) {
  const mins = {}
  for (const field of POWER_FIELDS) {
    mins[field] = Math.min(...heroFightingCapacity.map(row => Number(row[field] || 0)))
  }
  return mins
}

export class HeroFightingCapacity extends plugin {
  constructor () {
    super({
      name: '查询王者英雄战力',
      dsc: '查询英雄战力',
      event: 'message',
      priority: 5000,
      rule: [
        {
          // 原来是无前缀锚定的字面量正则，@ 一下机器人整条消息就匹配不上；
          // 改成 AT_HEAD 前缀的 RegExp 构造（loader 只要求 reg 是 RegExp 或可 new RegExp 的串）
          reg: new RegExp(`${AT_HEAD}#查战力[\\s\\S]*$`),
          fnc: 'checkHeroFightingCapacity'
        }
      ]
    })
  }

  async checkHeroFightingCapacity (e) {
    const heroName = stripAtText(e.msg).replace(/#|查战力|\s+|\n+/g, '').trim()
    if (!heroName) {
      await e.reply(['请输入要查询的英雄名称', Button.hero()])
      return
    }

    try {
      // ⚠️ 这个局部变量**必须**叫 `heroFightingCapacity`，不能顺手改成 `rows`：
      //   下面 `.map` 万一撞上接口返回非数组，TypeError 的消息里带的就是变量名
      //   （`heroFightingCapacity.map is not a function`），会原样进日志。
      //   差分测试逐字节钉住了这一行，改名 = 日志文本变了。
      const heroFightingCapacity = await api.getHeroFightingCapacity(expandYuanName(heroName))
      if (!heroFightingCapacity.length) {
        await e.reply('暂未查询到该英雄的战力数据')
        return
      }

      // 首条同时提供英雄名、别名和头像，其余条目只是各平台的战力行
      const [first] = heroFightingCapacity
      const displayName = simplifyYuanName(first.name)

      const img = await puppeteer.screenshot('HeroFightingCapacit', {
        imgType: getImgType(),
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/HeroFightingCapacit.html',
        photo: first.photo,
        name: displayName,
        alias: simplifyYuanName(first.alias),
        data: heroFightingCapacity,
        minStats: pickMinPowers(heroFightingCapacity)
      })

      // 英雄名认不出来时（接口没给 name）按钮退回用户输入的原词
      await e.reply([img, Button.hero(displayName || heroName)], shouldQuote())
    } catch (err) {
      logger.error(`[查战力] 查询失败: ${err}`)
      await e.reply(`查询失败!`)
    }
  }
}
