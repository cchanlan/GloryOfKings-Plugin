import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { renderMasterPanel } from '../utils/masterPanel.js'

export class Help extends plugin {
  constructor() {
    super({
      name: '显示王者插件帮助信息',
      dsc: '显示帮助信息',
      event: 'message',
      priority: 1,
      rule: [
        {
          reg: /^#?王者(荣耀|农药)?(插件|plugin)?(帮助|help)$/i,
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
    const inventoryImage = await puppeteer.screenshot('help', {
      tplFile: 'plugins/GloryOfKings-Plugin/resources/html/help.html',
      generatedAt: new Date().toLocaleString()
    })

    await e.reply(inventoryImage)
  }

  async showMasterPanel(e) {
    await renderMasterPanel(e)
  }
}
