import { runHeroGuide } from './heroGuide.js'

/**
 * 「裸」英雄攻略指令：`#攻略 / #出装 / #铭文 / #克制 / #英雄攻略 / #铭文出装`。
 *
 * 和 heroGuide.js（带「王者」前缀，priority 0）拆开的理由见那边的文件头注释：
 * 这几个短指令原神等插件也有同名的，挂 priority 0 会抢在它们前面吞消息，
 * 所以降到默认档 5000，跟它们同一起跑线，靠注册顺序公平竞争。
 */
export class HeroGuideAlias extends plugin {
  constructor () {
    super({
      name: '王者英雄攻略（裸指令）',
      dsc: '英雄出装建议、英雄关系与技能说明（裸指令入口，低优先级）',
      event: 'message',
      // 故意不压到 0/1：不抢别的插件的 #攻略 / #出装 / #铭文 指令
      priority: 5000,
      rule: [
        {
          reg: '^#(英雄攻略|攻略|出装|克制|铭文出装|铭文)\\s*(.*)$',
          fnc: 'guide'
        }
      ]
    })
  }

  async guide (e) {
    return runHeroGuide(e)
  }
}
