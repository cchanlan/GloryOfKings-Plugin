import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { Config } from '#components'
import authStore from './authStore.js'
import { getImgType } from './imageType.js'

/**
 * 主人面板（`#王者设置` / `#营地共享库`）的数据构造与出图。
 *
 * 面板只回答两件事：**现在有几个号、还能不能用**。
 *
 * `buildMasterPanelData` 刻意做成不碰 puppeteer 的纯函数（输入只有配置和账号池），
 * 这样能脱机断言「什么池子状态出什么面板」，不用为了验数据去起一次浏览器。
 * 出图那半在 `renderMasterPanel`，它只负责把数据交给模板。
 */

/** 面板色调。值就是模板里的 class 名，改这里等于改样式 */
const TONE = {
  neutral: 'neutral',
  on: 'on',
  off: 'off',
  warn: 'warn'
}

/** 账号 ID 的脱敏展示：留头尾、中间打星。空值给「未配置」而不是空白，免得看着像漏了一行 */
function maskAccountId (value, keepStart = 3, keepEnd = 3) {
  const text = String(value || '')
  if (!text) {
    return '未配置'
  }
  if (text.length <= keepStart + keepEnd) {
    return text
  }
  return `${text.slice(0, keepStart)}***${text.slice(-keepEnd)}`
}

/**
 * 账号池分档：全局账号、可用账号、失效账号。
 *
 * 面板上每一行都要用到其中两三个数，原先是在函数体里 filter 了四五次
 * （每次都重新遍历整个池子），这里一次分好，下面的行只做取值。
 */
function groupAccounts (accounts) {
  const globals = accounts.filter(account => account.isGlobalDefault)
  const usableGlobals = globals.filter(account => !account.authInvalid)

  return {
    globals,
    usableGlobals,
    // 多个全局账号 = 轮询池，请求在它们之间轮换
    // （轮转在 api.js 的 #rotateGlobals，authStore.getAuthCandidates 只负责给全）
    rotating: usableGlobals.length > 1
  }
}

export function buildMasterPanelData () {
  // 读一次配置：面板本身不展示 auth 段，但这个调用会顺带把配置加载好，
  // 后面的取值不会再各读一次文件。行为上不能省。
  Config.getDefOrConfig('auth')

  const accounts = authStore.listAccounts()
  const { globals, usableGlobals, rotating } = groupAccounts(accounts)
  const invalidCount = accounts.filter(account => account.authInvalid).length

  // 候选池现在只有全局账号这一类（共享账号、个人兜底都已删）
  const candidateOrder = rotating ? `全局账号（${usableGlobals.length} 个轮询）` : '默认全局账号'

  return {
    generatedAt: new Date().toLocaleString(),
    strategyRows: [
      {
        label: '候选及鉴权顺序',
        value: candidateOrder,
        desc: '请求按此顺序选号',
        tone: TONE.neutral
      },
      {
        label: rotating ? '全局账号池' : '默认全局账号',
        // value 只给数字，账号明细放 desc：这行的 value 早先是「把 5 个号全列出来」，
        // 而 .row-val 是 nowrap，长列表会把左边挤成**一个字一行**的竖排（实测截图）。
        value: globals.length ? `${usableGlobals.length} 个可用` : '未配置',
        desc: globals.length
          ? `${rotating ? '请求在其间轮换' : '当前使用'}：${globals.map(account => `${maskAccountId(account.userId)}${account.authInvalid ? '(失效)' : ''}`).join('、')}`
          : '配置指令：#营地wx全局登录 / #营地QQ全局登录 (刷新全局鉴权)',
        tone: usableGlobals.length ? TONE.on : (globals.length ? TONE.off : TONE.warn)
      }
    ],
    summaryRows: [
      { label: '账号总数', value: String(accounts.length), tone: TONE.neutral },
      { label: '可用账号', value: String(accounts.length - invalidCount), tone: TONE.on },
      { label: '失效账号', value: String(invalidCount), tone: invalidCount ? TONE.off : TONE.neutral }
    ],
    commandGroups: [
      {
        title: '排查与维护',
        items: [
          { command: '#王者设置', desc: '查看本面板与链路状态' },
          { command: '#王者用户统计', desc: '精简版绑定情况统计' },
          { command: '#清理失效营地账号', desc: '移除无法使用的登录态' },
          { command: '#隐藏主页名单 / #清除隐藏主页', desc: '隐藏主页的号' }
        ]
      },
      {
        title: '账号与更新',
        items: [
          { command: '#营地wx全局登录', desc: '扫码写入或更新，可多个' },
          { command: '#营地QQ全局登录', desc: 'QQ 扫码写入或更新，可多个' },
          { command: '#王者更新 / #农药更新', desc: '拉取最新插件代码' },
          { command: '#王者更新记录', desc: '查看近期更新功能' }
        ]
      }
    ]
  }
}

/**
 * 渲染面板并发出去。
 *
 * ⚠️ `tplFile` / `_res_path` 必须写成**相对云崽根**的路径，渲染器是直接
 * `readFileSync` 它的；写成绝对路径或相对插件目录都会静默取不到模板。
 */
export async function renderMasterPanel (e) {
  const panelImage = await puppeteer.screenshot('helpConfig', {
    imgType: getImgType(),
    tplFile: 'plugins/GloryOfKings-Plugin/resources/html/helpConfig.html',
    _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
    ...buildMasterPanelData()
  })

  // ⚠️ screenshot 失败返回 false 而不抛错（2026-10-06 修）：不判空会把 false 当文本段
  //    发给主人，而「面板出图失败」正是最该给一句人话的时候（主人只会看到一条 false）。
  if (!panelImage) return e.reply('面板出图失败，稍后再试')
}
