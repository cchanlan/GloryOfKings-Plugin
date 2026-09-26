import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { renderMasterPanel } from '../utils/masterPanel.js'
import { getImgType, Button, shouldQuote } from '#utils'

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
      { cmd: '#营地wx全局登录', desc: '微信扫码登录，自动绑定这个营地号，登录后可用 #营地观战' },
      { cmd: '#营地QQ全局登录', desc: 'QQ扫码登录，自动绑定这个营地号，登录后可用 #营地观战' }
    ]
  },
  {
    title: '营地ID共享',
    desc: '换机器人不用重新绑定营地ID',
    theme: 'blue',
    icon: '共享',
    list: [
      {
        cmd: '#开启营地ID共享',
        alias: ['#开启营地共享', '#打开营地共享'],
        desc: '把营地ID共享给别处的机器人，换个机器人不用重新绑定'
      },
      {
        cmd: '#关闭营地ID共享',
        alias: ['#取消营地共享'],
        desc: '取消共享，之前传上去的也会删掉。别的机器人几秒后就看不到了'
      },
      {
        cmd: '#营地ID共享状态',
        alias: ['#营地共享状态'],
        desc: '看看自己开没开共享、共享了哪些号'
      },
      {
        cmd: '#同步营地ID共享',
        desc: '把绑定立刻传上去，只推这一次，之后改绑定不会自动跟着走'
      }
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
      { cmd: '#英雄详情', args: '<英雄名>', desc: '单个英雄的生涯场次胜率、战力趋势、表现五维与最近对局' },
      { cmd: '#查询N战绩', args: '[序号]', desc: '查询第N个绑定ID的战绩，如 #查询2排位战绩' },
      { cmd: '#排位表现', args: '[营地ID] [sNN]', desc: '排位赛表现，加 s40 看指定赛季' },
      { cmd: '#巅峰表现', args: '[营地ID] [sNN]', desc: '巅峰赛表现，加 s40 看指定赛季' },
      { cmd: '#赛季表现', args: '[营地ID] [sNN]', desc: '同一赛季的排位+巅峰合并成一张图' },
      { cmd: '#全部排位表现', alias: ['#全部赛季表现'], args: '[营地ID] [数量/all]', desc: '历史赛季排位总结，默认最近3个' },
      { cmd: '#全部巅峰表现', args: '[营地ID] [数量/all]', desc: '历史赛季巅峰总结，默认最近3个' },
      { cmd: '#常用英雄', alias: ['#英雄战力榜'], desc: '当前赛季排位/巅峰常用英雄，前5' },
      { cmd: '#我的英雄', args: '[营地ID] [数量]', desc: '全部英雄的历史最高战力/称号/场次/胜率，默认前10' },
      { cmd: '#查战力', args: '[英雄名]', desc: '查询指定英雄的战力' },
      { cmd: '#英雄梯度', alias: ['#梯度', '#强度'], args: '[段位] [分路]', desc: '查看英雄强度梯度榜' },
      { cmd: '#英雄攻略', alias: ['#出装', '#克制', '#铭文'], args: '<英雄名>', desc: '出装/铭文/核心装备胜率/英雄关系/技能' },
      { cmd: '#查皮肤', args: '[英雄名]', desc: '查询英雄的皮肤信息' },
      { cmd: '#皮肤上新', alias: ['#新皮肤', '#皮肤日历'], desc: '即将上线与最近上线的皮肤' },
      { cmd: '#皮肤墙', args: '[营地ID] [数量]', desc: '生成个人皮肤墙图片' },
      { cmd: '#全部皮肤', args: '[营地ID]', desc: '查看全部已拥有皮肤' },
      { cmd: '#缺皮肤', alias: ['#皮肤缺失', '#缺哪些皮肤'], args: '[英雄名/营地ID]', desc: '还差哪些皮肤，按价值排序' },
      { cmd: '#称号墙', alias: ['#荣耀称号', '#我的称号'], args: '[数量] [营地ID]', desc: '荣耀称号排名，默认扫战力前15的英雄' },
      { cmd: '#巅峰趋势', alias: ['#上分趋势', '#巅峰曲线'], args: '[天数] [营地ID]', desc: '巅峰分涨跌折线图，默认近14天' },
      { cmd: '#段位趋势', alias: ['#排位趋势', '#段位曲线'], args: '[天数] [营地ID]', desc: '段位升降阶梯图，打排位的看这个' },
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
    title: '营地观战',
    desc: '看营地好友谁在打，挑一个开直播',
    theme: 'gold',
    icon: '观战',
    list: [
      { cmd: '#观战', desc: '短别名，等价于 #营地观战（本组所有子指令都能用，如 #观战 在播）' },
      { cmd: '#营地观战', desc: '看自己营地好友里谁正在对局，图上有编号（要先全局登录）' },
      { cmd: '#营地观战', args: '<编号>', desc: '开一路直播，群友点链接就能看，手机上也能看' },
      { cmd: '#营地观战', args: '列表', desc: '同上：看谁正在对局（别名，和直接发 #营地观战 一样）' },
      { cmd: '#营地观战', args: '在播', desc: '看现在有哪几路直播在跑，编号带「你开的」标记（也认「正在播」「直播间」「rooms」）' },
      { cmd: '#营地观战', args: '停', desc: '停自己开的直播间，别人在看的不受影响（也认「停止」「关」「关闭」「stop」）' },
      { cmd: '#营地观战', args: '停 <编号>', desc: '停指定的一路（编号看 #营地观战 在播）' },
      { cmd: '#营地观战', args: '停 全部', desc: '停掉全部直播间，别人开的也会停（也认「全停」「关闭全部」「全关」「全部关」）' },
      { cmd: '#营地开播', desc: '开「本群最近提示的那一场」——订阅上下线的人开局满几分钟后，群里会收到开播提示' },
      { cmd: '#营地观战连接', args: '<地址>', desc: '用别人部署好的观战服务：只填地址，本机什么都不用装（地址找部署方要）——请主人发' },
      { cmd: '#营地观战接入', args: '<地址> <令牌>', desc: '自己部署一套观战服务：接入分发服务并立刻安装（地址和令牌进群 972915804 找主人要）——请主人发' },
      { cmd: '#营地观战部署', desc: '用已配好的地址和令牌部署 / 更新观战服务（pm2 托管、开机自启）——请主人发' },
      { cmd: '#营地观战服务', desc: '看观战服务跑没跑、ffmpeg 就绪没、对外地址配了没——请主人发' }
    ]
  },
  {
    title: '营地消息',
    desc: '营地好友发来的消息转到 QQ 私信，也能主动发（仅私聊）',
    theme: 'green',
    icon: '消息',
    list: [
      { cmd: '引用那条推送回一句', desc: '直接回复对方——引用机器人发的营地消息推送，发你想说的话' },
      { cmd: '#营地回复', args: '<营地号> <内容>', desc: '不用引用也行，指定用哪个号回' },
      { cmd: '#营地好友', desc: '看在游戏里的好友，图上有编号（只认私聊）' },
      { cmd: '#营地私聊', args: '<编号> <内容>', desc: '按编号给 TA 发消息（只认私聊）' },
      { cmd: '#营地消息', desc: '看服务状态、哪些号在线、还有多少条待处理' },
      { cmd: '#营地消息开', alias: ['#营地消息开启', '#营地消息打开', '#营地消息收'], desc: '让自己名下的营地号开始收消息（扫过的号默认只用来查询，要收得自己开）' },
      { cmd: '#营地消息关', alias: ['#营地消息关闭', '#营地消息停止', '#营地消息不收'], desc: '让自己名下的营地号不再收消息' },
      { cmd: '#营地消息连接', args: '<地址>', desc: '用别人部署好的营地消息服务：只填地址，本机什么都不用装（地址找部署方要）——请主人发' },
      { cmd: '#营地消息接入', args: '<地址> <令牌>', desc: '自己部署一套营地消息服务：接入分发服务并立刻安装（地址和令牌进群 972915804 找主人要）——请主人发' },
      { cmd: '#营地消息部署', desc: '用已配好的地址和令牌部署 / 更新营地消息服务（pm2 托管）——请主人发' },
      { cmd: '#营地消息服务', desc: '看营地消息服务跑没跑、各号连上没有——请主人发' },
      { cmd: '#营地消息同步', alias: ['#营地消息重连'], desc: '按锅巴里的开关重新连账号——请主人发' }
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
      { cmd: '#开启在线状态', alias: ['#开启在线状态展示'], desc: '取消隐身，重新出现在 #谁在打游戏 名单里' },
      { cmd: '#关闭在线状态', alias: ['#关闭在线状态展示'], desc: '隐身，不出现在 #谁在打游戏 名单里' },
      { cmd: '#战绩推送状态', alias: ['#战绩推送'], desc: '查看三个开关的状态与检查间隔' },
      { cmd: '#谁在打游戏', alias: ['#谁在打王者', '#谁在玩王者', '#谁在上号', '#谁在排位', '#王者在线', '#王者在线列表', '#王者在线状态', '#在线列表'], desc: '本群谁在对局中、打了多久；在线状态在你查看时现刷' },
      { cmd: '#王者日报', alias: ['#战绩日报'], args: '[序号/营地ID]', desc: '今天的战绩总结图' },
      { cmd: '#王者周报', alias: ['#战绩周报'], args: '[序号/营地ID]', desc: '本周（周一起）的战绩总结图' },
      { cmd: '#王者月报', alias: ['#战绩月报'], args: '[序号/营地ID]', desc: '本月（1 号起）的战绩总结图' },
      { cmd: '#开启日报推送', desc: '每晚自动在本群发当日总结，没打就不发' },
      { cmd: '#开启周报推送', desc: '每周自动在本群发本周总结' },
      { cmd: '#开启月报推送', desc: '每月最后一晚发本月总结' },
      { cmd: '#关闭日报推送', alias: ['#关闭周报推送', '#关闭月报推送'], desc: '取消对应的自动推送' },
      { cmd: '#导出战绩', alias: ['#战绩导出'], args: '[天数/营地ID]', desc: '把本地战绩归档导成 CSV 发出来' },
      { cmd: '#开启皮肤上新推送', alias: ['#关闭皮肤上新推送'], desc: '新皮肤进清单/今天上线时在本群播报，限群管理' }
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
    // 只在主人私聊里渲染 —— 群聊里贴出去等于把这些指令广播给全群
    ownerOnly: true,
    list: [
      { cmd: '#王者设置', desc: '打开插件设置面板' },
      { cmd: '#王者用户统计', desc: '查看插件用户使用统计' },
      { cmd: '#清理失效营地账号', desc: '清理已失效的绑定账号' },
      { cmd: '#清空王者战绩推送', desc: '清空全部用户的战绩推送订阅' },
      { cmd: '#王者拉黑', args: '@某人 / [QQ号]', desc: '让他触发不了任何王者功能，已订阅的推送也停掉' },
      { cmd: '#王者取消拉黑', args: '@某人 / [QQ号]', desc: '移出黑名单，指令和推送都恢复' },
      { cmd: '#王者黑名单', desc: '查看当前黑名单' },
      { cmd: '#王者缓存状态', alias: ['#缓存信息'], desc: '查看图片缓存占用与内存缓存条目' },
      { cmd: '#清理王者缓存', desc: '按过期时间与容量上限清理图片缓存' },
      { cmd: '#王者数据备份', desc: '打包数据与配置私发给主人（含凭证，仅私聊）' },
      { cmd: '#王者备份列表', desc: '查看服务器上已有的备份' },
      { cmd: '#营地续期', desc: '手动保活一遍营地登录态（定时任务每天也会自动跑），失效的 QQ 号顺手用登录凭证救回来' },
      { cmd: '#营地共享库', desc: '查看营地ID共享库的接入状态与设置' },
      { cmd: '#营地共享库发令牌', args: '<备注>', alias: ['#营地共享发令牌'], desc: '给别人的机器人签一个令牌；@一下群友就直接私聊发给 TA' },
      { cmd: '#营地共享库接入方', alias: ['#营地共享接入方'], desc: '看谁在用你的共享库，带最后请求时间' },
      { cmd: '#营地共享库吊销', args: '<序号>', alias: ['#营地共享吊销'], desc: '踢掉某个接入方，对方就查不了你这个库了' },
      { cmd: '#营地共享库同步', alias: ['#营地共享同步'], desc: '把你自己和本机开过共享的人一起对上库，谁没传上去补谁' },
      { cmd: '#营地共享库查', args: '<QQ>', alias: ['#营地共享查'], desc: '问库里有这个 QQ 的记录没，排查「对方说我没绑定」用' },
      { cmd: '#接入营地共享库', alias: ['#关闭营地共享库'], desc: '接入 / 关闭某个共享库（地址和令牌进群 972915804 找主人要）' },
      { cmd: '#营地共享库地址', args: '<地址>', desc: '设置共享库地址（http/https）' },
      { cmd: '#营地共享库令牌', args: '<令牌>', desc: '设置接入令牌 —— 观战 / 营地消息 / 共享库三套共用这一个' },
      { cmd: '#营地共享库管理密钥', args: '<密钥>', desc: '库跑在别的机器/Docker 上时，配它就能远程签令牌 / 看接入方 / 吊销' },
      { cmd: '#营地共享库提醒', desc: '重新私聊发一次接入提醒' },
    ]
  },
  {
    title: '系统指令',
    desc: '插件维护与更新',
    theme: 'green',
    icon: '系统',
    // 同上：维护类指令不给普通用户看
    ownerOnly: true,
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
    let sections = keyword ? filterSections(helpSections, keyword) : helpSections

    // 「主人指令」「系统指令」只在主人私聊里出现。群聊里贴出去等于把主人专属指令的
    // 名字和用法广播给全群；普通用户更不需要看这些。过滤放在关键词筛选之后，
    // 非主人拿这些词去搜也只会得到「没找到」（不暴露它们存在）。
    if (!(e.isMaster && !e.isGroup)) sections = sections.filter(section => !section.ownerOnly)

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
        imgType: getImgType(),
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
