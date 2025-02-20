import fetch from 'node-fetch';
import api from '../utils/api.js'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'

export class HeroSkin extends plugin {
    constructor() {
        super({
            name: '英雄皮肤',
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

        // 获取英雄列表
        let heroList;
        try {
            heroList = await api.getHeroList();
        } catch (error) {
            await e.reply('获取英雄列表失败，请稍后再试。');
            return;
        }

        // 查找指定英雄的ename
        const hero = heroList.find(h => h.cname === heroName);
        if (!hero) {
            await e.reply('未找到该英雄的皮肤信息');
            return;
        }

        // 在获取英雄信息后添加皮肤名称处理
        const skinNames = hero.skin_name ? hero.skin_name.split('|') : [];
        const skinData = [];

        let index = 1;
        while (true) {
            try {
                const url = `https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/${hero.ename}/${hero.ename}-bigskin-${index}.jpg`;
                const response = await fetch(url);

                if (!response.ok) break;

                // 获取皮肤名称（索引需要-1因为皮肤从1开始但数组从0开始）
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

        // 生成HTML模板参数
        const templateParams = {
            heroName: hero.cname,
            skinData: skinData.map((skin, index) => ({
                name: skin.name || '未知皮肤',
                url: skin.url,
                index: index + 1
            }))
        };

        // 使用puppeteer生成截图
        const img = await puppeteer.screenshot('HeroSkin', {
            tplFile: 'plugins/GloryOfKings-Plugin/resources/html/HeroSkin.html',
            ...templateParams
        });

        await e.reply(img);
    }
}