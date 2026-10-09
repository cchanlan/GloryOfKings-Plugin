import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { renderMasterPanel } from '../utils/masterPanel.js'
import { getImgType, Button, shouldQuote } from '#utils'

/**
 * 默认帮助图（`#王者帮助`）只展开「账号管理 / 数据查询 / 排行榜 / 王者公告」四组，
 * 而且数据查询里只剩主页和对比 —— 战绩、英雄、皮肤三块各自收成一个入口。
 *
 * 其余分块（营地三块 + 战绩两块）也一样，默认图里**只给入口**：
 *   · 数据查询下面挂 #查询战绩帮助 / #英雄相关帮助 / #皮肤帮助
 *   · 「营地相关」下面挂 #营地ID共享帮助 / #营地观战帮助 / #营地消息帮助
 *   · 「战绩推送」下面挂 #战绩推送帮助 / #群战绩报告帮助
 * 发哪条入口，就单独渲染那一块的具体指令（见下面 `subHelpSections`）。
 *
 * ⚠️ 新加指令时记住这条链：默认图（本数组）→ 子帮助（`subHelpSections`）→ 文字兜底
 *    （`renderTextHelp`）→ README。缺一环用户就找不到。
 */
const helpSections = [
  {
    title: '账号管理',
    desc: '绑定与切换营地账号',
    theme: 'gold',
    icon: '账号',
    list: [
      { cmd: '#绑定营地', args: '[营地ID]', desc: '绑定你的营地账号；不带营地ID就直接出「营地ID从哪看」的教程图' },
      { cmd: '#切换营地', args: '[序号]', desc: '切换当前使用的账号' },
      { cmd: '#删除营地', args: '[序号]', desc: '删除已绑定的账号' },
      // ⚠️ 别名要写全：正则认 7 种写法（`#(?:营地|我的(?:王者|荣耀|农药)|(?:王者|荣耀|农药))ID`），
      //    早先只列了 3 种，「荣耀/农药」那 4 个等于对用户不存在
      { cmd: '#营地ID', alias: ['#王者ID', '#荣耀ID', '#农药ID', '#我的王者ID', '#我的荣耀ID', '#我的农药ID'], desc: '查看已绑定的账号列表及游戏名' },
      { cmd: '#营地wx全局登录', desc: '微信扫码登录，自动绑定这个营地号，登录后可用 #营地观战' },
      { cmd: '#营地QQ全局登录', desc: 'QQ扫码登录，自动绑定这个营地号，登录后可用 #营地观战' },
      // ⚠️ 这里**不能**写 `alias: ['#签到']`：裸 `#签到` / `#签到状态` 是
      //    xhh-TL 米游社插件的指令（`^\s*#?(?:自动)?签到(?:列表|状态|查询)\s*$`），
      //    而王者插件 priority 更高（0 vs -Infinity）会把它抢过来 ——
      //    用户想查米游社签到却收到一张营地签到图。代码里只认 `#王者签到`，
      //    文档必须跟代码一致（早先这里漏删过）。
      // ⚠️ 说明里要写明「每天会自动签」—— 用户不知道有定时的话，
      //    会以为自己必须天天记得发这条指令
      { cmd: '#王者签到', desc: '给名下每个营地号领当天签到奖励（每天 7:30 也会自动签，结果私聊你）' },
      { cmd: '#王者签到状态', desc: '只看不签：今天签没签、连续几天、本周还差几天满签' }
    ]
  },
  {
    title: '数据查询',
    desc: '主页与对比，细分看下面的入口',
    theme: 'blue',
    icon: '查询',
    list: [
      { cmd: '#王者主页', alias: ['#王者卡片', '#王者信息'], args: '[序号/营地ID]', desc: '查看当前营地ID的主页' },
      { cmd: '#全部王者主页', alias: ['#全部主页'], desc: '查看已绑定全部营地ID的主页' },
      { cmd: '#王者对比', args: '@某人 / [营地ID]', desc: '两个账号九项数据横向对比' },
      { cmd: '#查询战绩帮助', desc: '战绩、赛季表现、巅峰与段位趋势' },
      { cmd: '#英雄相关帮助', desc: '英雄详情、战力、梯度、攻略与称号墙' },
      { cmd: '#皮肤帮助', desc: '皮肤查询、皮肤墙、缺失统计与上新' }
    ]
  },
  {
    title: '排行榜',
    desc: '绑定用户之间的排名比拼',
    theme: 'gold',
    icon: '排名',
    list: [
      // 排位 / 巅峰各两条、一共四条，但它们是**同一件事的两个口径**（本群 vs 全部），
      // 所以每条只占一张卡，另一个口径挂在别名上（同 #观战 的处理，见 subHelpSections.watch）。
      // 说明里两个口径都写上，不然用户以为 `#巅峰排名` 和 `#排位排名` 是一回事。
      { cmd: '#排位排名', alias: ['#巅峰排名'], args: '[刷新]', desc: '本群成员的排位星数 / 巅峰分排名' },
      { cmd: '#排位总排名', alias: ['#巅峰总排名'], args: '[刷新]', desc: '全部绑定用户的排位 / 巅峰分排名' }
    ]
  },
  {
    title: '王者公告',
    desc: '官网公告与资讯',
    theme: 'blue',
    icon: '公告',
    list: [
      { cmd: '#王者公告', alias: ['#王者资讯'], desc: '最新一期公告的完整正文' },
      { cmd: '#王者公告列表', alias: ['#王者资讯列表'], desc: '最近的公告标题清单' }
    ]
  },
  {
    title: '营地相关',
    desc: '营地ID共享 / 观战 / 消息，发下面的指令看详细',
    theme: 'green',
    icon: '营地',
    list: [
      { cmd: '#营地币', alias: ['#营地余额'], desc: '查营地币余额（签到与营地任务的奖励就是这个）' },
      { cmd: '#营地商城', args: '[页码]', desc: '逛营地商城，看皮肤/英雄/道具的价格与是否已拥有' },
      { cmd: '#营地ID共享帮助', desc: '换机器人不用重新绑定营地ID' },
      { cmd: '#营地观战帮助', desc: '看营地好友谁在打，挑一个开直播' },
      { cmd: '#营地消息帮助', desc: '营地好友消息转到 QQ 私信，也能主动发' }
    ]
  },
  {
    title: '战绩推送',
    desc: '打完自动推战绩、日报周报，本群排行榜',
    theme: 'blue',
    icon: '推送',
    list: [
      { cmd: '#战绩推送帮助', desc: '打完自动播报、日周月报、上下线提醒' },
      { cmd: '#群战绩报告帮助', desc: '本群成员的战绩排行榜' }
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
      { cmd: '#隐藏主页名单', desc: '查看被隐藏主页的账号（这些号查不了主页/战绩）' },
      // ⚠️ 参数不能写成可选（2026-10-06 修）：实现里 `!arg` 是**回一句用法提示并 return**，
      //    真正清全部必须显式发 all（见 accountManager 的 `#清除隐藏主页`）。
      //    原先写「不带 ID 就全部清除」会让主人以为已经清完了，实际什么都没做、还不报错。
      { cmd: '#清除隐藏主页', args: '<营地ID> | all', desc: '解除指定营地ID的隐藏主页限制；发 all 清除全部' },
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

/**
 * 子帮助：入口指令 → 那一块的具体指令。
 *
 * 字段和 `helpSections` 完全一致，渲染走的是同一个模板 `help.html`。
 *
 * ⚠️ 条目上的 `ownerOnly: true` = **只在主人私聊里出现**（组照常留下，只摘掉那几条）。
 *    观战 / 营地消息的运维指令（连接、接入、部署、服务、同步）都归主人，
 *    普通用户既用不上、也不该看见。
 */
const subHelpSections = {
  record: {
    title: '查询战绩',
    desc: '战绩、赛季表现与趋势图',
    theme: 'blue',
    icon: '战绩',
    list: [
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
      { cmd: '#巅峰趋势', alias: ['#上分趋势', '#巅峰曲线'], args: '[天数] [营地ID]', desc: '巅峰分涨跌折线图，默认近14天' },
      { cmd: '#段位趋势', alias: ['#排位趋势', '#段位曲线'], args: '[天数] [营地ID]', desc: '段位升降阶梯图，打排位的看这个' }
    ]
  },
  hero: {
    title: '英雄相关',
    desc: '英雄数据、战力、梯度与称号',
    theme: 'gold',
    icon: '英雄',
    list: [
      { cmd: '#英雄详情', args: '<英雄名>', desc: '单个英雄的生涯场次胜率、战力趋势、表现五维与最近对局' },
      { cmd: '#常用英雄', alias: ['#英雄战力榜'], desc: '当前赛季排位/巅峰常用英雄，前5' },
      { cmd: '#我的英雄', args: '[营地ID] [数量]', desc: '全部英雄的历史最高战力/称号/场次/胜率，默认前10' },
      { cmd: '#查战力', args: '[英雄名]', desc: '查询指定英雄的战力' },
      { cmd: '#英雄梯度', alias: ['#梯度', '#强度'], args: '[段位] [分路]', desc: '查看英雄强度梯度榜' },
      { cmd: '#英雄攻略', alias: ['#出装', '#克制', '#铭文'], args: '<英雄名>', desc: '出装/铭文/核心装备胜率/英雄关系/技能' },
      { cmd: '#称号墙', alias: ['#荣耀称号', '#我的称号'], args: '[数量] [营地ID]', desc: '荣耀称号排名，默认扫战力前15的英雄' }
    ]
  },
  skin: {
    title: '皮肤',
    desc: '皮肤查询、皮肤墙与缺失统计',
    theme: 'blue',
    icon: '皮肤',
    list: [
      { cmd: '#查皮肤', args: '[英雄名]', desc: '查询英雄的皮肤信息' },
      { cmd: '#皮肤上新', alias: ['#新皮肤', '#皮肤日历'], desc: '即将上线与最近上线的皮肤' },
      { cmd: '#皮肤墙', args: '[营地ID] [数量]', desc: '生成个人皮肤墙图片' },
      { cmd: '#全部皮肤', args: '[营地ID]', desc: '查看全部已拥有皮肤' },
      { cmd: '#缺皮肤', alias: ['#皮肤缺失', '#缺哪些皮肤'], args: '[英雄名/营地ID]', desc: '还差哪些皮肤，按价值排序' }
    ]
  },
  share: {
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
  watch: {
    title: '营地观战',
    desc: '看营地好友谁在打，挑一个开直播',
    theme: 'gold',
    icon: '观战',
    list: [
      { cmd: '#营地观战', alias: ['#观战'], desc: '看自己营地好友里谁正在对局，图上有编号（要先全局登录）；#观战 是短别名，本组子指令都能用' },
      { cmd: '#营地观战', args: '<编号>', desc: '开一路直播，群友点链接就能看，手机上也能看' },
      { cmd: '#营地观战', args: '列表', desc: '同上：看谁正在对局（别名，和直接发 #营地观战 一样）' },
      { cmd: '#营地观战', args: '在播', desc: '看现在有哪几路直播在跑，编号带「你开的」标记（也认「正在播」「直播间」「rooms」）' },
      { cmd: '#营地观战', args: '停', desc: '停自己开的直播间，别人在看的不受影响（也认「停止」「关」「关闭」「stop」）' },
      { cmd: '#营地观战', args: '停 <编号>', desc: '停指定的一路（编号看 #营地观战 在播）' },
      { cmd: '#营地观战', args: '停 全部', desc: '停掉全部直播间，别人开的也会停（也认「全停」「关闭全部」「全关」「全部关」）' },
      { cmd: '#观战大神', desc: '随机开 10 路高端局直播（排位 5 + 巅峰 5），群友点链接直接看，不用先加好友' },
      { cmd: '#观战大神', args: '<分路>', desc: '只开某个分路的大神：对抗路 / 打野 / 中路 / 发育路 / 游走' },
      { cmd: '#观战大神', args: '在播', desc: '看现在有哪几路在跑（和 #营地观战 在播 是同一批房间）' },
      { cmd: '#观战大神', args: '停', desc: '停自己开的那几路（「停 <编号>」「停 全部」也认，用法同 #营地观战）' },
      { cmd: '#营地开播', desc: '开本群最近提示的那一场；引用那条提示发就开提示里那一个' },
      { cmd: '#营地观战', args: '确认中断', desc: '账号都被占着时机器人会问要不要中断上一路，用它确认（也认「确认」）' },
      { cmd: '#营地观战', args: '继续等', desc: '不中断，继续看现在这一路（也认「算了」「取消」）' },
      { cmd: '#营地观战连接', args: '<地址>', ownerOnly: true, desc: '用别人部署好的观战服务：只填地址，本机什么都不用装（地址找部署方要）' },
      { cmd: '#营地观战接入', args: '<地址> <令牌>', ownerOnly: true, desc: '自己部署一套观战服务：接入分发服务并立刻安装（地址和令牌进群 972915804 找主人要）' },
      { cmd: '#营地观战部署', ownerOnly: true, desc: '用已配好的地址和令牌部署 / 更新观战服务（pm2 托管、开机自启）' },
      { cmd: '#营地观战服务', ownerOnly: true, desc: '看观战服务跑没跑、ffmpeg 就绪没、对外地址配了没' }
    ]
  },
  im: {
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
      { cmd: '#营地消息连接', args: '<地址>', ownerOnly: true, desc: '用别人部署好的营地消息服务：只填地址，本机什么都不用装（地址找部署方要）' },
      { cmd: '#营地消息接入', args: '<地址> <令牌>', ownerOnly: true, desc: '自己部署一套营地消息服务：接入分发服务并立刻安装（地址和令牌进群 972915804 找主人要）' },
      { cmd: '#营地消息部署', ownerOnly: true, desc: '用已配好的地址和令牌部署 / 更新营地消息服务（pm2 托管）' },
      { cmd: '#营地消息服务', ownerOnly: true, desc: '看营地消息服务跑没跑、各号连上没有' },
      { cmd: '#营地消息同步', alias: ['#营地消息重连'], ownerOnly: true, desc: '按锅巴里的开关重新连账号' }
    ]
  },
  push: {
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
      { cmd: '#开启皮肤上新推送', alias: ['#关闭皮肤上新推送'], desc: '新皮肤进清单/今天上线时在本群播报，限群管理' },
      { cmd: '#开启王者公告推送', alias: ['#关闭王者公告推送'], desc: '官网出新公告时在本群播报，限群管理' }
    ]
  },
  groupReport: {
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
  }
}

/**
 * 子帮助入口词（**不含** `#` 前缀和「帮助」后缀）。
 *
 * ⚠️ 只在这里写一次 —— 下面的 `SUB_HELP_REG`（注册规则用）和运行时解析都由它拼出来，
 *    加一条入口只改这个数组，不会出现「注册了但解析不出来」的半截状态。
 */
const SUB_HELP_WORDS = [
  { key: 'record', word: '查询战绩' },
  { key: 'hero', word: '英雄(?:相关)?' },
  { key: 'skin', word: '皮肤' },
  { key: 'share', word: '营地(?:ID)?共享' },
  { key: 'watch', word: '(?:营地)?观战' },
  { key: 'im', word: '营地消息' },
  { key: 'push', word: '战绩推送' },
  { key: 'groupReport', word: '群战绩报告' }
].map(item => ({ ...item, reg: new RegExp(`^#?${item.word}帮助$`, 'i') }))

const SUB_HELP_REG = new RegExp(`^#?(?:${SUB_HELP_WORDS.map(i => `${i.word}帮助`).join('|')})$`, 'i')

export class Help extends plugin {
  constructor() {
    super({
      name: '显示王者插件帮助信息',
      dsc: '显示帮助信息',
      event: 'message',
      // ⚠️ 必须是负的：`#营地观战帮助` 会被 apps/watchBattle.js 那条宽匹配
      //    `#(?:营地)?观战\s*(.*)$`（priority 0）吃掉，掉进序号解析里报一句「编号不对」。
      //    云崽按 priority **从小到大**依次执行，这里抢在它前面 return。
      //    （watchBattle 那边另有一道放行兜底，防 priority 语义变化。）
      priority: -1,
      rule: [
        {
          // 后面可跟关键词，如 #王者帮助 推送 —— 只出相关那几条，不必在整组长图里找
          reg: /^#?王者(荣耀|农药)?(插件|plugin)?(帮助|help)\s*(.*)$/i,
          fnc: 'showHelp'
        },
        {
          // 子帮助入口：发哪条就单独渲染那一块的具体指令
          reg: SUB_HELP_REG,
          fnc: 'showSubHelp'
        },
        {
          reg: /^#王者设置$/,
          fnc: 'showMasterPanel',
          permission: 'master'
        }
      ]
    })
  }

  async showHelp (e) {
    const keyword = (e.msg.match(/^#?王者(?:荣耀|农药)?(?:插件|plugin)?(?:帮助|help)\s*(.*)$/i)?.[1] || '').trim()
    let sections = keyword ? filterSections(helpSections, keyword) : helpSections

    // 「主人指令」「系统指令」只在主人私聊里出现。群聊里贴出去等于把主人专属指令的
    // 名字和用法广播给全群；普通用户更不需要看这些。过滤放在关键词筛选之后，
    // 非主人拿这些词去搜也只会得到「没找到」（不暴露它们存在）。
    sections = stripOwnerOnly(sections, e)

    if (!sections.length) {
      return e.reply(
        `没有找到和「${keyword}」相关的指令，发送 #王者帮助 看全部功能`,
        shouldQuote()
      )
    }

    await this.renderHelp(e, sections, keyword)
  }

  /** 子帮助：`#查询战绩帮助` / `#英雄相关帮助` / `#皮肤帮助` / `#营地观战帮助` 等 */
  async showSubHelp (e) {
    const text = String(e.msg || '').trim()
    const key = SUB_HELP_WORDS.find(item => item.reg.test(text))?.key
    const section = subHelpSections[key]
    if (!section) return false

    const sections = stripOwnerOnly([section], e)
    if (!sections.length) return e.reply('这条指令只有主人私聊能用', shouldQuote())

    await this.renderHelp(e, sections)
  }

  async showMasterPanel (e) {
    await renderMasterPanel(e)
  }

  /** 出帮助图；出图失败退化成纯文字列表 */
  async renderHelp (e, sections, keyword = '') {
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

/**
 * 摘掉「只有主人私聊才该看到」的内容。
 *
 * 两类：
 *   · 整组标了 `ownerOnly`（主人指令 / 系统指令）—— 普通用户根本不需要，
 *     非主人拿这些词去搜也只会得到「没找到」（不暴露它们存在）
 *   · 单条标了 `ownerOnly`（观战 / 营地消息的运维指令）—— 组照常留着，
 *     只把那几条主人专属的摘掉
 *
 * ⚠️ 这个函数的结果就是**最终**要渲染的 sections。任何在渲染前再往 sections 里
 *    塞东西的地方（如主人本地的 `local/helpExtra.js`）都必须自己再判一次主人私聊，
 *    否则会绕过这里的过滤 —— 见那个文件顶部的说明。
 */
function stripOwnerOnly (sections, e) {
  if (e.isMaster && !e.isGroup) return sections
  return sections
    .filter(section => !section.ownerOnly)
    .map(section => ({ ...section, list: section.list.filter(item => !item.ownerOnly) }))
    .filter(section => section.list.length)
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
