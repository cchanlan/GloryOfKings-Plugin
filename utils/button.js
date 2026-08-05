/**
 * 官方 QQ Bot 按钮
 *
 * segment.button(...行) 每个参数是一行，行内是按钮数组。
 * - callback: 点击后直接以该文本触发指令
 * - input:    点击后把文本填进输入框，等用户补参数再发
 * 非 QQBot 适配器（OneBot 等）会自动忽略 button 段，不影响其他平台。
 *
 * 注意：callback 里的指令必须能被 apps 里的 reg 命中，
 * 带参数的指令（营地ID/英雄名等）一律用 input。
 */
export default class Button {
  /** 帮助面板 */
  static help() {
    return segment.button(
      [
        { text: '绑定营地', input: '#绑定营地' },
        { text: '我的ID', callback: '#营地ID' }
      ],
      [
        { text: '王者主页', callback: '#王者主页' },
        { text: '查询战绩', callback: '#查询战绩' }
      ],
      [
        { text: '常用英雄', callback: '#常用英雄' },
        { text: '英雄梯度', callback: '#英雄梯度' }
      ],
      [
        { text: '查战力', input: '#查战力' },
        { text: '皮肤墙', callback: '#皮肤墙' }
      ]
    )
  }

  /** 未绑定营地ID时的引导 */
  static bind() {
    return segment.button([
      { text: '绑定营地', input: '#绑定营地' },
      { text: '怎么获取ID', callback: '#获取营地ID' }
    ])
  }

  /** 账号管理（#营地ID 等场景） */
  static account(ids = []) {
    const rows = []
    // 已绑定多个账号时，给每个账号一个直达主页的按钮
    const slots = ids.slice(0, 6)
    for (let i = 0; i < slots.length; i += 2) {
      const row = [{ text: `${i + 1}号主页`, callback: `#王者主页${i + 1}` }]
      if (slots[i + 1]) row.push({ text: `${i + 2}号主页`, callback: `#王者主页${i + 2}` })
      rows.push(row)
    }
    rows.push([
      { text: '绑定营地', input: '#绑定营地' },
      { text: '切换营地', input: '#切换营地' }
    ])
    rows.push([
      { text: '营地登录', callback: '#营地wx登录' },
      { text: '删除营地', input: '#删除营地' }
    ])
    return segment.button(...rows)
  }

  /**
   * 王者主页
   * @param {string|number} id 营地ID，带上后按钮直接查该ID；不传则查当前账号
   */
  static homepage(id = '') {
    const s = id ? String(id) : ''
    return segment.button(
      [
        // #查询战绩<营地ID>：handleQuery 里 >9999 的数字会被当成营地ID
        { text: '查询战绩', callback: `#查询战绩${s}` },
        { text: '常用英雄', callback: `#常用英雄${s}` }
      ],
      [
        { text: '排位表现', callback: `#排位表现${s}` },
        { text: '巅峰表现', callback: `#巅峰表现${s}` }
      ],
      [
        { text: '皮肤墙', callback: `#皮肤墙${s}` },
        { text: '全部皮肤', callback: `#全部皮肤${s}` }
      ]
    )
  }

