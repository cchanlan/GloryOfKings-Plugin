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

        let index = e.msg.match(/#查询战绩(\d+)?/)[1];
        index = Number(index);
        if (isNaN(index)) {
            index = false;
        }

        const response_ = await ApiService.post('/game/morebattlelist', {
            lastTime: 0,
            recommendPrivacy: 0,
            apiVersion: 5,
            friendUserId: ID,
            option: 0
        }, {
            ssoopenid: ssoOpenId,
            ssotoken: ssoToken
        });

        if (response_.returnCode === -30003) {
            e.reply('登陆状态失效，请重新扫码登录');
            return;
        }

        if (index) {
            const { battleType, gameSvrId: gameSvr, relaySvrId: relaySvr, battleDetailUrl, gameSeq } = response_.data.list[index - 1];

            let targetRoleId = null;
            if (battleDetailUrl.length > 0) {
                let i0 = battleDetailUrl.indexOf("&toAppRoleId=");
                let i1 = battleDetailUrl.indexOf("&toGameRoleId=");
                targetRoleId = battleDetailUrl.substring(i0 + 13, i1);
            }

            const response = await ApiService.post('/game/battledetail', {
                recommendPrivacy: 0,
                battleType,
                gameSvr,
                relaySvr,
                targetRoleId,
                gameSeq
            }, {
                ssoopenid: ssoOpenId,
                ssotoken: ssoToken
            })

            const { head,battle, redTeam, blueTeam } = response.data;

            let myTeamColor = '';
            let enemyTeamColor = '';
            if (head.acntCamp === redTeam.acntCamp) {
                myTeamColor = '红';
                enemyTeamColor = '蓝';
            } else if (head.acntCamp === blueTeam.acntCamp) {
                myTeamColor = '蓝';
                enemyTeamColor = '红';
            }

            /**
             * gameResult 游戏结果  
             * gameResultEn 游戏结果英文  
             * mapName 地图名称  
             * startTime 游戏开始时间  
             * usedTime 游戏时长  
             * matchDesc 对局描述  
             * economyRate 经济百分比  
             *   
             * myMoney 我方经济  
             * myTowerCnt 我方推塔数量  
             * myKillDeadAssistCnt 我方击杀死亡助攻数量  
             *   
             * enemyMoney 敌方经济  
             * enemyTowerCnt 敌方推塔数量  
             * enemyKillDeadAssistCnt 敌方击杀死亡助攻数量  
             */
            let us = {}
            
            if (head.gameResult) {
                us.gameResult = '胜利'
                us.gameResultEn = 'VICTORY';
            } else {
                us.gameResult = '失败';
                us.gameResultEn = 'DEFEAT';
            }

            us.mapName = head.mapName
            us.startTime = battle.startTime
            us.usedTime = Math.ceil(battle.usedTime / 60)
            us.matchDesc = head.matchDesc

            if (myTeamColor === '蓝') {
                us.myMoney = blueTeam.money
                us.myTowerCnt = blueTeam.towerCnt
                us.enemyMoney = redTeam.money
                us.enemyTowerCnt = redTeam.towerCnt
                us.myKillDeadAssistCnt = redTeam.killCnt + '/' + redTeam.deadCnt + '/' + redTeam.assistCnt
                us.enemyKillDeadAssistCnt = blueTeam.killCnt + '/' + blueTeam.deadCnt + '/' + blueTeam.assistCnt
            } else {
                us.myMoney = redTeam.money
                us.myTowerCnt = redTeam.towerCnt
                us.enemyMoney = blueTeam.money
                us.enemyTowerCnt = blueTeam.towerCnt
                us.myKillDeadAssistCnt = blueTeam.killCnt + '/' + blueTeam.deadCnt + '/' + blueTeam.assistCnt
                us.enemyKillDeadAssistCnt = redTeam.killCnt + '/' + redTeam.deadCnt + '/' + redTeam.assistCnt
            }
            
            us.myEconomyRate = (us.myMoney / (us.myMoney + us.enemyMoney)) * 100;

            const data = {
                tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordDetails.html',
                ...us,
                myTeamColor,
                enemyTeamColor,
                battle: response.data.battle
            };

            const inventoryImage = await puppeteer.screenshot('QueryGameRecordDetails', data);

            await e.reply(inventoryImage);
            return;
        }

        await e.reply(`共查询到${response_.data.list.length}条游戏记录`);

        const data = response_.data.list.map(item => ({
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

        const inventoryImage = await puppeteer.screenshot('QueryGameRecordList', {
            tplFile: 'plugins/GloryOfKings-Plugin/resources/html/QueryGameRecordList.html',
            data,
            roleJobName: response_.data.list[0].roleJobName,
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