import puppeteer from '../../../lib/puppeteer/puppeteer.js';

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
        const inventoryImage = await puppeteer.screenshot('help', {
            tplFile: 'plugins/GloryOfKings-Plugin/resources/html/help.html',
        })

        await e.reply(inventoryImage)
    }
} 