  /**
   * 战绩列表
   * 带营地ID时走 `#查询<ID><模式>战绩<序号>` 这一路（reg 里 \d+ 捕获组，>9999 视为直接传ID）；
   * 不带ID时走 `#查询战绩<模式><序号>`。两种写法模式关键词的位置不同，别写反。
   * @param {string|number} id 营地ID，可为空
   * @param {number} count 本次返回的场次数，用于生成「第N场」按钮
   * @param {string} mode 当前模式（排位/标准/巅峰），空表示全部
   */
  static gameStats(id = '', count = 0, mode = '') {
    const s = id ? String(id) : ''
    const cmd = (m = '', n = '') => (s ? `#查询${s}${m}战绩${n}` : `#查询战绩${m}${n}`)
    const rows = []

    // 单场详情：必须带上当前模式，否则序号会对应到未筛选的列表
    const detail = []
    for (let i = 1; i <= Math.min(3, count); i++) {
      detail.push({ text: `第${i}场`, callback: cmd(mode, i) })
    }
    if (detail.length) rows.push(detail)

    // 模式切换：只列出当前模式之外的选项
    const others = ['排位', '巅峰', '标准'].filter(m => m !== mode)
    const modeRow = others.map(m => ({ text: `${m}战绩`, callback: cmd(m) }))
    if (mode) modeRow.unshift({ text: '全部战绩', callback: cmd() })
    // 一行最多放 3 个
    for (let i = 0; i < modeRow.length; i += 3) rows.push(modeRow.slice(i, i + 3))

    rows.push([
      { text: '王者主页', callback: `#王者主页${s}` },
      { text: '常用英雄', callback: `#常用英雄${s}` }
    ])

    return segment.button(...rows)
  }

  /**
   * 单场战绩详情
   * @param {string|number} id 营地ID
   * @param {string} mode 该场所属模式，返回列表时保持筛选一致
   */
  static gameStatsDetail(id = '', mode = '') {
    const s = id ? String(id) : ''
    const back = s ? `#查询${s}${mode}战绩` : `#查询战绩${mode}`
    return segment.button([
      { text: '返回战绩列表', callback: back },
      { text: '王者主页', callback: `#王者主页${s}` }
    ])
  }

  /** 常用英雄 */
  static heroList(id = '') {
    const s = id ? String(id) : ''
    return segment.button(
      [
        { text: '查战力', input: '#查战力' },
        { text: '英雄梯度', callback: '#英雄梯度' }
      ],
      [
        { text: '王者主页', callback: `#王者主页${s}` },
        { text: '查询战绩', callback: `#查询战绩${s}` }
      ]
    )
  }

  /**
   * 英雄相关（查战力/查皮肤互跳）
   * @param {string} heroName 英雄名
   */
  static hero(heroName = '') {
    if (!heroName) {
      return segment.button([
        { text: '查战力', input: '#查战力' },
        { text: '查皮肤', input: '#查皮肤' }
      ])
    }
    return segment.button(
      [
        { text: `${heroName}战力`, callback: `#查战力${heroName}` },
        { text: `${heroName}皮肤`, callback: `#查皮肤${heroName}` }
      ],
      [
        { text: '英雄梯度', callback: '#英雄梯度' },
        { text: '常用英雄', callback: '#常用英雄' }
      ]
    )
  }

  /** 英雄梯度榜 */
  static heroTier() {
    return segment.button(
      [
        { text: '对抗路', callback: '#英雄梯度对抗路' },
        { text: '中路', callback: '#英雄梯度中路' },
        { text: '打野', callback: '#英雄梯度打野' }
      ],
      [
        { text: '发育路', callback: '#英雄梯度发育路' },
        { text: '游走', callback: '#英雄梯度游走' }
      ],
      [
        { text: '查战力', input: '#查战力' },
        { text: '常用英雄', callback: '#常用英雄' }
      ]
    )
  }

  /** 皮肤墙 */
  static skinWall(id = '') {
    const s = id ? String(id) : ''
    return segment.button(
      [
        { text: '全部皮肤', callback: `#全部皮肤${s}` },
        { text: '查皮肤', input: '#查皮肤' }
      ],
      [
        { text: '王者主页', callback: `#王者主页${s}` }
      ]
    )
  }

  /** 赛季/巅峰表现 */
  static performance(id = '', type = '排位') {
    const s = id ? String(id) : ''
    const other = type === '排位' ? '巅峰' : '排位'
    return segment.button(
      [
        { text: `${other}表现`, callback: `#${other}表现${s}` },
        { text: '查询战绩', callback: `#查询战绩${s}` }
      ],
      [
        { text: '王者主页', callback: `#王者主页${s}` },
        { text: '常用英雄', callback: `#常用英雄${s}` }
      ]
    )
  }
}
