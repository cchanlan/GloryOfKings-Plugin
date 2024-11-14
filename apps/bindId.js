import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

export class BindId extends plugin {
    constructor() {
        super({
            name: 'bindId',
            dsc: '绑定营地ID',
            event: 'message',
            priority: 1,
            rule: [
                { reg: /^#绑定营地ID\s+(\d+)$/, fnc: 'bindId' }
            ]
        })
    }

    async bindId(e) {
        const { user_id } = e;
        const match = e.msg.match(/^#绑定营地ID\s+(\d+)$/);
        if (!match) {
            await e.reply('请输入正确的格式：#绑定营地ID [你的ID]');
            return;
        }

        const ID = match[1];
        const filePath = path.join('data', 'WzryData', 'UserData.yaml');

        let userData = {};
        if (fs.existsSync(filePath)) {
            userData = YAML.parse(fs.readFileSync(filePath, 'utf8'));
        }

        userData[user_id] = ID;

        fs.writeFileSync(filePath, YAML.stringify(userData), 'utf8');
        await e.reply(`ID ${ID} 绑定成功！`);
    }
}

