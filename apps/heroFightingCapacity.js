import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import api from '../utils/api.js'

export class HeroFightingCapacity extends plugin {
    constructor() {
        super({
            name: '查询王者英雄战力',
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
        const heroName = e.msg.replace(/#|查战力|\s+|\n+/g, '').trim()
        if (!heroName) {
            await e.reply('请输入要查询的英雄名称')
            return
        }

        try {
            const heroFightingCapacity = await api.getHeroFightingCapacity(heroName)

            const minStats = {
                guobiao: Math.min(...heroFightingCapacity.map(item => parseInt(item.guobiao))),
                provincePower: Math.min(...heroFightingCapacity.map(item => parseInt(item.provincePower))),
                cityPower: Math.min(...heroFightingCapacity.map(item => parseInt(item.cityPower))),
                areaPower: Math.min(...heroFightingCapacity.map(item => parseInt(item.areaPower)))
            }

            const img = await puppeteer.screenshot('HeroFightingCapacit', {
                tplFile: 'plugins/GloryOfKings-Plugin/resources/html/HeroFightingCapacit.html',
                photo: heroFightingCapacity[0].photo,
                name: heroFightingCapacity[0].name,
                alias: heroFightingCapacity[0].alias,
                data: heroFightingCapacity,
                minStats: minStats
            })

            await e.reply(img)
        } catch (err) {
            logger.error(`[查战力] 查询失败: ${err}`)
            await e.reply(`查询失败!`)
        }
    }
}
