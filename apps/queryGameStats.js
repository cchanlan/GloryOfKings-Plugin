import fs from 'fs';
import path from 'path';
import puppeteer from '../../../lib/puppeteer/puppeteer.js';
import YAML from 'yaml';
import ApiService from '../utils/api.js';

export class QueryGameStats extends plugin {
    constructor() {
        super({
            name: 'queryGameStats',
            dsc: '查询战绩',
            event: 'message',
            priority: 1,
            rule: [
                { reg: /^#查询战绩(\d+)?/, fnc: 'queryGameStats' }
            ]
        })
    }

    async queryGameStats(e) {
        const { user_id } = e;
        const loginFilePath = path.join('data', 'WzryData', 'ScanCodeLoginData', `${user_id}.json`);
        const userFilePath = path.join('data', 'WzryData', 'UserData.yaml');

        if (!fs.existsSync(loginFilePath)) {
            await e.reply('未找到登录信息，请先扫码登录。');
            return;
        }

        const userData = JSON.parse(fs.readFileSync(loginFilePath, 'utf8'));
        const { ssoOpenId, ssoToken } = userData;

        if (!fs.existsSync(userFilePath)) {
            await e.reply('未找到用户数据文件，请先绑定营地ID。');
            return;
        }

        const allUserData = YAML.parse(fs.readFileSync(userFilePath, 'utf8'));
        const ID = allUserData[user_id];

        if (!ID) {
            await e.reply('未找到角色ID，绑定营地ID后重试。');
            return;
        }

        const response = await ApiService.post('/game/morebattlelist', {
            lastTime: 0,
            recommendPrivacy: 0,
            apiVersion: 5,
            friendUserId: ID,
            option: 0
        }, {
            ssoappid: 'campPc',
            ssobusinessid: 'pc',
            ssoopenid: ssoOpenId,
            ssotoken: ssoToken
        });

        if (response.returnCode === -30003) {
            e.reply('登陆状态失效，请重新扫码登录');
            return;
        }

        await e.reply(`共查询到${response.data.list.length}条游戏记录`);

        const data = response.data.list.map(item => ({
            gameTpye: this.getGameType(item.gametype),
            gameTime: item.gametime,
            gameDuration: `${Math.floor(item.usedTime / 60)}分${item.usedTime % 60}秒`,
            killCnt: item.killcnt,
            deadCnt: item.deadcnt,
            assistCnt: item.assistcnt,
            gameResult: this.getGameResult(item.gameresult),
            heroIcon: item.heroIcon,
            desc: item.desc,
            tags: this.getTags(item),
            gradeGame: item.gradeGame
        }));

        const inventoryImage = await puppeteer.screenshot('QueryGameStats', {
            tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameStats.html',
            data,
            roleJobName: response.data.list[0].roleJobName,
            winningStreak: this.calculateWinningStreak(data.map(item => item.gameResult))
        });

        await e.reply(inventoryImage);
    }

    getGameType(type) {
        switch (type) {
            case 6: return '1V1';
            case 4: return '排位赛';
            case 5: return '王者峡谷';
            case 9: return '火焰山大战';
            case 20: return '10V10排位赛';
            default: return `未知: ${type}`;
        }
    }

    getGameResult(result) {
        return result === 1 ? '胜利' : result === 2 ? '失败' : result;
    }

    getTags(item) {
        const tags = [];
        const descTags = ['实力局', '翻盘局', '暴走局', '尽力局'];
        const evaluateTags = {
            'https://camp.qq.com/battle/common/evaluateV3/gold_warrior.png': '金牌战士',
            'https://camp.qq.com/battle/common/evaluateV3/gold_mage.png': '金牌法师',
            'https://camp.qq.com/battle/common/evaluateV3/gold_support.png': '金牌辅助',
            'https://camp.qq.com/battle/common/evaluateV3/silver_warrior.png': '银牌战士',
            'https://camp.qq.com/battle/common/evaluateV3/silver_mage.png': '银牌法师',
            'https://camp.qq.com/battle/common/evaluateV3/silver_support.png': '银牌辅助'
        };
        const mvpTags = ['https://camp.qq.com/battle/common/mvpV3/svp.png', 'https://camp.qq.com/battle/common/mvpV3/mvp.png'];

        if (descTags.includes(item.desc)) tags.push(item.desc);
        if (evaluateTags[item.evaluateUrlV2]) tags.push(evaluateTags[item.evaluateUrlV2]);
        if (mvpTags.includes(item.mvpUrlV2)) tags.push('MVP');

        return tags;
    }

    calculateWinningStreak(results) {
        let maxStreak = 0;
        let currentStreak = 0;

        for (let result of results) {
            if (result === 'win') {
                currentStreak++;
                if (currentStreak > maxStreak) {
                    maxStreak = currentStreak;
                }
            } else {
                currentStreak = 0;
            }
        }

        return maxStreak;
    }
}