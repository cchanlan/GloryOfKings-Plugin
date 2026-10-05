import { update as Update } from '../../other/update.js'
import { PluginName } from '#components'

/**
 * 插件自身的更新（`#王者更新` / `#王者更新日志`）。
 *
 * 只是把云崽自带的更新模块包一层：那个模块会按插件目录去 git pull，
 * 并维护一份更新记录，这里负责把群消息转成它认的 `#更新<插件名>` 形式。
 *
 * ⚠️ `../../other/update.js` 是**框架**提供的模块，不是本插件的文件 ——
 * 插件目录是 `<云崽根>/plugins/GloryOfKings-Plugin`，往上两级正好回到云崽根。
 * 云崽 / TRSS / JiuLi 都在 `plugins/other/update.js` 放了这一份，路径一致。
 * 万一某个衍生框架没有它，`index.js` 的模块加载 catch 会记一条日志并跳过本文件，
 * 插件的其它功能不受影响（不会整个起不来）。
 */
export class GloryOfKingsUpdate extends plugin {
  constructor () {
    super({
      name: '王者插件_更新',
      dsc: '调用云崽自带更新模块进行插件更新',
      event: 'message',
      // 最低优先级：更新是兜底指令，任何具体功能的正则都该先有机会匹配。
      // ⚠️ 这里原来是 2000 —— 数值上是错的：云崽 priority **从小到大**执行，
      //    2000 反而排在默认档（5000）插件**前面**，跟注释的「最低优先级」正好相反。
      //    两条正则都是带「王者/农药」前缀的全锚定串，撞不上别的指令，所以这个误会
      //    一直没造成实际事故；改成 5010 只是让数值跟原意一致。
      priority: 5010,
      rule: [
        {
          reg: '^#*(王者|农药)(插件)?(强制)?更新$',
          fnc: 'update',
          permission: 'master'
        },
        {
          reg: '^#*(王者|农药)(插件)?更新(日志|记录)$',
          fnc: 'update_log',
          permission: 'master'
        }
      ]
    })
  }

  async update (e) {
    // 带了 @ 但不是 @ 机器人，说明是在指别人，不接
    if (e.at && !e.atme) return
    // 更新模块只认 `#更新<插件名>` / `#强制更新<插件名>`
    e.msg = `#${e.msg.includes('强制') ? '强制' : ''}更新${PluginName}`
    const up = new Update(e)
    up.e = e
    return up.update()
  }

  async update_log () {
    const updater = new Update()
    updater.e = this.e
    updater.reply = this.reply

    if (updater.getPlugin(PluginName)) {
      this.e.reply(await updater.getLog(PluginName))
    }
    return true
  }
}
