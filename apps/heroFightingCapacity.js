import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import api from '../utils/api.js'
import { Button, shouldQuote } from '#utils'

// 元流之子的 5 个分身名字太长，统一用缩写：元法/元射/元辅/元坦/元刺
const YUAN_ABBR = { 法: '法师', 射: '射手', 辅: '辅助', 坦: '坦克', 刺: '刺客' }

// 战力接口只认半角括号的全名，输入侧把缩写展开
const expandYuan = name => {
    const abbr = name.match(/^元(.)$/)
    return abbr && YUAN_ABBR[abbr[1]] ? `元流之子(${YUAN_ABBR[abbr[1]]})` : name
}

// 展示侧反向简化：元流之子(法师) → 元法
const simplifyYuan = text => String(text ?? '').replace(/元流之子\s*[（(]\s*(.)[^）)]*[）)]/g, '元$1')

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
            await e.reply(['请输入要查询的英雄名称', Button.hero()])
            return
        }

        try {
            const heroFightingCapacity = await api.getHeroFightingCapacity(expandYuan(heroName))
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

            const displayName = simplifyYuan(heroFightingCapacity[0].name)

            const img = await puppeteer.screenshot('HeroFightingCapacit', {
              imgType: 'webp',
                tplFile: 'plugins/GloryOfKings-Plugin/resources/html/HeroFightingCapacit.html',
                photo: heroFightingCapacity[0].photo,
                name: displayName,
                alias: simplifyYuan(heroFightingCapacity[0].alias),
                data: heroFightingCapacity,
                minStats: minStats
            })

            await e.reply([img, Button.hero(displayName || heroName)], shouldQuote())
        } catch (err) {
            logger.error(`[查战力] 查询失败: ${err}`)
            await e.reply(`查询失败!`)
        }
    }
}
