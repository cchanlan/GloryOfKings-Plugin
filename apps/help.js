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
            '1. #王者主页 - 查看你的王者主页',
            '2. #查询战绩 - 查询你的游戏战绩,附带数字查看战绩详细数据',
            '3. #营地扫码 - 扫码登录',
            '4. #王者更新/农药更新 - 更新插件'
        ];
        await e.reply(helpMessage.join('\n'));
    }
} 