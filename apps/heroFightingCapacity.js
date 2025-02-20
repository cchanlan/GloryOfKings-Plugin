import plugin from '../../lib/plugins/plugin.js'
import puppeteer from '../../lib/puppeteer/puppeteer.js'
import api from '../utils/api.js'

export class HeroFightingCapacity extends plugin {
    constructor() {
        super({
            name: '查战力',
            dsc: '查询英雄战力',
            event: 'message',
            priority: 5000,
            rule: [
                {
                    reg: /^#查战力.*/,
                    fnc: 'checkHeroFightingCapacity'
                }
            ]
        })
    }

    async checkHeroFightingCapacity(e) {
        const heroName = e.msg.replace(/#|查战力/g, '').trim()
        if (!heroName) {
            await e.reply('请输入要查询的英雄名称')
            return
        }

        try {
            const { aqq, awx, iqq, iwx } = await api.getHeroFightingCapacity(heroName)

            logger.mark(JSON.stringify({ aqq, awx, iqq, iwx }, null, 4))

            /*             const img = await puppeteer.screenshot('HeroFightingCapacit', {
                            tplFile: 'plugins/GloryOfKings-Plugin/resources/html/HeroFightingCapacit.html',
                        })
            
                        await e.reply(img) */
        } catch (err) {
            logger.error(`[查战力] 查询失败: ${err}`)
            await e.reply(`查询失败: ${err.message}`)
        }
    }
}
