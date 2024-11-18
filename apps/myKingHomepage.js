import puppeteer from '../../../lib/puppeteer/puppeteer.js';
import ApiService from '../utils/api.js';
import path from 'path';
import fs from 'fs';
import { readJsonFile, getFilePath } from '../utils/fileUtils.js';
import { readYamlFile } from '../utils/yamlUtils.js';

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
        const userFilePath = path.join('data', 'WzryData', 'UserData.yaml');

        const allUserData = readYamlFile(userFilePath);
        const ID = allUserData[user_id];

        if (!ID) {
            await e.reply('未找到角色ID，扫码登录绑定或手动绑定\r发送【王者帮助】查看');
            return;
        }

        const { OpenID, Token } = await ApiService.getPublicTokenAndOpenID();

        const response = await this.fetchUserProfile(ID, OpenID, Token, user_id);

        if (response === -1) {
            return e.reply('公共Token&OpenID失效. \r且未找到您的登录信息，请先扫码登录。\r发送【#营地扫码】');
        }
        if (response === -2) {
            return e.reply('您的登录信息已过期，请重新扫码登录。');
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
        };

        const inventoryImage = await puppeteer.screenshot('myKingHomepage', data);

        await e.reply(inventoryImage);
    }

    async fetchUserProfile(ID, OpenID, Token, user_id) {
        try {
            let response = await ApiService.post('/userprofile/profile', {
                lastTime: 0,
                recommendPrivacy: 0,
                apiVersion: 5,
                friendUserId: ID,
                option: 0
            }, {
                ssoopenid: OpenID,
                ssotoken: Token
            });

            if (response.returnCode === -30003) {
                const loginFilePath = getFilePath(user_id);
                if (!fs.existsSync(loginFilePath)) {
                    return -1;
                }

                const userData = readJsonFile(loginFilePath);
                const { ssoOpenId, ssoToken } = userData;
                response = await ApiService.post('/userprofile/profile', {
                    lastTime: 0,
                    recommendPrivacy: 0,
                    apiVersion: 5,
                    friendUserId: ID,
                    option: 0
                }, {
                    ssoopenid: ssoOpenId,
                    ssotoken: ssoToken
                });

                if (response.returnCode === -30003) {
                    return -2;
                }
            }

            return response;
        } catch (error) {
            console.error('Error fetching user profile:', error);
            return null;
        }
    }
}
