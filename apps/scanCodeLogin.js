import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import common from '../../../lib/common/common.js'
import YAML from 'yaml';

function getCommonHeaders() {
    return {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Connection': 'keep-alive',
        'Host': 'kohcamp.qq.com',
        'Origin': 'https://yingdi.qq.com',
        'Referer': 'https://yingdi.qq.com/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.95 Safari/537.36',
        'noencrypt': '1',
        'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'ssoAppId': 'campAuthor',
        'ssoBusinessId': 'web',
        'ssoOpenId': '',
        'ssoToken': ''
    };
}

export class ScanCodeLogin extends plugin {
    constructor() {
        super({
            name: 'scanCodeLogin',
            dsc: '王者扫码登录',
            event: 'message',
            priority: 1,
            rule: [
                { reg: /^#营地扫码$/, fnc: 'scanCodeLogin' },
                { reg: /^#我的王者Tk$/, fnc: 'getMyTokenAndOpenId' }
            ]
        })
    }

    async scanCodeLogin(e) {
        const { user_id } = e;

        try {
            const qrResponse = await fetch('https://kohcamp.qq.com/sso/getqrcode', {
                method: 'POST',
                headers: {
                    ...getCommonHeaders(),
                    'Content-Length': '0',
                    'specialEncodeParam': 'rhIMIdd/m8fRrf5i/cQFxSdQkp+WAop5GN2SMAbFTDp0QvvG7eCJQjeBuJmyv4BT3nl0BS452F2XEQawpnfZaPpjVKdoA28/waERI7lJuPmLc8RVYiQ1SQpLFbc6eGsuoVqW//856jkWy4KuZEU03reL5mGkbIx1LpRcVkKM/3k='
                }
            });

            if (!qrResponse.ok) {
                await e.reply('获取二维码失败，请稍后重试。');
                return;
            }

            const qrData = await qrResponse.json();
            const { qrCodeFile } = qrData;

            const buffer = Buffer.from(qrCodeFile, 'base64');
            const imagePath = path.join('data', 'qrcode.png');
            fs.writeFileSync(imagePath, buffer);

            const dirPath = path.join('data', 'WzryData', 'ScanCodeLoginData');
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }

            writeJsonFile(getFilePath(user_id), qrData);

            await e.reply(['请在120秒内[打开王者营地-->我-->右上角扫码]扫描该二维码登录', segment.image(imagePath)]);
            fs.unlinkSync(imagePath);
        } catch (error) {
            logger.error(error);
            await e.reply('获取二维码时发生错误，请稍后重试。');
            return;
        }

        let loginSuccess = false;
        for (let i = 0; i < 120; i++) {
            try {
                const scanCodeLoginData = readJsonFile(getFilePath(user_id));
                const response = await fetch(`https://kohcamp.qq.com/sso/qrconnect`, {
                    method: 'POST',
                    headers: {
                        ...getCommonHeaders(),
                        'Content-Type': 'application/json;charset=UTF-8'
                    },
                    body: JSON.stringify({
                        uUid: scanCodeLoginData.uUid
                    })
                });

                if (!response.ok) {
                    continue;
                }

                const data = await response.json();
                const { statusCode, msg, code } = data;

                if (statusCode === 408 && msg === "没扫码") {
                    await common.sleep(1000);
                    continue;
                } else {
                    scanCodeLoginData.code = code;
                    writeJsonFile(getFilePath(user_id), scanCodeLoginData);

                    const tokenResponse = await fetch('https://kohcamp.qq.com/sso/code2session', {
                        method: 'POST',
                        headers: {
                            ...getCommonHeaders(),
                            'Content-Type': 'application/json;charset=UTF-8',
                            'specialEncodeParam': 'bDDKzNEKn6L7257wFRD1wGRoVTNfl1kh9BnWkLaDCCeA4U4XarSrk1OptC21Zj682xDFYtfWW4Ao5uOglwReOfCvFXkwo3piug4PLll/OwXlD5aSOLn/Ucbltfw9//xJvTWB+xb9qRT3Pu1M8vm0wxX2b5OTm7SrUJ5V2jkA594='
                        },
                        body: JSON.stringify({
                            grantType: 'authorization_code',
                            code: scanCodeLoginData.code
                        })
                    });

                    if (!tokenResponse.ok) {
                        continue;
                    }

                    const tokenData = await tokenResponse.json();
                    const { ssoOpenId, ssoToken } = tokenData.session;
                    scanCodeLoginData.ssoOpenId = ssoOpenId;
                    scanCodeLoginData.ssoToken = ssoToken;
                    writeJsonFile(getFilePath(user_id), scanCodeLoginData);

                    const userInfoResponse = await fetch('https://kohcamp.qq.com/pc/user/infolist', {
                        method: 'POST',
                        headers: {
                            ...getCommonHeaders(),
                            'Content-Type': 'application/json',
                            'ssoOpenId': ssoOpenId,
                            'ssoToken': ssoToken
                        }
                    });

                    if (!userInfoResponse.ok) {
                        throw new Error('Failed to fetch user info');
                    }

                    const userInfoData = await userInfoResponse.json();
                    const userId = userInfoData.list[0].userId;

                    const filePath = path.join('data', 'WzryData', 'UserData.yaml');
                    let userData = {};

                    if (fs.existsSync(filePath)) {
                        userData = YAML.parse(fs.readFileSync(filePath, 'utf8'));
                    }

                    userData[user_id] = userId;
                    fs.writeFileSync(filePath, YAML.stringify(userData), 'utf8');

                    function formatDateString(dateString) {
                        const date = new Date(dateString);
                        const year = date.getFullYear();
                        const month = ('0' + (date.getMonth() + 1)).slice(-2);
                        const day = ('0' + date.getDate()).slice(-2);
                        const hours = ('0' + date.getHours()).slice(-2);
                        const minutes = ('0' + date.getMinutes()).slice(-2);
                        const seconds = ('0' + date.getSeconds()).slice(-2);
                        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
                      }

                    const expireDate = formatDateString(parseInt(tokenData.expireTime) * 1000);

                    await e.reply(`登录成功\rToken过期时间: ${expireDate}\r过期之后需要重新扫码登录`);
                    loginSuccess = true;
                    break;
                }
            } catch (error) {
                logger.error(error);
                continue;
            }
        }

        if (!loginSuccess) {
            await e.reply('扫码超时，请重新尝试');
        }
    }

    async getMyTokenAndOpenId(e) {
        const { user_id } = e;
        const filePath = getFilePath(user_id);

        if (!fs.existsSync(filePath)) {
            await e.reply('未找到登录信息，请先扫码登录。');
            return;
        }

        const userData = readJsonFile(filePath);
        const { ssoOpenId, ssoToken } = userData;

        if (!ssoOpenId || !ssoToken) {
            await e.reply('未找到有效的Token或OpenId，请重新扫码登录。');
            return;
        }

        await e.reply(`您的Token: ${ssoToken}\n您的OpenId: ${ssoOpenId}`);
    }
}

function getFilePath(user_id) {
    return path.join('data', 'WzryData', 'ScanCodeLoginData', `${user_id}.json`);
}

function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data));
}