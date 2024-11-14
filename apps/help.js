export class Help extends plugin {
    constructor() {
        super({
            name: 'help',
            dsc: '显示帮助信息',
            event: 'message',
            priority: 1,
            rule: [
                { reg: /^#?王者帮助$/, fnc: 'showHelp' }
            ]
        });
    }

    async showHelp(e) {
        const helpMessage = [
            '王者菜单(文字版)',
            '1. #绑定营地ID [你的ID] - 绑定你的营地ID',
            '2. #王者主页 - 查看你的王者主页',
            '3. #查询战绩 - 查询你的游戏战绩',
            '4. #营地扫码 - 扫码登录',
        ];
        await e.reply(helpMessage.join('\n'));
    }
} 