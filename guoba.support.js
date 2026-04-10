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
          label: '上下线提醒',
          bottomHelpMessage: '是否开启王者上下线提醒,总开关',
          component: 'Switch'
        },
        {
          field: 'config.onlineReminderCron',
          label: '上下线提醒',
          bottomHelpMessage: '王者上下线提醒的cron表达式',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '请输入Cron表达式'
          }
        },
        {
          field: 'config.battleResultCron',
          label: '战绩推送',
          bottomHelpMessage: '王者战绩推送的cron表达式',
          helpMessage: '修改后重启生效',
          component: 'EasyCron',
          componentProps: {
            placeholder: '请输入Cron表达式'
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
          label: '命令入口：#营地wx登录 / #王者帮助 / #王者设置 / #营地wx全局登录 / #王者用户统计 / #王者设置共享账号候选启用|关闭 / #王者设置个人登录态兜底启用|关闭 / #共享营地账号 / #清理失效营地账号'
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
