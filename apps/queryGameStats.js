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

        let data = []
        for (const item of response.data.list) {
            let type = item.gametype
            if (type === 6) type = '1V1'
            else if (type === 4) type = '排位赛'
            else if (type === 5) type = '王者峡谷'
            else if (type === 9) type = '火焰山大战'
            else if (type === 20) type = '10V10排位赛'
            else type = '未知'
            data.push({
                gameTpye: type,
                gameTime: item.gametime,
                gameDuration: Math.floor(item.usedTime / 60) + '分' + item.usedTime % 60 + '秒',
                killCnt: item.killcnt,
                deadCnt: item.deadcnt,
                assistCnt: item.assistcnt,
                gameResult: item.gameresult === 1 ? '胜利' : item.gameresult === 2 ? '失败' : item.gameresult,
                heroIcon: item.heroIcon,
                desc: item.desc
            })
        }

        const inventoryImage = await puppeteer.screenshot('QueryGameStats', {
            tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameStats.html',
            data
        })

        await e.reply(inventoryImage)
    }
}