import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { renderMasterPanel } from '../utils/masterPanel.js'
import { Button, shouldQuote } from '#utils'

const helpSections = [
  {
    title: '账号管理',
    desc: '绑定与切换营地账号',
    theme: 'gold',
    icon: '账号',
    list: [
      { cmd: '#绑定营地', args: '[营地ID]', desc: '绑定你的营地账号' },
      { cmd: '#切换营地', args: '[序号]', desc: '切换当前使用的账号' },
      { cmd: '#删除营地', args: '[序号]', desc: '删除已绑定的账号' },
      { cmd: '#营地ID', alias: ['#王者ID', '#我的王者ID'], desc: '查看已绑定的账号列表及游戏名' },
      { cmd: '#获取营地ID', alias: ['#怎么看营地ID'], desc: '查看营地ID获取教程图' },
      { cmd: '#营地wx登录', desc: '扫码登录获取登录态' }
    ]
  },
  {
    title: '数据查询',
    desc: '战绩、战力与皮肤查询',
    theme: 'blue',
    icon: '查询',
    list: [
      { cmd: '#王者主页', alias: ['#王者卡片', '#王者信息'], args: '[序号/营地ID]', desc: '查看当前营地ID的主页' },
      { cmd: '#全部王者主页', alias: ['#全部主页'], desc: '查看已绑定全部营地ID的主页' },
      { cmd: '#查询战绩', args: '[序号]', desc: '查询近期对局战绩' },
      { cmd: '#排位战绩', args: '[序号]', desc: '只看排位赛战绩' },
      { cmd: '#巅峰战绩', args: '[序号]', desc: '只看巅峰赛战绩' },
      { cmd: '#查战绩', args: '<英雄名>', desc: '如 #查敖隐战绩 / #查战绩敖隐，英雄名放前后均可' },
      { cmd: '#查询N战绩', args: '[序号]', desc: '查询第N个绑定ID的战绩，如 #查询2排位战绩' },
      { cmd: '#排位表现', args: '[营地ID] [sNN]', desc: '排位赛表现，加 s40 看指定赛季' },
      { cmd: '#巅峰表现', args: '[营地ID] [sNN]', desc: '巅峰赛表现，加 s40 看指定赛季' },
      { cmd: '#赛季表现', args: '[营地ID] [sNN]', desc: '同一赛季的排位+巅峰合并成一张图' },
      { cmd: '#全部排位表现', alias: ['#全部赛季表现'], args: '[营地ID] [数量/all]', desc: '历史赛季排位总结，默认最近3个' },
      { cmd: '#全部巅峰表现', args: '[营地ID] [数量/all]', desc: '历史赛季巅峰总结，默认最近3个' },
      { cmd: '#常用英雄', alias: ['#英雄战力榜'], desc: '当前赛季排位/巅峰常用英雄，前5' },
      { cmd: '#我的英雄', args: '[营地ID] [数量]', desc: '全部英雄的战力/称号/场次/胜率，默认前10' },
      { cmd: '#查战力', args: '[英雄名]', desc: '查询指定英雄的战力' },
      { cmd: '#英雄梯度', alias: ['#梯度', '#强度'], args: '[段位] [分路]', desc: '查看英雄强度梯度榜' },
      { cmd: '#查皮肤', args: '[英雄名]', desc: '查询英雄的皮肤信息' },
      { cmd: '#皮肤墙', args: '[营地ID] [数量]', desc: '生成个人皮肤墙图片' },
      { cmd: '#全部皮肤', args: '[营地ID]', desc: '查看全部已拥有皮肤' },
      { cmd: '#缺皮肤', alias: ['#皮肤缺失', '#缺哪些皮肤'], args: '[英雄名/营地ID]', desc: '还差哪些皮肤，按价值排序' },
      { cmd: '#称号墙', alias: ['#荣耀称号', '#我的称号'], args: '[数量] [营地ID]', desc: '荣耀称号排名，默认扫战力前15的英雄' },
      { cmd: '#巅峰趋势', alias: ['#上分趋势', '#巅峰曲线'], args: '[天数] [营地ID]', desc: '巅峰分涨跌折线图，默认近14天' },
      { cmd: '#王者对比', alias: ['#对比'], args: '@某人 / [营地ID]', desc: '两个账号九项数据横向对比' }
    ]
  },
  {
    title: '排行榜',
    desc: '绑定用户之间的排名比拼',
    theme: 'gold',
    icon: '排名',
    list: [
      { cmd: '#排位排名', args: '[刷新]', desc: '本群成员的排位段位星数排名' },
      { cmd: '#巅峰排名', args: '[刷新]', desc: '本群成员的巅峰分排名' },
      { cmd: '#排位总排名', args: '[刷新]', desc: '全部绑定用户的排位排名' },
      { cmd: '#巅峰总排名', args: '[刷新]', desc: '全部绑定用户的巅峰分排名' }
    ]
  },
  {
    title: '战绩推送',
    desc: '打完自动推战绩，日报周报月报，上下线提醒',
    theme: 'blue',
    icon: '推送',
    list: [
      { cmd: '#开启战绩推送', desc: '在群里发送，打完自动播报战绩详情图' },
      { cmd: '#关闭战绩推送', desc: '取消战绩推送订阅' },
      { cmd: '#开启上下线提醒', desc: '上下线在群里播报，下线附带本次总结' },
      { cmd: '#关闭上下线提醒', desc: '取消上下线提醒订阅' },
      { cmd: '#战绩推送状态', alias: ['#战绩推送'], desc: '查看两个开关的状态与检查间隔' },
      { cmd: '#谁在打游戏', alias: ['#王者在线', '#在线列表'], desc: '本群谁正在对局中，不额外发请求' },
      { cmd: '#王者日报', alias: ['#战绩日报'], args: '[序号/营地ID]', desc: '今天的战绩总结图' },
      { cmd: '#王者周报', alias: ['#战绩周报'], args: '[序号/营地ID]', desc: '本周（周一起）的战绩总结图' },
      { cmd: '#王者月报', alias: ['#战绩月报'], args: '[序号/营地ID]', desc: '本月（1 号起）的战绩总结图' },
      { cmd: '#开启日报推送', desc: '每晚自动在本群发当日总结，没打就不发' },
      { cmd: '#开启周报推送', desc: '每周自动在本群发本周总结' },
      { cmd: '#开启月报推送', desc: '每月最后一晚发本月总结' },
      { cmd: '#关闭日报推送', alias: ['#关闭周报推送', '#关闭月报推送'], desc: '取消对应的自动推送' }
    ]
  },
  {
    title: '群战绩报告',
    desc: '本群成员的战绩排行榜，开关限群管理',
    theme: 'green',
    icon: '群报',
    list: [
      { cmd: '#群日报', alias: ['#王者群日报'], desc: '本群今天的战绩排行榜' },
      { cmd: '#群周报', alias: ['#王者群周报'], desc: '本群本周（周一起）的战绩排行榜' },
      { cmd: '#群月报', alias: ['#王者群月报'], desc: '本群本月（1 号起）的战绩排行榜' },
      { cmd: '#开启群日报推送', desc: '每晚自动在本群发排行榜，限群主/管理员/主人' },
      { cmd: '#开启群周报推送', desc: '每周自动在本群发排行榜' },
      { cmd: '#开启群月报推送', desc: '每月最后一晚发本月排行榜' },
      { cmd: '#关闭群日报推送', alias: ['#关闭群周报推送', '#关闭群月报推送'], desc: '取消对应的群推送' },
      { cmd: '#群报状态', alias: ['#群报推送状态'], desc: '查看本群三个开关与参与统计的账号数' }
    ]
  },
  {
    title: '主人指令',
    desc: '仅限主人使用',
    theme: 'orange',
    icon: '主人',
    master: true,
    list: [
      { cmd: '#王者设置', desc: '打开插件设置面板' },
      { cmd: '#王者用户统计', desc: '查看插件用户使用统计' },
      { cmd: '#营地wx全局登录', desc: '获取全局公共登录态' },
      { cmd: '#清理失效营地账号', desc: '清理已失效的绑定账号' },
      { cmd: '#共享营地账号', args: '[序号]', desc: '将账号共享给其他用户' },
      { cmd: '#取消共享营地账号', args: '[序号]', desc: '取消账号的共享状态' },
      { cmd: '#王者设置共享账号候选', args: '启用 / 关闭', desc: '开关共享账号候选功能' },
      { cmd: '#王者设置个人登录态兜底', args: '启用 / 关闭', desc: '开关个人登录态兜底' },
      { cmd: '#清空王者战绩推送', desc: '清空全部用户的战绩推送订阅' },
      { cmd: '#王者缓存状态', alias: ['#缓存信息'], desc: '查看图片缓存占用与内存缓存条目' },
      { cmd: '#清理王者缓存', desc: '按过期时间与容量上限清理图片缓存' }
    ]
  },
  {
    title: '系统指令',
    desc: '插件维护与更新',
    theme: 'green',
    icon: '系统',
    list: [
      { cmd: '#王者帮助', alias: ['#王者help'], desc: '显示本帮助面板' },
      { cmd: '#王者更新', alias: ['#王者强制更新'], desc: '更新插件到最新版本' },
      { cmd: '#王者更新日志', alias: ['#王者更新记录'], desc: '查看插件更新日志' }
    ]
  }
]

