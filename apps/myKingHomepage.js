import puppeteer from '../../../lib/puppeteer/puppeteer.js';
import YAML from 'yaml';
import ApiService from '../utils/api.js';

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

        const response = await ApiService.post('/game/profile/index', {
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

        const { roleList, head } = response.data;

        const firstRole = roleList[0];

        const mods_1 = head.mods[0]
        const mods_2 = head.mods[2]
        const mods_3 = head.mods[3]
        const mods_4 = head.mods[4]
        const mods_5 = head.mods[5]
        const mods_6 = head.mods[6]
        const mods_7 = head.mods[7]

        const data = {
            tplFile: 'plugins/GloryOfKings-Plugin/resources/html/MyKingHomepage.html',
            roleIcon: firstRole.roleIcon,
            roleName: firstRole.roleName,
            gameLevel: firstRole.gameLevel,
            gameOnline: firstRole.gameOnline,
            roleJobName: firstRole.roleJobName,
            areaName: firstRole.areaName,
            roleText: firstRole.roleText,
            icon_: JSON.parse(mods_1.param1).starImg,
            icon: mods_1.icon,
            content_1: mods_2.content,
            content_2: mods_3.content,
            content_3: mods_4.content,
            content_4: mods_5.content,
            content_5: mods_6.content,
            content_6: mods_7.content
        }

        const inventoryImage = await puppeteer.screenshot('myKingHomepage', data)

        await e.reply(inventoryImage)
    }
}
