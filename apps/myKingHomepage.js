import puppeteer from '../../../lib/puppeteer/puppeteer.js';
import YAML from 'yaml';
import ApiService from '../utils/api.js';
import path from 'path';
import fs from 'fs';

export class MyKingHomepage extends plugin {
    constructor() {
        super({
            name: 'myKingHomepage',
            dsc: '王者主页',
            event: 'message',
            priority: 1,
            rule: [
                { reg: /^#王者主页/, fnc: 'myKingHomepage' }
            ]
        })
    }

    async myKingHomepage(e) {
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

        const response = await ApiService.post('/userprofile/profile', {
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

        const { profile, roleCard } = response.data;

        const data = {
            tplFile: 'plugins/GloryOfKings-Plugin/resources/html/MyKingHomepage.html',
            IP: profile.ipProperty,
            roleIcon: roleCard.roleBigIcon,
            roleName: roleCard.roleName,
            gameLevel: roleCard.level,
            gameOnline: roleCard.gameOnline,
            roleJobName: `${roleCard.roleJobName} ${roleCard.rankingStar}星`,
            areaName: roleCard.areaName,
            roleText: roleCard.serverName,
            flagImg: roleCard.flagImg,
            roleJobIcon: roleCard.roleJobIcon,
            content_1: roleCard.fightPowerItem.value1,
            content_2: roleCard.mvpNumItem.value1,
            content_3: roleCard.totalBattleCountItem.value1,
            content_4: `${roleCard.heroNumItem.value1}/${roleCard.heroNumItem.value2}`,
            content_5: roleCard.winRateItem.value1,
            content_6: `${roleCard.skinNumItem.value1}/${roleCard.skinNumItem.value2}`
        }

        const inventoryImage = await puppeteer.screenshot('myKingHomepage', data)

        await e.reply(inventoryImage)
    }
}
