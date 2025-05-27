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
        }
      ],
      getConfigData () {
        return {
          config: Config.getDefOrConfig('config')
        }
      },
      setConfigData (data, { Result }) {
        let config = Config.getCfg()

        for (const key in data) {
          let split = key.split('.')
          let currentConfig = config

          for (let i = 0; i < split.length - 1; i++) {
            if (currentConfig[split[i]] === undefined) {
              currentConfig[split[i]] = {}
            }
            currentConfig = currentConfig[split[i]]
          }

          let lastKey = split[split.length - 1]
          if (!lodash.isEqual(currentConfig[lastKey], data[key])) {
            Config.modify(split[0], lastKey, data[key])
          }
        }
        return Result.ok({}, '𝑪𝒊𝒂𝒍𝒍𝒐～(∠・ω< )⌒★')
      }

    }
  }
}
