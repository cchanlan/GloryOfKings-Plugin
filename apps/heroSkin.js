import api from '../utils/api.js'
import { getLocalImage, Button } from '#utils'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'

// 元流之子的 5 个分身统一用缩写：元法/元射/元辅/元坦/元刺
const YUAN_ABBR = { 法: '法师', 射: '射手', 辅: '辅助', 坦: '坦克', 刺: '刺客' }

// 英雄列表里存的是半角括号全名，输入侧把缩写展开
const expandYuan = name => {
    const abbr = name.match(/^元(.)$/)
    return abbr && YUAN_ABBR[abbr[1]] ? `元流之子(${YUAN_ABBR[abbr[1]]})` : name
}

// 展示侧反向简化：元流之子(法师) → 元法
const simplifyYuan = text => String(text ?? '').replace(/元流之子\s*[（(]\s*(.)[^）)]*[）)]/g, '元$1')

export class HeroSkin extends plugin {
    constructor() {
        super({
            name: '查询王者英雄皮肤',
            dsc: '查询英雄皮肤',
            event: 'message',
            priority: 5000,
            rule: [
                { reg: /^#查皮肤.*/, fnc: 'checkHeroSkin' }
            ]
        })
    }

    async checkHeroSkin(e) {
        const heroName = e.msg.replace(/#|查皮肤|\s+|\n+/g, '').trim()
        if (!heroName) {
            await e.reply(['请输入要查询的英雄名称', Button.hero()])
            return
        }

        let heroList;
        try {
            heroList = await api.getHeroList();
        } catch (error) {
            await e.reply('获取英雄列表失败，请稍后再试。');
            return;
        }

        const hero = heroList.find(h => h.cname === expandYuan(heroName));
        if (!hero) {
            await e.reply('未找到该英雄的皮肤信息');
            return;
        }

        const skinNames = hero.skin_name ? hero.skin_name.split('|') : [];
        const skinData = [];

        let index = 1;
        while (true) {
            try {
                const url = `https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/${hero.ename}/${hero.ename}-bigskin-${index}.jpg`;
                const localImg = await getLocalImage(url);
                // getLocalImage 失败时回退原 url（string），成功返回 Buffer
                if (typeof localImg === 'string') break;

                const skinName = skinNames[index - 1] || '';

                skinData.push({
                    url,
                    name: skinName
                });

                index++;
            } catch (err) {
                logger.error(`获取皮肤图片失败: ${err}`);
                break;
            }
        }

        if (skinData.length === 0) {
            await e.reply('未找到该英雄的皮肤信息');
            return;
        }

        const displayName = simplifyYuan(hero.cname);

        const templateParams = {
            heroName: displayName,
            skinData: skinData.map((skin, index) => ({
                name: skin.name,
                url: skin.url,
                index: index + 1
            }))
        };

        const img = await puppeteer.screenshot('HeroSkin', {
            tplFile: 'plugins/GloryOfKings-Plugin/resources/html/HeroSkin.html',
            ...templateParams
        });

        await e.reply([img, Button.hero(displayName)], true);
    }
}