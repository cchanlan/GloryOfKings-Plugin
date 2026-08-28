import lodash from 'lodash'
import { Config, PluginPath, PluginName } from '#components'
import authStore from './utils/authStore.js'

function getAuthPoolSnapshot () {
  const accounts = authStore.getGuobaAccounts().map(account => ({
    ...account,
    statusText: account.authInvalid
      ? `失效${account.lastAuthErrorMessage ? ` | ${account.lastAuthErrorMessage}` : ''}`
      : '正常'
  }))
  const invalidCount = accounts.filter(account => account.authInvalid).length
  const usableCount = accounts.length - invalidCount
  const options = accounts.map(account => ({
    label: `${account.userId}${account.nickname ? ` (${account.nickname})` : ''} [${account.authInvalid ? '失效' : '正常'}${account.isGlobalDefault ? '/全局' : (account.shared ? '/共享' : '/私有')}]`,
    value: account.userId
  }))

  return {
    accounts,
    invalidCount,
    usableCount,
    options
  }
}

export function supportGuoba () {
  const {
    accounts: authPoolAccounts,
    invalidCount,
    usableCount,
    options: authPoolOptions
  } = getAuthPoolSnapshot()

  return {
    pluginInfo: {
      name: '王者插件',
      title: '王者插件',
      author: '@Tloml-Starry',
      authorLink: 'https://gitee.com/Tloml-Starry',
      link: 'https://gitee.com/Tloml-Starry/GloryOfKings-Plugin',
      isV3: true,
      isV2: false,
      description: '提供王者荣耀相关功能',
      iconPath: `${PluginPath}/resources/th.png`
    },
    configInfo: {
      schemas: [
        {
          component: 'Divider',
          label: '插件设置'
        },
        {
          field: 'config.onlineReminder',
          label: '推送总开关',
          bottomHelpMessage: '战绩推送 / 开局提醒 / 上下线提醒的总开关。打开后用户还需各自在群里发送 #开启战绩推送 或 #开启上下线提醒 订阅，只有订阅过的人会被轮询。打完一局推送的是和 #查询战绩N 同一张全场详情图。三条播报（打完 / 开局 / 上下线）都不 @ 本人，玩家名写在文案里，群里照样认得出是谁。',
          component: 'Switch'
        },
        {
          field: 'config.quoteReply',
          label: '引用触发消息',
          bottomHelpMessage: '默认开启。开启时回复会引用触发指令那条消息；关闭后直接发送，不带引用。',
          component: 'Switch'
        },
        {
          field: 'config.battleResultCron',
          label: '推送检查间隔',
          bottomHelpMessage: '战绩推送、开局提醒、上下线提醒共用这一个轮询，这里定的是「最快多久看一次」。每个订阅串行拉接口（间隔 800 毫秒）；真打完一局时会再拉一次详情并渲染图（约 1.3 秒）。玩家离线时实际间隔会按下面的退避倍数自动拉长，不会一直按这个频率打接口。设太短仍会触发营地频控 -30107，不建议低于 2 分钟。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '请输入Cron表达式'
          }
        },
        {
          field: 'config.idleBackoffMax',
          label: '离线退避倍数',
          bottomHelpMessage: '玩家离线时把检查间隔拉长到几倍上面的轮询间隔。离线的号既不会开局也不会出新战绩，照高频查纯属白耗配额、更容易撞上 -30107。默认 5，即 2 分钟的间隔在离线满 3 小时后退到 10 分钟一次（不活跃 1 小时内 2 倍、1~3 小时 3 倍）。代价是上线播报最坏晚这么久，期间「上线又下线」的短会话可能整段漏掉。填 1 = 关闭自适应，恒定按上面的间隔轮询。',
          component: 'InputNumber',
          componentProps: {
            placeholder: '默认 5'
          }
        },
        {
          field: 'config.dailyReportCron',
          label: '战绩日报推送时间',
          bottomHelpMessage: '每天到点给订阅者发一张当日战绩总结图（#开启日报推送 订阅）。数据读的是本地归档，正常不额外请求营地接口。当天没有对局就不推送。留空 = 关掉自动推送，只保留 #王者日报 指令。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每晚 23:47'
          }
        },
        {
          field: 'config.weeklyReportCron',
          label: '战绩周报推送时间',
          bottomHelpMessage: '同上，按「本周（周一 00:00 起）」汇总，默认周日晚推送。首次推送时本地归档可能还不全，图上会标明数据覆盖到哪天。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认周日 22:07'
          }
        },
        {
          field: 'config.monthlyReportCron',
          label: '战绩月报推送时间',
          bottomHelpMessage: '同上，按「本月（1 号 00:00 起）」汇总。cron 没法表达「每月最后一天」（各月天数不同），所以默认写成 28-31 号每晚触发，插件只在真正的月末那天推，不会连推四天。本地归档保留 35 天，刚好够一个月。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每月最后一晚 23:41'
          }
        },
        {
          field: 'config.groupDailyReportCron',
          label: '群日报推送时间',
          bottomHelpMessage: '给开过 #开启群日报推送 的群发一张全群战绩排行榜。和个人日报不同，群报要逐个扫本群绑定营地ID的成员，每人至少一次营地请求（最多 25 个活跃账号，约 30 秒），所以默认时间和个人日报错开。全群当天没人打就不推送。留空 = 关掉自动推送，只保留 #群日报 指令。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每晚 23:22'
          }
        },
        {
          field: 'config.groupWeeklyReportCron',
          label: '群周报推送时间',
          bottomHelpMessage: '同上，按「本周（周一 00:00 起）」汇总全群。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认周日 21:34'
          }
        },
        {
          field: 'config.groupMonthlyReportCron',
          label: '群月报推送时间',
          bottomHelpMessage: '同上，按「本月（1 号 00:00 起）」汇总全群。和个人月报一样是 28-31 号触发、只在真正的月末那天推。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每月最后一晚 23:18'
          }
        },
        {
          component: 'Divider',
          label: '图片缓存'
        },
        {
          field: 'config.imgCacheMaxMB',
          label: '图片缓存上限',
          bottomHelpMessage: '插件下载的远程图片（英雄头像、皮肤图）缓存在 data/imgCache，单张平均 490KB。#皮肤墙 / #全部皮肤 一次会拉几百张，几个人轮着查就能堆到几百 MB —— 7 天过期只管时间管不住量，所以这里再加一道按体积削的兜底：超出上限时按下载时间从旧到新删。填 0 = 不限量。用 #王者缓存状态 看当前占用。',
          component: 'InputNumber',
          componentProps: {
            min: 0,
            max: 10240,
            placeholder: '默认 200（MB）'
          }
        },
        {
          field: 'config.imgCacheCleanCron',
          label: '缓存清理时间',
          bottomHelpMessage: '每天按上面的上限清一次图片缓存。默认凌晨 4 点，避开白天出图高峰。插件启动 30 秒后也会清一次（pm2 下 Yunzai 可以连着跑几个月不重启，只靠启动清理等于永不清理）。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每天 04:12'
          }
        },
        {
          component: 'Divider',
          label: '皮肤上新'
        },
        {
          field: 'config.skinNewsCron',
          label: '皮肤上新检查时间',
          bottomHelpMessage: '每天按这个时间查一次官网资料库，把「今天上线」和「新进清单（还没上线）」的皮肤推给已 #开启皮肤上新推送 的群。数据是官网公开 JSON，不占营地请求配额。留空 = 不自动推送，只保留 #皮肤上新 指令。',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '默认每天 12:26'
          }
        },
        {
          component: 'SOFT_GROUP_BEGIN',
          label: '账号鉴权管理'
        },
        {
          component: 'Divider',
          label: '使用策略'
        },
        {
          field: 'auth.enableAccountPool',
          label: '启用共享账号候选',
          helpMessage: '命令：#王者设置共享账号候选启用 / #王者设置共享账号候选关闭',
          bottomHelpMessage: '默认关闭。关闭时只使用账号列表中的默认全局账号；开启后才会在默认全局账号之后继续尝试共享账号。个人登录态不会默认参与，只有同时开启“个人登录态兜底”时才会作为最后候选。',
          component: 'Switch'
        },
        {
          field: 'auth.allowPersonalAuthFallback',
          label: '允许个人登录态兜底',
          helpMessage: '命令：#王者设置个人登录态兜底启用 / #王者设置个人登录态兜底关闭',
          bottomHelpMessage: '默认关闭。开启后会在默认全局账号和共享账号都不可用时，最后再尝试当前 QQ 自己保存的登录态。若“共享账号候选”为关闭状态，则该兜底链路不会实际参与请求。',
          component: 'Switch'
        },
        {
          component: 'Divider',
          label: '请求默认值'
        },
        {
          field: 'auth.gameAreaId',
          label: '游戏 AreaId',
          bottomHelpMessage: '请求默认值。账号本身未携带该字段时，默认使用这里的值，通常保持 1。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 1'
          }
        },
        {
          field: 'auth.gameUserSex',
          label: '游戏性别',
          bottomHelpMessage: '请求默认值。账号本身未携带该字段时，默认使用这里的值，通常保持 1。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 1'
          }
        },
        {
          field: 'auth.kohDimGender',
          label: '营地性别',
          bottomHelpMessage: '请求默认值。账号本身未携带该字段时，默认使用这里的值，通常保持 2。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 2'
          }
        },
        {
          field: 'auth.serverTimeOffsetMs',
          label: '时间偏移毫秒',
          bottomHelpMessage: '请求默认值。只有本机时间和服务端时间存在明显偏差时才需要填写，通常保持 0。',
          component: 'InputNumber',
          componentProps: {
            placeholder: '默认 0'
          }
        },
        {
          component: 'Divider',
          label: '账号列表'
        },
        {
          component: 'Divider',
          label: '命令入口：#营地wx登录 / #王者帮助 / #王者设置 / #营地wx全局登录 / #王者用户统计 / #王者设置共享账号候选启用|关闭 / #王者设置个人登录态兜底启用|关闭 / #共享营地账号 / #清理失效营地账号 / #开启战绩推送 / #关闭战绩推送 / #开启上下线提醒 / #关闭上下线提醒 / #战绩推送状态 / #清空王者战绩推送'
        },
        {
          field: 'authPool.sharedIds',
          label: '共享账号批量管理',
          helpMessage: `批量选择哪些账号加入共享账号池。当前共 ${authPoolAccounts.length} 个账号，可用 ${usableCount} 个，失效 ${invalidCount} 个。`,
          bottomHelpMessage: '下拉选项会直接显示正常/失效状态。选中的账号会被标记为共享，未选中的账号仍保留在账号池中，但只允许 ownerBotUserId 对应的 QQ 用户优先使用。',
          component: 'Select',
          componentProps: {
            mode: 'multiple',
            options: authPoolOptions,
            allowAdd: false,
            allowDel: true
          }
        },
        {
          field: 'authPool.accounts',
          label: `营地账号列表（共 ${authPoolAccounts.length} 个，可用 ${usableCount} 个，失效 ${invalidCount} 个）`,
          helpMessage: '管理 AuthPool.json 中的完整账号信息。字段名已尽量按实际代码名标注；手动录入时，至少需要 userId、token、userKey 这三个核心字段。',
          bottomHelpMessage: '删除条目会从账号池移除该账号；敏感字段支持直接编辑；默认全局账号、共享账号和优先级都直接在这里维护。未开启“共享账号候选”时，请求只使用默认全局账号；私人账号仅允许 ownerBotUserId 对应的 QQ 用户在开启个人兜底时使用。',
          component: 'GSubForm',
          componentProps: {
            multiple: true,
            schemas: [
              {
                field: 'userId',
                label: '营地用户ID',
                component: 'Input',
                required: true,
                helpMessage: '核心字段；请求时会映射到 userid。',
                componentProps: {
                  placeholder: 'userId，例如 2119017299'
                }
              },
              {
                field: 'statusText',
                label: '当前状态',
                component: 'Input',
                componentProps: {
                  readonly: true,
                  placeholder: 'statusText'
                }
              },
              {
                field: 'ownerBotUserId',
                label: '归属 QQ',
                component: 'Input',
                componentProps: {
                  placeholder: 'ownerBotUserId，留空表示仅共享'
                }
              },
              {
                field: 'shared',
                label: '共享账号',
                component: 'Switch'
              },
              {
                field: 'isGlobalDefault',
                label: '全局账号',
                component: 'Switch'
              },
              {
                field: 'priority',
                label: '优先级',
                component: 'InputNumber',
                componentProps: {
                  placeholder: '数值越小越优先，默认 100'
                }
              },
              {
                field: 'authInvalid',
                label: '标记失效',
                component: 'Switch'
              },
              {
                field: 'nickname',
                label: '昵称',
                component: 'Input',
                componentProps: {
                  placeholder: 'nickname'
                }
              },
              {
                field: 'userName',
                label: '用户名称',
                component: 'Input',
                componentProps: {
                  placeholder: 'userName'
                }
              },
              {
                field: 'snsnickname',
                label: '社交昵称',
                component: 'Input',
                componentProps: {
                  placeholder: 'snsnickname'
                }
              },
              {
                field: 'remark',
                label: '备注',
                component: 'Input',
                componentProps: {
                  placeholder: 'remark'
                }
              },
              {
                field: 'token',
                label: 'Token',
                component: 'InputPassword',
                required: true,
                helpMessage: '核心字段；请求头 token。',
                componentProps: {
                  placeholder: 'token'
                }
              },
              {
                field: 'userKey',
                label: 'UserKey',
                component: 'InputPassword',
                required: true,
                helpMessage: '核心字段；用于生成 encodeParam。',
                componentProps: {
                  placeholder: 'userKey'
                }
              },
              {
                field: 'encodeRes',
                label: 'EncodeRes',
                component: 'InputPassword',
                helpMessage: '可选补充；若存在可用于解出 userKey。',
                componentProps: {
                  placeholder: 'encodeRes'
                }
              },
              {
                field: 'accessToken',
                label: 'AccessToken',
                component: 'InputPassword',
                componentProps: {
                  placeholder: 'accessToken'
                }
              },
              {
                field: 'refreshToken',
                label: 'RefreshToken',
                component: 'InputPassword',
                componentProps: {
                  placeholder: 'refreshToken'
                }
              },
              {
                field: 'appOpenid',
                label: 'App OpenId',
                component: 'Input',
                componentProps: {
                  placeholder: 'appOpenid'
                }
              },
              {
                field: 'openId',
                label: '营地 OpenId',
                component: 'Input',
                componentProps: {
                  placeholder: 'openId'
                }
              },
              {
                field: 'gameOpenId',
                label: '游戏 OpenId',
                component: 'Input',
                componentProps: {
                  placeholder: 'gameOpenId'
                }
              },
              {
                field: 'gameRoleId',
                label: '游戏 RoleId',
                component: 'Input',
                componentProps: {
                  placeholder: 'gameRoleId'
                }
              },
              {
                field: 'gameServerId',
                label: '游戏 ServerId',
                component: 'Input',
                componentProps: {
                  placeholder: 'gameServerId'
                }
              },
              {
                field: 'gameAreaId',
                label: '游戏 AreaId',
                component: 'Input',
                componentProps: {
                  placeholder: 'gameAreaId，默认 1'
                }
              },
              {
                field: 'gameUserSex',
                label: '游戏性别',
                component: 'Input',
                componentProps: {
                  placeholder: 'gameUserSex，默认 1'
                }
              },
              {
                field: 'kohDimGender',
                label: '营地性别',
                component: 'Input',
                componentProps: {
                  placeholder: 'kohDimGender，默认 2'
                }
              },
              {
                field: 'avatar',
                label: '头像',
                component: 'Input',
                componentProps: {
                  placeholder: 'avatar'
                }
              },
              {
                field: 'bigAvatar',
                label: '大头像',
                component: 'Input',
                componentProps: {
                  placeholder: 'bigAvatar'
                }
              },
              {
                field: 'icon',
                label: '图标',
                component: 'Input',
                componentProps: {
                  placeholder: 'icon'
                }
              },
              {
                field: 'sex',
                label: '账号性别',
                component: 'Input',
                componentProps: {
                  placeholder: 'sex'
                }
              },
              {
                field: 'expires',
                label: 'Expires',
                component: 'Input',
                componentProps: {
                  placeholder: 'expires'
                }
              },
              {
                field: 'uin',
                label: 'Uin',
                component: 'Input',
                componentProps: {
                  placeholder: 'uin'
                }
              },
              {
                field: 'userSig',
                label: 'UserSig',
                component: 'InputPassword',
                componentProps: {
                  placeholder: 'userSig'
                }
              },
              {
                field: 'realRegisterTime',
                label: '注册时间',
                component: 'Input',
                componentProps: {
                  placeholder: 'realRegisterTime'
                }
              },
              {
                field: 'loginPlatform',
                label: '登录来源',
                component: 'Input',
                componentProps: {
                  placeholder: 'loginPlatform，例如 wechat'
                }
              },
              {
                field: 'authErrorCount',
                label: '失败次数',
                component: 'InputNumber',
                componentProps: {
                  placeholder: '默认 0'
                }
              },
              {
                field: 'updatedAt',
                label: '更新时间',
                component: 'Input',
                componentProps: {
                  placeholder: 'updatedAt'
                }
              },
              {
                field: 'lastLoginAt',
                label: '最近登录',
                component: 'Input',
                componentProps: {
                  placeholder: 'lastLoginAt'
                }
              },
              {
                field: 'lastSuccessAt',
                label: '最近成功',
                component: 'Input',
                componentProps: {
                  placeholder: 'lastSuccessAt'
                }
              },
              {
                field: 'lastAuthErrorAt',
                label: '最近失败',
                component: 'Input',
                componentProps: {
                  placeholder: 'lastAuthErrorAt'
                }
              },
              {
                field: 'lastAuthErrorMessage',
                label: '失败原因',
                component: 'Input',
                componentProps: {
                  placeholder: 'lastAuthErrorMessage'
                }
              }
            ]
          }
        }
      ],
      getConfigData () {
        const { accounts } = getAuthPoolSnapshot()

        return {
          config: Config.getDefOrConfig('config'),
          auth: Config.getDefOrConfig('auth'),
          authPool: {
            sharedIds: accounts.filter(account => account.shared).map(account => account.userId),
            accounts
          }
        }
      },
      setConfigData (data, { Result }) {
        const configMap = {
          config: Config.getDefOrConfig('config'),
          auth: Config.getDefOrConfig('auth')
        }

        if (Object.prototype.hasOwnProperty.call(data, 'authPool.accounts') || Object.prototype.hasOwnProperty.call(data, 'authPool.sharedIds')) {
          const { accounts: currentAccounts } = getAuthPoolSnapshot()
          authStore.replaceAccountsFromGuoba(
            data['authPool.accounts'] || currentAccounts,
            data['authPool.sharedIds'] || []
          )
        }

        for (const key in data) {
          if (key.startsWith('authPool.')) {
            continue
          }

          const split = key.split('.')
          const configName = split.shift()
          const configPath = split.join('.')

          if (!configName || !configPath || !configMap[configName]) {
            continue
          }

          const currentValue = lodash.get(configMap[configName], configPath)
          if (!lodash.isEqual(currentValue, data[key])) {
            Config.modify(configName, configPath, data[key])
          }
        }

        return Result.ok({}, '𝑪𝒊𝒂𝒍𝒍𝒐～(∠・ω< )⌒★')
      }

    }
  }
}