export class Help extends plugin {
  constructor() {
    super({
      name: '显示王者插件帮助信息',
      dsc: '显示帮助信息',
      event: 'message',
      priority: 1,
      rule: [
        {
          // 后面可跟关键词，如 #王者帮助 推送 —— 只出相关那几条，不必在 7 组长图里找
          reg: /^#?王者(荣耀|农药)?(插件|plugin)?(帮助|help)\s*(.*)$/i,
          fnc: 'showHelp'
        },
        {
          reg: /^#王者设置$/,
          fnc: 'showMasterPanel',
          permission: 'master'
        }
      ]
    })
  }

  async showHelp(e) {
    const keyword = (e.msg.match(/^#?王者(?:荣耀|农药)?(?:插件|plugin)?(?:帮助|help)\s*(.*)$/i)?.[1] || '').trim()
    const sections = keyword ? filterSections(helpSections, keyword) : helpSections

    if (!sections.length) {
      return e.reply(
        `没有找到和「${keyword}」相关的指令，发送 #王者帮助 看全部功能`,
        shouldQuote()
      )
    }

    try {
      const inventoryImage = await puppeteer.screenshot('help', {
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/help.html',
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        imgType: 'png',
        sections,
        keyword,
        generatedAt: new Date().toLocaleString()
      })
      if (!inventoryImage) throw new Error('截图返回空')
      await e.reply([inventoryImage, Button.help()], shouldQuote())
    } catch (error) {
      // 出图失败早先是直接往 loader 抛，用户端一点反馈都没有。
      // 帮助是「用户第一次接触插件」的入口，至少要退化成文字列表
      logger.error(`[王者帮助] 出图失败: ${error.message}`)
      await e.reply(renderTextHelp(sections, keyword), shouldQuote())
    }
  }

  async showMasterPanel(e) {
    await renderMasterPanel(e)
  }
}

/**
 * 按关键词过滤帮助分组。指令名、别名、说明、分组标题都参与匹配，
 * 命中的条目留下，整组都没命中就把这组去掉。
 */
function filterSections (sections, keyword) {
  const kw = keyword.toLowerCase()
  const hit = text => String(text || '').toLowerCase().includes(kw)

  return sections.reduce((out, section) => {
    // 分组标题命中就整组保留（如 #王者帮助 排行榜）
    if (hit(section.title) || hit(section.desc)) {
      out.push(section)
      return out
    }

    const list = section.list.filter(item =>
      hit(item.cmd) || hit(item.desc) || hit(item.args) || (item.alias || []).some(hit)
    )
    if (list.length) out.push({ ...section, list })
    return out
  }, [])
}

/** 出图失败时的纯文字兜底 */
function renderTextHelp (sections, keyword) {
  const lines = [keyword ? `🔍 王者插件指令（关键词：${keyword}）` : '📖 王者插件指令']

  for (const section of sections) {
    lines.push('', `【${section.title}】`)
    for (const item of section.list) {
      const args = item.args ? ` ${item.args}` : ''
      lines.push(`${item.cmd}${args} —— ${item.desc}`)
    }
  }

  lines.push('', '（出图失败，先用文字版顶一下）')
  return lines.join('\n')
}
