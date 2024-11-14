import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import common from '../../../lib/common/common.js'

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
        'ssoAppId': 'campPc',
        'ssoBusinessId': 'pc',
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
                { reg: /^#营地扫码$/, fnc: 'scanCodeLogin' }
            ]
        })
    }

    async scanCodeLogin(e) {
        const { user_id } = e;
        await getQRCode(user_id);
        const imagePath = path.join('data', 'qrcode.png');
        await e.reply(['请在120秒内[打开王者营地-->我-->右上角扫码]扫描该二维码登录', segment.image(imagePath)]);

        fs.unlinkSync(imagePath);

        for (let i = 0; i < 120; i++) {
            const res = await checkQRCodeStatus(user_id);
            await common.sleep(1000);
            if (res === 100) {
                await e.reply('登录成功，正在获取token和openId');
                const { ssoOpenId, ssoToken, ssoappid, ssobusinessid } = JSON.parse(fs.readFileSync(path.join('data', 'WzryData', 'ScanCodeLoginData', `${user_id}.json`), 'utf8'));
                await e.reply(`ssoOpenId: ${ssoOpenId}\nssoToken: ${ssoToken}\rssobusinessid${ssobusinessid}\nssoappid${ssoappid}`);
                break;
            }
        }
    }
}

function getFilePath(user_id, fileName = '') {
    return path.join('data', 'WzryData', 'ScanCodeLoginData', `${user_id}${fileName}`);
}

function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data));
}

async function getQRCode(user_id) {
    try {
        const response = await fetch('https://kohcamp.qq.com/sso/getqrcode', {
            method: 'POST',
            headers: {
                ...getCommonHeaders(),
                'Content-Length': '0',
                'specialEncodeParam': 'rhIMIdd/m8fRrf5i/cQFxSdQkp+WAop5GN2SMAbFTDp0QvvG7eCJQjeBuJmyv4BT3nl0BS452F2XEQawpnfZaPpjVKdoA28/waERI7lJuPmLc8RVYiQ1SQpLFbc6eGsuoVqW//856jkWy4KuZEU03reL5mGkbIx1LpRcVkKM/3k='
            }
        });

        if (!response.ok) {
            return -101;
        }

        const data = await response.json();
        const { qrCodeFile } = data;

        const buffer = Buffer.from(qrCodeFile, 'base64');
        const imagePath = path.join('data', 'qrcode.png');
        fs.writeFileSync(imagePath, buffer);

        const dirPath = path.join('data', 'WzryData', 'ScanCodeLoginData');
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        writeJsonFile(getFilePath(user_id), data);
        return 0;
    } catch (error) {
        logger.error(error);
        return -100;
    }
}

async function checkQRCodeStatus(user_id) {
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
            return -101;
        }

        const data = await response.json();
        const { statusCode, msg, code } = data;

        if (statusCode === 408 && msg === "没扫码") { } else {
            scanCodeLoginData.code = code;
            writeJsonFile(getFilePath(user_id), scanCodeLoginData);
            await getTokenAndOpenId(user_id);
            return 100;
        }
        return 0;
    } catch (error) {
        logger.error(error);
        return -100;
    }
}

async function getTokenAndOpenId(user_id) {
    try {
        const scanCodeLoginData = readJsonFile(getFilePath(user_id));
        const response = await fetch('https://kohcamp.qq.com/sso/code2session', {
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

        if (!response.ok) {
            return -101;
        }

        const data = await response.json();
        const { ssoOpenId, ssoToken } = data.session;
        scanCodeLoginData.ssoOpenId = ssoOpenId;
        scanCodeLoginData.ssoToken = ssoToken;
        writeJsonFile(getFilePath(user_id), scanCodeLoginData);
        return 100;
    } catch (error) {
        logger.error(error);
        return -100;
    }
}