import fs from 'node:fs'
import path from 'node:path'
import { writeYamlFile } from './utils/yamlUtils.js'

logger.info('王者荣耀插件...')

global.wzryIdImg = 'https://gitee.com/Tloml-Starry/resources/raw/master/resources/img/example/%E7%8E%8B%E8%80%85%E8%90%A5%E5%9C%B0ID%E8%8E%B7%E5%8F%96.png'
const paths = {
    userDataDir: path.join('data', 'WzryData'),
    userSettingsDir: path.join('data', 'WzryData', 'user_settings'),
    userDataFile: path.join('data', 'WzryData', 'UserData.yaml'),
    gameRecordPushFile: path.join('data', 'WzryData', 'GameRecordPush.yaml'),
    userSettingsFile: path.join('data', 'WzryData', 'user_settings.yaml')
};

Object.entries(paths).forEach(([key, filePath]) => {
    if (!fs.existsSync(filePath)) {
        if (key.includes('Dir')) {
            fs.mkdirSync(filePath, { recursive: true });
            logger.info(`${key} 文件夹不存在，已自动创建。`);
        } else {
            writeYamlFile(filePath, key === 'gameRecordPushFile' ? { pushList: {} } : {});
            logger.info(`${key} 文件不存在，已自动创建。`);
        }
    }
});

const files = fs.readdirSync('./plugins/GloryOfKings-Plugin/apps').filter(file => file.endsWith('.js'))

let ret = []

files.forEach((file) => {
    ret.push(import(`./apps/${file}`))
})

ret = await Promise.allSettled(ret)

let apps = {}
for (let i in files) {
    let name = files[i].replace('.js', '')

    if (ret[i].status != 'fulfilled') {
        logger.error(`载入插件错误：${logger.red(name)}`)
        logger.error(ret[i].reason)
        continue
    }
    apps[name] = ret[i].value[Object.keys(ret[i].value)[0]]
}

export { apps }
logger.mark('王者荣耀插件载入成功')
