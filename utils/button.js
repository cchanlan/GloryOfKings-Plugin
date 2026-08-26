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
        { text: '查询战绩', callback: '#查询战绩' },
        { text: '王者对比', input: '#王者对比 ' }
      ],
      [
        { text: '查英雄战绩', input: '#查战绩' },
        { text: '常用英雄', callback: '#常用英雄' },
        { text: '称号墙', callback: '#称号墙' }
      ],
      [
        { text: '英雄梯度', callback: '#英雄梯度' },
        { text: '查战力', input: '#查战力' },
        { text: '皮肤墙', callback: '#皮肤墙' },
        { text: '缺皮肤', callback: '#缺皮肤' }
      ],
      [
        { text: '排位排名', callback: '#排位排名' },
        { text: '巅峰排名', callback: '#巅峰排名' },
        { text: '巅峰趋势', callback: '#巅峰趋势' }
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
      ],
      [
        { text: '排位排名', callback: '#排位排名' },
        { text: '巅峰排名', callback: '#巅峰排名' }
      ]
    )
  }

  /**
   * 战绩列表
   * 带营地ID时走 `#查询<ID><模式>战绩<序号>` 这一路（reg 里 \d+ 捕获组，>9999 视为直接传ID）；
   * 不带ID时模式独立成指令 `#排位战绩<序号>`，无模式则是 `#查询战绩<序号>`。
   * @param {string|number} id 营地ID，可为空
   * @param {number} count 本次返回的场次数，用于生成「第N场」按钮
   * @param {string} mode 当前模式（排位/巅峰），空表示全部
   */
  static gameStats(id = '', count = 0, mode = '') {
    const s = id ? String(id) : ''
    const cmd = (m = '', n = '') => {
      if (s) return `#查询${s}${m}战绩${n}`
      return m ? `#${m}战绩${n}` : `#查询战绩${n}`
    }
    const rows = []

    // 单场详情：必须带上当前模式，否则序号会对应到未筛选的列表
    const detail = []
    for (let i = 1; i <= Math.min(3, count); i++) {
      detail.push({ text: `第${i}场`, callback: cmd(mode, i) })
    }
    if (detail.length) rows.push(detail)

    // 模式切换：只列出当前模式之外的选项
    const others = ['排位', '巅峰'].filter(m => m !== mode)
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
    const back = s ? `#查询${s}${mode}战绩` : (mode ? `#${mode}战绩` : '#查询战绩')
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
   * 英雄战绩列表
   * @param {string} heroName 英雄名
   * @param {string|number} id 营地ID
   */
  static heroStats(heroName = '', id = '') {
    const s = id ? String(id) : ''
    const rows = []
    if (heroName) {
      rows.push([
        { text: `${heroName}战力`, callback: `#查战力${heroName}` },
        { text: `${heroName}皮肤`, callback: `#查皮肤${heroName}` }
      ])
    }
    rows.push([
      { text: '全部战绩', callback: `#查询战绩${s}` },
      { text: '常用英雄', callback: `#常用英雄${s}` }
    ])
    return segment.button(...rows)
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

  /**
   * 双人对比
   * @param {string|number} left 左边的营地ID
   * @param {string|number} right 右边的营地ID
   */
  static compare(left = '', right = '') {
    const rows = []
    if (left && right) {
      rows.push([
        { text: '看左边主页', callback: `#王者主页${left}` },
        { text: '看右边主页', callback: `#王者主页${right}` }
      ])
    }
    rows.push([
      { text: '换个人比', input: '#王者对比 ' },
      { text: '排位排名', callback: '#排位排名' }
    ])
    return segment.button(...rows)
  }

  /**
   * 荣耀称号墙
   * @param {string|number} id 营地ID
   */
  static medalWall(id = '') {
    const s = id ? String(id) : ''
    return segment.button(
      [
        { text: '多扫几个', input: '#称号墙 25' },
        { text: '我的英雄', callback: `#我的英雄${s}` }
      ],
      [
        { text: '查战力', input: '#查战力' },
        { text: '王者主页', callback: `#王者主页${s}` }
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
        { text: '缺哪些皮肤', callback: `#缺皮肤${s}` },
        { text: '王者主页', callback: `#王者主页${s}` }
      ]
    )
  }

  /**
   * 皮肤缺失反查
   * @param {string} heroName 当前查的英雄名，有则给个「看该英雄皮肤图鉴」的直达
   * @param {string|number} id 营地ID
   */
  static skinMissing(heroName = '', id = '') {
    const s = id ? String(id) : ''
    const rows = []
    if (heroName) {
      rows.push([
        { text: `${heroName}皮肤图`, callback: `#查皮肤${heroName}` },
        { text: '换个英雄', input: '#缺皮肤' }
      ])
    } else {
      rows.push([
        { text: '看某个英雄', input: '#缺皮肤' },
        { text: '皮肤墙', callback: `#皮肤墙${s}` }
      ])
    }
    rows.push([
      { text: '全部皮肤', callback: `#全部皮肤${s}` },
      { text: '王者主页', callback: `#王者主页${s}` }
    ])
    return segment.button(...rows)
  }

  /**
   * 巅峰分趋势
   * @param {string|number} id 营地ID
   */
  static trend (id = '') {
    const s = id ? String(id) : ''
    return segment.button(
      [
        // 指令后跟天数，最多 35 天（归档保留上限）
        { text: '看近 7 天', callback: `#巅峰趋势7${s ? ` ${s}` : ''}` },
        { text: '看近 30 天', callback: `#巅峰趋势30${s ? ` ${s}` : ''}` }
      ],
      [
        { text: '巅峰表现', callback: `#巅峰表现${s}` },
        { text: '巅峰战绩', callback: s ? `#查询${s}巅峰战绩` : '#巅峰战绩' }
      ],
      [
        { text: '王者主页', callback: `#王者主页${s}` },
        { text: '巅峰排名', callback: '#巅峰排名' }
      ]
    )
  }

  /**
   * 排行榜
   * @param {'rank'|'peak'} type 当前榜单类型
   * @param {boolean} isGlobal 当前是否为总排名，用于给出反向的范围切换入口
   */
  static rank(type = 'rank', isGlobal = false) {
    const self = type === 'peak' ? '巅峰' : '排位'
    const other = type === 'peak' ? '排位' : '巅峰'
    // 当前榜的指令前缀，刷新按钮要带上同样的范围，否则会跳到另一个范围的榜
    const scope = isGlobal ? '总排名' : '排名'
    return segment.button(
      [
        { text: `${other}${scope}`, callback: `#${other}${scope}` },
        // 已经在总榜就给回本群榜的入口，反之给总榜入口
        isGlobal
          ? { text: `${self}排名`, callback: `#${self}排名` }
          : { text: `${self}总排名`, callback: `#${self}总排名` }
      ],
      [
        { text: '刷新榜单', callback: `#${self}${scope}刷新` },
        { text: '王者主页', callback: '#王者主页' }
      ]
    )
  }

  /**
   * 战绩推送
   * @param {boolean} enabled 当前是否已订阅战绩推送，决定给「开启」还是「关闭」按钮
   */
  static push(enabled = false) {
    return segment.button(
      [
        enabled
          ? { text: '关闭推送', callback: '#关闭战绩推送' }
          : { text: '开启推送', callback: '#开启战绩推送' },
        { text: '推送状态', callback: '#战绩推送状态' }
      ],
      [
        { text: '上下线提醒', callback: '#开启上下线提醒' },
        { text: '查询战绩', callback: '#查询战绩' }
      ]
    )
  }

  /**
   * 在线状态（#谁在打游戏）。
   * 不复用 push()：那个按当前订阅状态给「开启/关闭推送」，而这条指令是给全群看的，
   * 谁点都可能，不该给一个「关闭推送」的按钮在那儿等着误触
   */
  static online() {
    return segment.button(
      [
        { text: '刷新', callback: '#谁在打游戏' },
        { text: '上下线提醒', callback: '#开启上下线提醒' }
      ],
      [
        { text: '推送状态', callback: '#战绩推送状态' },
        { text: '排位排名', callback: '#排位排名' }
      ]
    )
  }

  /**
   * 赛季/巅峰表现
   * @param {string|number} id 营地ID，带上后按钮直接查该ID
   * @param {string} type 当前看的是排位还是巅峰
   * @param {number|string} [prevSeason] 上一个赛季号，用于给出「S43表现」这类历史赛季入口
   */
  static performance(id = '', type = '排位', prevSeason = '') {
    const s = id ? String(id) : ''
    const other = type === '排位' ? '巅峰' : '排位'
    const rows = [
      [
        { text: `${other}表现`, callback: `#${other}表现${s}` },
        { text: '查询战绩', callback: `#查询战绩${s}` }
      ],
      [
        { text: '王者主页', callback: `#王者主页${s}` },
        { text: '常用英雄', callback: `#常用英雄${s}` }
      ],
      [
        // 当前看的是哪种表现，就给哪种榜单的入口
        { text: `${type}排名`, callback: `#${type}排名` },
        { text: `全部${type}表现`, callback: `#全部${type}表现${s}` }
      ]
    ]
    // 巅峰分有本地存档可以画趋势，排位没有（星数趋势已经画在排位表现图里了）
    if (type === '巅峰') {
      rows[2].push({ text: '巅峰趋势', callback: `#巅峰趋势${s ? ` ${s}` : ''}` })
    }
    // 指令支持 #排位表现s40 指定赛季，这里给个直达上一赛季的入口
    if (prevSeason) {
      rows.push([
        { text: `S${prevSeason}${type}表现`, callback: `#${type}表现${s}s${prevSeason}` },
        { text: '指定赛季', input: `#${type}表现s` }
      ])
    }
    return segment.button(...rows)
  }

  /**
   * 全部赛季表现
   * @param {string|number} id 营地ID
   * @param {string} type 排位 / 巅峰
   */
  static allPerformance(id = '', type = '排位') {
    const s = id ? String(id) : ''
    const other = type === '排位' ? '巅峰' : '排位'
    return segment.button(
      [
        { text: `全部${other}表现`, callback: `#全部${other}表现${s}` },
        { text: `${type}表现`, callback: `#${type}表现${s}` }
      ],
      [
        // 指令后可跟数量或 all，控制展示多少个赛季
        { text: '全部赛季', callback: `#全部${type}表现${s} all` },
        { text: '指定数量', input: `#全部${type}表现${s} ` }
      ],
      [
        { text: '王者主页', callback: `#王者主页${s}` },
        { text: '查询战绩', callback: `#查询战绩${s}` }
      ]
    )
  }
}
