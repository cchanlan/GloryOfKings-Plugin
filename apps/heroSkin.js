import fs from 'node:fs'
import path from 'node:path'
import api from '../utils/api.js'
import {
  getLocalImage,
  getPvpSkinCover,
  getPvpHeroSkins,
  getCampHeroSkins,
  getCurrentId,
  Button,
  shouldQuote
} from '#utils'
import { PluginPath } from '#components'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'

// 元流之子的 5 个分身统一用缩写：元法/元射/元辅/元坦/元刺
const YUAN_ABBR = { 法: '法师', 射: '射手', 辅: '辅助', 坦: '坦克', 刺: '刺客' }

// 英雄列表里存的是半角括号全名，输入侧把缩写展开
const expandYuan = name => {
    const abbr = name.match(/^元(.)$/)
    return abbr && YUAN_ABBR[abbr[1]] ? `元流之子(${YUAN_ABBR[abbr[1]]})` : name
}

// 展示侧反向简化：元流之子(法师) → 元法
const simplifyYuan = text => String(text ?? '').replace(/元流之子\s*[（(]\s*(.)[^）)]*[）)]/g, '元$1')

// 官方横版大图(1920x882)，路径里的序号是「皮肤序号+1」，原皮为 1。
// 只覆盖上线一段时间的皮肤，新皮肤和联动皮肤常年 404，但它是原皮立绘的唯一来源。
const gtimgBigSkin = (ename, seq) =>
    `https://game.gtimg.cn/images/yxzj/img201606/skin/hero-info/${ename}/${ename}-bigskin-${seq}.jpg`

// 手动补图目录：按「皮肤ID.后缀」放图，命中就优先用它，压过所有线上图源。
// 给官方各处都只给 180x280 卡面的皮肤(如墨子的迪迦奥特曼 10807)兜底，
// 以后再遇到这种皮肤，往这个目录丢一张 <皮肤ID>.jpg 就行，不用改代码。
const LOCAL_SKIN_DIR = path.join(PluginPath, 'resources', 'img', 'skin')
const LOCAL_SKIN_EXTS = ['.jpg', '.jpeg', '.png', '.webp']

function findLocalSkinImage (skinId) {
    for (const ext of LOCAL_SKIN_EXTS) {
        const file = path.join(LOCAL_SKIN_DIR, `${skinId}${ext}`)
        if (fs.existsSync(file)) return file
    }
    return ''
}

// 皮肤图并发下载数，和皮肤墙保持一致
const CONCURRENCY = 6
// 内联进模板前的宽度上限：官方 bigskin 原图 1920x882 单张就有 1.3MB，
// 一个英雄十几张会把 HTML 撑到十几 MB、拖慢截图，缩到 1400 宽后单张约 250KB，画质仍富余。
const MAX_INLINE_WIDTH = 1400
// 反过来，营地卡面图只有 180x280，模板里要铺满整卡宽度，交给浏览器直接拉大会糊成一团。
// 先用 lanczos 放到展示尺寸再锐化一次，插值痕迹会干净不少。
const MIN_INLINE_WIDTH = 480

/**
 * 把下载好的图片转成模板可直接内联的 data URL，过宽的缩一档、过小的放大到展示尺寸。
 * sharp 是 Yunzai 的核心依赖，缺失或解码失败时原样内联，不影响出图。
 */
