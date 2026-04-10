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
            if (!heroFightingCapacity.length) {
                await e.reply('暂未查询到该英雄的战力数据')
                return
            }

            const statValues = heroFightingCapacity.map(item => ({
                guobiao: Number(item.guobiao || 0),
                provincePower: Number(item.provincePower || 0),
                cityPower: Number(item.cityPower || 0),
                areaPower: Number(item.areaPower || 0)
            }))

            const minStats = {
                guobiao: Math.min(...statValues.map(item => item.guobiao)),
                provincePower: Math.min(...statValues.map(item => item.provincePower)),
                cityPower: Math.min(...statValues.map(item => item.cityPower)),
                areaPower: Math.min(...statValues.map(item => item.areaPower))
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
