import fetch from 'node-fetch';
import api from '../utils/api.js'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'

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
            await e.reply('请输入要查询的英雄名称')
            return
        }

        let heroList;
        try {
            heroList = await api.getHeroList();
        } catch (error) {
            await e.reply('获取英雄列表失败，请稍后再试。');
            return;
        }

        const hero = heroList.find(h => h.cname === heroName);
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
                const response = await fetch(url);

                if (!response.ok) break;

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

        const templateParams = {
            heroName: hero.cname,
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

        await e.reply(img);
    }
}