async function toInlineImage (buffer, url) {
    try {
        const sharp = (await import('sharp')).default
        const meta = await sharp(buffer).metadata()
        if (meta.width > MAX_INLINE_WIDTH) {
            const resized = await sharp(buffer).resize({ width: MAX_INLINE_WIDTH }).jpeg({ quality: 85 }).toBuffer()
            return `data:image/jpeg;base64,${resized.toString('base64')}`
        }
        if (meta.width && meta.width < MIN_INLINE_WIDTH) {
            const enlarged = await sharp(buffer)
                .resize({ width: MAX_INLINE_WIDTH, kernel: 'lanczos3' })
                .sharpen()
                .jpeg({ quality: 88 })
                .toBuffer()
            return `data:image/jpeg;base64,${enlarged.toString('base64')}`
        }
    } catch (err) {
        logger.debug(`[查皮肤] 图片预处理跳过: ${err.message}`)
    }
    const pathPart = String(url).split('?')[0]
    const dot = pathPart.lastIndexOf('.')
    const ext = dot > -1 ? pathPart.slice(dot).toLowerCase() : ''
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${buffer.toString('base64')}`
}

async function batch (tasks, limit = CONCURRENCY) {
    const results = new Array(tasks.length)
    let i = 0
    const worker = async () => {
        while (i < tasks.length) {
            const idx = i++
            results[idx] = await tasks[idx]()
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()))
    return results
}

export class HeroSkin extends plugin {
    constructor() {
        super({
            name: '查询王者英雄皮肤',
            dsc: '查询英雄皮肤',
            event: 'message',
            priority: 5000,
            rule: [
                { reg: /^#查皮肤.*/, fnc: 'checkHeroSkin' }
            ]
        })
    }

    /**
     * 组装某个英雄的皮肤清单。三级数据源，谁能用用谁：
     *  1) 营地全量皮肤配置表——唯一齐全的源，含原皮与刚上线的联动皮肤(如墨子的迪迦奥特曼)
     *  2) 官网皮肤总表——不含原皮，但不需要登录态，营地取不到时用它，再把原皮补上
     *  3) 官网 herolist 的 skin_name——更新滞后(海月就漏了两张)，只在前两者都拿不到时兜底
     * @returns {Promise<Array<{skinId: string, name: string, campLarge: string, campCover: string}>>}
     */
    async #collectSkins (e, hero, fullName) {
        const heroSkinNames = hero?.skin_name ? hero.skin_name.split('|') : []
        let campId = ''
        try {
            campId = getCurrentId(e.user_id) || ''
        } catch {}

        const campSkins = await getCampHeroSkins(hero?.cname || fullName, { campId, botUserId: e.user_id })
        if (campSkins.length) {
            return campSkins.map(conf => ({
                skinId: String(conf.iSkinId),
                name: conf.szTitle || '',
                campLarge: conf.szLargeIcon || '',
                campCover: conf.bigCover || conf.szSmallIcon || ''
            }))
        }

        const pvpSkins = await getPvpHeroSkins(hero?.cname || fullName)
        if (pvpSkins.length) {
            const list = pvpSkins.map(skin => ({
                skinId: skin.skinId,
                name: skin.name || '',
                campLarge: '',
                campCover: ''
            }))
            // 官网总表只收售卖皮肤，原皮(序号 0)按 herolist 的名字补一条
            if (hero) {
                list.unshift({ skinId: `${hero.ename}00`, name: heroSkinNames[0] || '', campLarge: '', campCover: '' })
            }
            return list
        }
        if (!hero) return []

        return heroSkinNames.map((name, idx) => ({
            skinId: `${hero.ename}${String(idx).padStart(2, '0')}`,
            name,
            campLarge: '',
            campCover: ''
        }))
    }

    async checkHeroSkin(e) {
        const heroName = e.msg.replace(/#|查皮肤|\s+|\n+/g, '').trim()
        if (!heroName) {
            await e.reply(['请输入要查询的英雄名称', Button.hero()])
            return
        }

        const fullName = expandYuan(heroName)
        let heroList = []
        try {
            heroList = await api.getHeroList()
        } catch (error) {
            // 英雄列表只用来拿 ename 和原皮名，拿不到也还能靠营地配置表出图，故不直接退出
            logger.error(`[查皮肤] 获取英雄列表失败: ${error.message}`)
        }
        const hero = heroList.find(h => h.cname === fullName)

        const skins = await this.#collectSkins(e, hero, fullName)
        if (!skins.length) {
            await e.reply(['未找到该英雄的皮肤信息', Button.hero()])
            return
        }

        const heroSkinNames = hero?.skin_name ? hero.skin_name.split('|') : []
        const ename = hero?.ename || Math.floor(Number(skins[0].skinId) / 100)

        // 每张皮肤逐级找图，拿到第一张真图即止（惰性求值，命中首选就不会去问后面的源）：
        //   0) resources/img/skin/<皮肤ID> 手动补的图——线上各处都没有大图时人工补，优先级最高
        //   1) 官方 bigskin 横版大图(1920x882)——游戏内的皮肤大图，构图完整、观感最好，
        //      仅当序号位置的皮肤名与 herolist 对得上才用，否则营地跳号(海月缺 52105)会把图配错
        //   2) 官网总表立绘裁成的横版图(1400x788)——覆盖 800+ 张售卖皮肤，bigskin 还没铺图的新皮靠它；
        //      它取的是官网横幅立绘，构图偏局部特写，故排在 bigskin 之后
        //   3) 营地 szLargeIcon 竖版大图(720x1280)——新皮肤这里常是无效地址，能用则用
        //   4) 营地 bigCover 卡面图(180x280)——清晰度垫底，但联动皮肤往往只剩它
        // 后两级是竖图，模板一律按整卡宽度铺满显示，故内联前会先放大到展示尺寸再锐化。
        const tasks = skins.map(skin => async () => {
            const localFile = findLocalSkinImage(skin.skinId)
            if (localFile) {
                try {
                    skin.url = await toInlineImage(fs.readFileSync(localFile), localFile)
                    skin.tier = 'L'
                    return
                } catch (err) {
                    logger.error(`[查皮肤] 本地补图读取失败 ${localFile}: ${err.message}`)
                }
            }

            const seq = Number(skin.skinId) % 100
            const nameMatched = heroSkinNames[seq] && heroSkinNames[seq] === skin.name
            const sources = [
                () => (nameMatched ? gtimgBigSkin(ename, seq + 1) : ''),
                () => getPvpSkinCover(skin.skinId, 'landscape'),
                () => skin.campLarge,
                () => skin.campCover
            ]
            for (let si = 0; si < sources.length; si++) {
                const url = await sources[si]()
                if (!url) continue
                const img = await getLocalImage(url)
                if (!Buffer.isBuffer(img)) continue
                skin.url = await toInlineImage(img, url)
                skin.tier = si + 1
                return
            }
            skin.url = ''
            skin.tier = 0
        })
        await batch(tasks)

        // 图源命中分布，排查“某张皮肤没图/图很糊”时用得上
        logger.debug(`[查皮肤] ${fullName} 共 ${skins.length} 款，图源命中: ${skins.map(s => s.tier ?? '-').join(',')}`)

        const displayName = simplifyYuan(hero?.cname || fullName)
        const withImage = skins.filter(skin => skin.url).length
        if (!withImage) {
            await e.reply(['未找到该英雄的皮肤图片', Button.hero(displayName)])
            return
        }

        const img = await puppeteer.screenshot('HeroSkin', {
          imgType: 'webp',
            tplFile: 'plugins/GloryOfKings-Plugin/resources/html/HeroSkin.html',
            heroName: displayName,
            skinCount: skins.length,
            skinData: skins.map((skin, index) => ({
                name: simplifyYuan(skin.name),
                url: skin.url,
                index: index + 1
            }))
        })

        await e.reply([img, Button.hero(displayName)], shouldQuote())
    }
}
