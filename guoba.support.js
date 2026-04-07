import lodash from 'lodash'
import { Config, PluginPath, PluginName } from '#components'

export function supportGuoba () {
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
          component: 'Divider',
          label: '营地鉴权'
        },
        {
          field: 'auth.enabled',
          label: '启用营地鉴权',
          bottomHelpMessage: '开启后使用新版营地鉴权请求主页、战绩和详情接口',
          component: 'Switch'
        },
        {
          component: 'Divider',
          label: '必填参数'
        },
        {
          field: 'auth.token',
          label: '登录态 Token',
          helpMessage: '营地 App 当前账号的 token',
          bottomHelpMessage: '必填。当前账号的营地登录态 token，失效后需要重新抓取或更新。',
          required: true,
          component: 'InputPassword',
          componentProps: {
            placeholder: '请输入最新 token'
          }
        },
        {
          field: 'auth.userId',
          label: '营地 UserId',
          bottomHelpMessage: '必填。当前账号的营地 userId，请和 token 保持同一账号。',
          required: true,
          component: 'Input',
          componentProps: {
            placeholder: '请输入 userId'
          }
        },
        {
          field: 'auth.userKey',
          label: '营地 UserKey',
          helpMessage: '用于生成 encodeParam 和解密 campencrypt 响应',
          bottomHelpMessage: '必填二选一。和 encodeRes 任选其一，优先填写 userKey；已填写 encodeRes 时这里可留空。',
          component: 'InputPassword',
          componentProps: {
            placeholder: '请输入 userKey'
          }
        },
        {
          field: 'auth.encodeRes',
          label: '登录 EncodeRes',
          helpMessage: '登录阶段返回的 encodeRes，插件可自动解出 userKey',
          bottomHelpMessage: '必填二选一。如果已经直接拿到 userKey，这里可以留空；否则可填写 encodeRes 让插件自动解出 userKey。',
          component: 'InputPassword',
          componentProps: {
            placeholder: '请输入 encodeRes'
          }
        },
        {
          component: 'Divider',
          label: '非必填参数'
        },
        {
          field: 'auth.openId',
          label: '营地 OpenId',
          bottomHelpMessage: '非必填。当前接口实测通常可留空；如果后续接口策略收紧，再补抓包值。',
          component: 'Input',
          componentProps: {
            placeholder: '请输入 openId'
          }
        },
        {
          field: 'auth.gameOpenId',
          label: '游戏 OpenId',
          bottomHelpMessage: '非必填。请求头中的 gameopenid，留空时不发送。',
          component: 'Input',
          componentProps: {
            placeholder: '请输入 gameOpenId'
          }
        },
        {
          field: 'auth.gameRoleId',
          label: '游戏 RoleId',
          bottomHelpMessage: '非必填。请求头中的 gameroleid，留空时不发送。',
          component: 'Input',
          componentProps: {
            placeholder: '请输入 gameRoleId'
          }
        },
        {
          field: 'auth.gameServerId',
          label: '游戏 ServerId',
          bottomHelpMessage: '非必填。请求头中的 gameserverid，留空时不发送。',
          component: 'Input',
          componentProps: {
            placeholder: '请输入 gameServerId'
          }
        },
        {
          field: 'auth.gameAreaId',
          label: '游戏 AreaId',
          bottomHelpMessage: '非必填。请求头中的 gameareaid，默认使用 1。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 1'
          }
        },
        {
          field: 'auth.gameUserSex',
          label: '游戏性别',
          bottomHelpMessage: '非必填。请求头中的 gameusersex，默认使用 1。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 1'
          }
        },
        {
          field: 'auth.kohDimGender',
          label: '营地性别',
          bottomHelpMessage: '非必填。请求头中的 kohdimgender，默认使用 2。',
          component: 'Input',
          componentProps: {
            placeholder: '默认 2'
          }
        },
        {
          field: 'auth.serverTimeOffsetMs',
          label: '时间偏移毫秒',
          bottomHelpMessage: '非必填。只有本机时间和服务端时间存在明显偏差时才需要填写，通常保持 0。',
          component: 'InputNumber',
          componentProps: {
            placeholder: '默认 0'
          }
        },
        {
          field: 'auth.xLogUid',
          label: 'X-Log-Uid',
          bottomHelpMessage: '非必填。留空时自动生成，只有需要精确复现某次请求时才建议填写。',
          component: 'Input',
          componentProps: {
            placeholder: '留空自动生成'
          }
        },
        {
          field: 'auth.traceparent',
          label: 'Traceparent',
          bottomHelpMessage: '非必填。留空时自动生成，通常不需要手填。',
          component: 'Input',
          componentProps: {
            placeholder: '留空自动生成'
          }
        }
      ],
      getConfigData () {
        return {
          config: Config.getDefOrConfig('config'),
          auth: Config.getDefOrConfig('auth')
        }
      },
      setConfigData (data, { Result }) {
        const configMap = {
          config: Config.getDefOrConfig('config'),
          auth: Config.getDefOrConfig('auth')
        }

        for (const key in data) {
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
