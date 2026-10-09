/**
 * 营地签到的纯逻辑：周图下标、错误码分流、奖励拼串、角色挑选。
 *
 * 这些判据全部来自 2026-10-10 的真机实测，逐条钉住是为了防「看着像笔误就改掉」：
 *   · `weekSignMap` 是**周一=0**，而 `Date.getDay()` 是周日=0（差一天！）
 *   · `-105204` 是**缺 roleId**，文案却在说「未授权营地」
 *   · `-105203` 是**正常结果**（已签过），不是失败
 *   · `gameId` 要按**字符串**比
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isSignedToday, weekRemain, describeWeekMap,
  pickMainRole, describeGifts, classifySignCode,
  indexWeekGifts, buildSignView, buildSignText
} from '../utils/campSign.js'

/* ------------------------------------------------ isSignedToday：下标必须周一=0 */

test('周图下标：周六（2026-10-10）读的是第 6 位', () => {
  // 实测：主人号当天已签，weekSignMap = '0000010'
  const saturday = new Date('2026-10-10T12:00:00+08:00')
  assert.equal(saturday.getDay(), 6, '前提：这一天是周六')
  assert.equal(isSignedToday('0000010', saturday), true)
})

test('周图下标：周日读最后一位，不是第一位（getDay()=0 的经典错位）', () => {
  // 2026-10-11 是周日。图里只有最后一位是 1（周日签的）
  const sunday = new Date('2026-10-11T12:00:00+08:00')
  assert.equal(sunday.getDay(), 0, '前提：这一天是周日')
  assert.equal(isSignedToday('0000001', sunday), true)
  // 反过来也得对：周日那天，第一位（周一）的 1 不该被当成「今天已签」
  assert.equal(isSignedToday('1000000', sunday), false)
})

test('周图下标：周一读第一位', () => {
  const monday = new Date('2026-10-05T12:00:00+08:00')
  assert.equal(monday.getDay(), 1, '前提：这一天是周一')
  assert.equal(isSignedToday('1000000', monday), true)
  assert.equal(isSignedToday('0100000', monday), false)
})

test('周图全 0 = 本周一天都没签', () => {
  const saturday = new Date('2026-10-10T12:00:00+08:00')
  assert.equal(isSignedToday('0000000', saturday), false)
})

test('周图全 1 = 每天都能判成已签', () => {
  for (let day = 5; day <= 11; day++) {
    const d = new Date(2026, 9, day, 12)
    assert.equal(isSignedToday('1111111', d), true, `${d.toDateString()} 应为已签`)
  }
})

test('周图不合法时返回 null（不知道），不能当 false', () => {
  const now = new Date('2026-10-10T12:00:00+08:00')
  assert.equal(isSignedToday('', now), null)
  assert.equal(isSignedToday('0000', now), null)
  assert.equal(isSignedToday('00000100', now), null)
  assert.equal(isSignedToday(undefined, now), null)
  assert.equal(isSignedToday(null, now), null)
  // 该位不是 0/1（服务端换了表示法）也算判不了
  assert.equal(isSignedToday('00000x0', now), null)
})

/* ----------------------------------------------------------- weekRemain / 可读化 */

test('weekRemain 数的是「还没签的天数」', () => {
  assert.equal(weekRemain('0000000'), 7)
  assert.equal(weekRemain('1111111'), 0)
  assert.equal(weekRemain('0000010'), 6)
  assert.equal(weekRemain('1000001'), 5)
})

test('weekRemain 对不合法的图返回 null —— 0 表示满签，不能跟「判不了」混', () => {
  assert.equal(weekRemain(''), null)
  assert.equal(weekRemain('0000'), null)
  assert.equal(weekRemain(undefined), null)
})

test('describeWeekMap 把图转成周几列表', () => {
  assert.equal(describeWeekMap('0000010'), '周六')
  assert.equal(describeWeekMap('1000001'), '周一、周日')
  assert.equal(describeWeekMap('0000000'), '本周还没签过')
  assert.equal(describeWeekMap('bad'), '')
})

/* ------------------------------------------------------------------ pickMainRole */

const ROLE_LIST = {
  userId: '1580886057',
  gameList: [
    { gameId: 30006, roles: [] },
    { gameId: 30005, roles: [{ roleId: '999', roleName: '别的游戏' }] },
    {
      gameId: 20001,
      roles: [
        { roleId: '1185348788', roleName: '我就只会补兵', areaId: 3, serverId: 3048 },
        { roleId: '4228635137', roleName: '第二个角色', areaId: 3, serverId: 3048 }
      ]
    }
  ]
}

test('pickMainRole 认 gameId=20001 的王者角色', () => {
  const role = pickMainRole(ROLE_LIST)
  assert.equal(role.roleId, '1185348788')
  assert.equal(role.roleName, '我就只会补兵')
})

test('pickMainRole 多角色只取第一个（奖励发在账号上，签多个只会撞频控）', () => {
  assert.equal(pickMainRole(ROLE_LIST).roleId, '1185348788')
})

test('pickMainRole 必须按字符串比 gameId —— 接口给数字，别写成 === 20001', () => {
  // 数字 20001 能认（这是接口的真实形态）
  assert.ok(pickMainRole({ gameList: [{ gameId: 20001, roles: [{ roleId: '1' }] }] }))
  // 字符串 '20001' 也要能认（营地偶尔换类型）
  assert.ok(pickMainRole({ gameList: [{ gameId: '20001', roles: [{ roleId: '1' }] }] }))
})

test('pickMainRole 没有王者角色时返回 null（不是抛错、也不是空对象）', () => {
  assert.equal(pickMainRole({ gameList: [{ gameId: 30006, roles: [{ roleId: '1' }] }] }), null)
  assert.equal(pickMainRole({ gameList: [{ gameId: 20001, roles: [] }] }), null)
  assert.equal(pickMainRole({ gameList: [] }), null)
  assert.equal(pickMainRole({}), null)
  assert.equal(pickMainRole(null), null)
})

/* ------------------------------------------------------------------ describeGifts */

test('describeGifts 拼今日奖励，数量为 1 不显示 x1', () => {
  // 实测的签到成功返回（2026-10-10，号 1536597962）
  const data = {
    giftList: [
      { giftText: '东皇太一-东海龙王(1天)', giftIcon: 'dhtydhlw.png', giftNum: '1' },
      { giftText: '营地币', giftIcon: 'currency.png', giftNum: '25' }
    ]
  }
  assert.equal(describeGifts(data), '东皇太一-东海龙王(1天) + 营地币x25')
})

test('describeGifts 空 / 缺字段时返回空串，不返回 "undefined"', () => {
  assert.equal(describeGifts({}), '')
  assert.equal(describeGifts({ giftList: [] }), '')
  assert.equal(describeGifts(null), '')
  assert.equal(describeGifts({ giftList: [{ giftNum: '5' }] }), '', '没名字的条目要丢掉')
})

/* ---------------------------------------------------------------- classifySignCode */

test('classifySignCode 把四个实测错误码分流清楚', () => {
  assert.equal(classifySignCode(0), 'ok')
  assert.equal(classifySignCode(-105203), 'already', '-105203 是「已签过」，不是失败')
  assert.equal(classifySignCode(-105206), 'too-fast')
  assert.equal(classifySignCode(-105204), 'missing-role', '-105204 的真实原因是缺 roleId')
})

test('classifySignCode 认字符串形式的码（JSON 里偶尔是字符串）', () => {
  assert.equal(classifySignCode('0'), 'ok')
  assert.equal(classifySignCode('-105203'), 'already')
})

test('classifySignCode 其它码一律 error，不误判成成功', () => {
  assert.equal(classifySignCode(-30003), 'error')
  assert.equal(classifySignCode(-1), 'error')
  assert.equal(classifySignCode(undefined), 'error')
  assert.equal(classifySignCode(null), 'error')
  assert.equal(classifySignCode(NaN), 'error')
})

test('classifySignCode：缺 returnCode 不能当成功（Number(null)===0 的经典坑）', () => {
  // 单测当场抓到的真 bug：早先直接 Number(code)，于是 `Number(null)` / `Number('')`
  // 都等于 0 → 「响应里压根没有 returnCode」会被报成签到成功，还附一个空的奖励行。
  assert.notEqual(classifySignCode(null), 'ok')
  assert.notEqual(classifySignCode(undefined), 'ok')
  assert.notEqual(classifySignCode(''), 'ok')
  assert.notEqual(classifySignCode({}), 'ok')
  assert.notEqual(classifySignCode([]), 'ok')
})

/* ============================================================ 出图装配 */

/** 造一份贴近实测的 signinfo（2026-10-10 主人号的真实形状） */
function makeInfo (over = {}) {
  return {
    weekSignMap: '0000010',
    seqSignDays: 1,
    userTotalSign: 1,
    canExtraSign: 7,
    weekList: [
      { date: 1, gift: [{ name: '铭文碎片', packageNum: 10, iconUrl: 'a.png', desc: '用于购买/升级铭文' }] },
      { date: 2, gift: [{ name: '亲密玫瑰', packageNum: 1, iconUrl: 'b.png', desc: '增加5点亲密度' }] },
      { date: 3, gift: [{ name: '钻石', packageNum: 10, iconUrl: 'c.png', desc: '游戏内购买英雄' }] },
      { date: 4, gift: [{ name: '双倍金币卡1日', packageNum: 1, iconUrl: 'd.png', desc: '金币+100%' }] },
      { date: 5, gift: [{ name: '杨玉环-霓裳曲(1天)', packageNum: 1, iconUrl: 'e.png', desc: '体验卡*1' }] },
      { date: 6, gift: [{ name: '东皇太一-东海龙王(1天)', packageNum: 1, iconUrl: 'f.png', desc: '体验卡*1' }] },
      { date: 7, gift: [{ name: '英雄碎片', packageNum: 1, iconUrl: 'g.png', desc: '兑换英雄' }] }
    ],
    totalList: [
      { date: 7, gift: [{ name: '7日累计签到礼包', packageNum: 1, iconUrl: 'h.png', desc: '含体验卡' }] },
      { date: 14, gift: [{ name: '14日累计签到礼包', packageNum: 1, iconUrl: 'i.png', desc: '含英雄' }] }
    ],
    ...over
  }
}

const SATURDAY = new Date('2026-10-10T12:00:00+08:00')

test('indexWeekGifts 按 date（1~7）建索引，不是按数组下标', () => {
  // 故意打乱顺序：下标 0 是周三
  const info = {
    weekList: [
      { date: 3, gift: [{ name: '周三礼' }] },
      { date: 1, gift: [{ name: '周一礼' }] }
    ]
  }
  const map = indexWeekGifts(info)
  assert.equal(map.get(1)[0].name, '周一礼')
  assert.equal(map.get(3)[0].name, '周三礼')
  assert.equal(map.get(2), undefined)
})

test('indexWeekGifts 丢掉 date 越界的条目（而不是硬塞进某个格子）', () => {
  const map = indexWeekGifts({ weekList: [{ date: 0, gift: [] }, { date: 8, gift: [] }, { date: 5, gift: [] }] })
  assert.equal(map.size, 1)
  assert.ok(map.has(5))
})

test('buildSignView：7 个格子齐、只有已签的打勾、今天带角标', () => {
  const view = buildSignView({
    views: [{ name: 'C', campId: '1580886057', stateClass: 'done', stateText: '今天已签', info: makeInfo() }],
    mode: 'sign', now: SATURDAY
  })

  const days = view.accounts[0].days
  assert.equal(days.length, 7, '一周 7 格')
  // 周六（下标 5）已签
  assert.equal(days[5].mark, '✓')
  assert.ok(days[5].cls.includes('done'))
  assert.equal(days[5].tag, '今天')
  // 其它格子没打勾
  assert.equal(days[0].mark, '·')
  assert.ok(!days[0].cls.includes('done'))
})

test('buildSignView：未来的格子标 future（还没到的日子不该显示成「漏签」）', () => {
  const view = buildSignView({
    views: [{ name: 'C', campId: '1', stateClass: 'done', stateText: '今天已签', info: makeInfo() }],
    mode: 'sign', now: SATURDAY
  })
  const days = view.accounts[0].days
  assert.ok(days[6].cls.includes('future'), '周日是未来')
  assert.ok(!days[0].cls.includes('future'), '周一是过去')
})

test('buildSignView：weekSignMap 不合法时不打任何勾（不能瞎标已签）', () => {
  const view = buildSignView({
    views: [{ name: 'C', campId: '1', stateClass: 'fail', stateText: '数据异常', info: makeInfo({ weekSignMap: 'bad' }) }],
    mode: 'sign', now: SATURDAY
  })
  assert.equal(view.accounts[0].days.filter(d => d.mark === '✓').length, 0)
})

test('buildSignView：今天未签的格子用虚线描边 class', () => {
  const view = buildSignView({
    views: [{ name: 'C', campId: '1', stateClass: 'new', stateText: '今天还没签', info: makeInfo({ weekSignMap: '0000000' }) }],
    mode: 'status', now: SATURDAY
  })
  assert.ok(view.accounts[0].days[5].cls.includes('today-pending'))
})

test('buildSignView：奖励格显示当天礼物名，去掉括号天数防断行', () => {
  const view = buildSignView({
    views: [{ name: 'C', campId: '1', stateClass: 'done', stateText: '今天已签', info: makeInfo() }],
    mode: 'sign', now: SATURDAY
  })
  const days = view.accounts[0].days
  assert.equal(days[0].gift, '铭文碎片')
  // ⚠️ 括号里的天数要去掉：格子窄，「东皇太一-东海龙王(1天)」会在「(1 / 天)」
  //    中间断行，看着像乱码。去掉后恰好一行放得下
  assert.equal(days[5].gift, '东皇太一-东海龙王')
  // 超长的一定被截断并带省略号
  const long = buildSignView({
    views: [{
      name: 'C', campId: '1', stateClass: 'done', stateText: '今天已签',
      info: makeInfo({
        weekList: [{ date: 1, gift: [{ name: '这是一个特别特别特别特别特别特别长的奖励名字测试截断' }] }]
      })
    }],
    mode: 'sign', now: SATURDAY
  })
  assert.ok(long.accounts[0].days[0].gift.endsWith('…'), `实际=${long.accounts[0].days[0].gift}`)
  assert.ok(long.accounts[0].days[0].gift.length <= 22)
})

test('buildSignView：奖励 desc 里的 ## 只取前一段（营地自带的简写分隔符）', () => {
  // 实测原文：「墨子-金属风暴3天体验卡*1##打开必得墨子-金属风暴3天体验卡*1」
  const view = buildSignView({
    views: [{
      name: 'C', campId: '1', stateClass: 'done', stateText: '今天已签',
      info: makeInfo(),
      signGifts: [{
        giftText: '7日累计签到礼包', giftNum: '1',
        giftDesc: '墨子-金属风暴3天体验卡*1##打开必得墨子-金属风暴3天体验卡*1'
      }]
    }],
    mode: 'sign', now: SATURDAY
  })
  assert.equal(view.accounts[0].gifts[0].desc, '墨子-金属风暴3天体验卡*1')
  assert.ok(!view.accounts[0].gifts[0].desc.includes('##'))
})

test('buildSignView：累计档位按 userTotalSign 算进度与「还差几天」', () => {
  const view = buildSignView({
    views: [{ name: 'C', campId: '1', stateClass: 'done', stateText: '今天已签', info: makeInfo() }],
    mode: 'sign', now: SATURDAY
  })
  const totals = view.accounts[0].totals
  assert.equal(totals.length, 2)
  // 累计 1 天，7 天档还差 6 天
  assert.equal(totals[0].days, 7)
  assert.equal(totals[0].statusText, '还差 6 天')
  assert.equal(totals[0].statusClass, 'no')
  assert.equal(totals[0].percent, Math.round(1 / 7 * 100))
  // 14 天档
  assert.equal(totals[1].days, 14)
  assert.equal(totals[1].statusText, '还差 13 天')
})

test('buildSignView：累计够了就标已达成', () => {
  const view = buildSignView({
    views: [{ name: 'C', campId: '1', stateClass: 'done', stateText: '今天已签', info: makeInfo({ userTotalSign: 20 }) }],
    mode: 'sign', now: SATURDAY
  })
  const totals = view.accounts[0].totals
  assert.equal(totals[0].statusClass, 'ok')
  assert.equal(totals[0].statusText, '已达成')
  assert.equal(totals[0].cls, 'reached')
  assert.equal(totals[0].percent, 100, '进度条封顶 100，不溢出')
})

test('buildSignView：真签成功时带出 newsignin 的 giftList（另一套字段名）', () => {
  const view = buildSignView({
    views: [{
      name: 'C', campId: '1', stateClass: 'new', stateText: '签到成功',
      info: makeInfo(),
      // ⚠️ 这是 newsignin 的形状：giftText / giftNum（字符串），跟 weekList 的
      //    name / packageNum（数字）不是一套
      signGifts: [
        { giftText: '东皇太一-东海龙王(1天)', giftNum: '1', giftIconUrl: 'x.jpg', giftDesc: '体验卡*1' },
        { giftText: '营地币', giftNum: '25', giftIconUrl: 'y.png', giftDesc: '抽奖兑换' }
      ]
    }],
    mode: 'sign', okCount: 1, now: SATURDAY
  })
  const gifts = view.accounts[0].gifts
  assert.equal(gifts.length, 2)
  // 奖励明细行里**保留**括号天数（那里位置够宽，写全更清楚）——
  // 只有周格子那种窄地方才去掉，两处口径不同是故意的
  assert.equal(gifts[0].name, '东皇太一-东海龙王(1天)')
  assert.equal(gifts[0].num, '1')
  assert.equal(gifts[1].name, '营地币')
  assert.equal(gifts[1].num, '25')
  assert.equal(view.giftCount, 2)
  assert.equal(view.giftKey, '今日奖励')
})

test('buildSignView：没签成功任何号时，第四格显示「本周还差」而不是一个大 0', () => {
  // 已签的号必然没有 signGifts，显示「今日奖励 0」看着像出错了
  const view = buildSignView({
    views: [{ name: 'A', campId: '1', stateClass: 'done', stateText: '今天已签', info: makeInfo() }],
    mode: 'sign', now: SATURDAY, alreadyCount: 1
  })
  assert.equal(view.giftKey, '本周还差')
  // weekSignMap='0000010' → 还差 6 天
  assert.equal(view.giftCount, 6)
})

test('buildSignView：多个号取「还差最少」的那个（最乐观口径）', () => {
  const view = buildSignView({
    views: [
      { name: 'A', campId: '1', stateClass: 'done', stateText: '今天已签', info: makeInfo({ weekSignMap: '0000000' }) },
      { name: 'B', campId: '2', stateClass: 'done', stateText: '今天已签', info: makeInfo({ weekSignMap: '1111110' }) }
    ],
    mode: 'status', now: SATURDAY
  })
  assert.equal(view.giftCount, 1, 'B 只差 1 天，取最小值')
})

test('buildSignView：拿不到周图的号 hasWeek=false（不画那排空格子）', () => {
  const view = buildSignView({
    views: [
      { name: 'A', campId: '1', stateClass: 'fail', stateText: '查询失败', failReason: '登录态失效' },
      { name: 'B', campId: '2', stateClass: 'done', stateText: '今天已签', info: makeInfo() }
    ],
    mode: 'sign', now: SATURDAY
  })
  assert.equal(view.accounts[0].hasWeek, false, '失败号不画格子')
  assert.equal(view.accounts[0].note, '登录态失效', '失败原因要能显示')
  assert.equal(view.accounts[1].hasWeek, true)
  // 全部号都没有周图时第四格兜底成 '—'，不是 0
  const allFail = buildSignView({
    views: [{ name: 'A', campId: '1', stateClass: 'fail', stateText: '查询失败', failReason: 'x' }],
    mode: 'sign', now: SATURDAY
  })
  assert.equal(allFail.giftCount, '—')
})

test('buildSignView：头部四格取各号的极值，不是最后一个号的值', () => {
  const view = buildSignView({
    views: [
      { name: 'A', campId: '1', stateClass: 'done', stateText: '今天已签', info: makeInfo({ seqSignDays: 3, userTotalSign: 9 }) },
      { name: 'B', campId: '2', stateClass: 'new', stateText: '今天还没签', info: makeInfo({ seqSignDays: 12, userTotalSign: 30 }) }
    ],
    mode: 'status', now: SATURDAY
  })
  assert.equal(view.maxSeq, 12, '最长连续取最大值')
  assert.equal(view.totalSign, 30)
  assert.equal(view.accountCount, 2)
})

test('buildSignView：一个号都没有时走 emptyText，四格不炸', () => {
  const view = buildSignView({ views: [], mode: 'sign', now: SATURDAY })
  assert.equal(view.accounts.length, 0)
  assert.ok(view.emptyText)
  assert.equal(view.maxSeq, 0, 'Math.max(...[]) 是 -Infinity，必须兜住')
  assert.equal(view.totalSign, 0)
  assert.equal(view.todayVal, '—')
})

test('buildSignView：状态模式不显示「签上 N 个」这种动作口径', () => {
  const view = buildSignView({
    views: [{ name: 'A', campId: '1', stateClass: 'done', stateText: '今天已签', info: makeInfo() }],
    mode: 'status', now: SATURDAY
  })
  assert.equal(view.title, '签到状态')
  assert.equal(view.subText, '只看不签')
})

test('buildSignView：文字兜底包含每个号的状态与奖励（图挂了也不能丢信息）', () => {
  const view = buildSignView({
    views: [
      { name: 'A', campId: '1', stateClass: 'new', stateText: '签到成功', info: makeInfo(),
        signGifts: [{ giftText: '营地币', giftNum: '25' }] },
      { name: 'B', campId: '2', stateClass: 'fail', stateText: '查询失败', failReason: '登录态失效' }
    ],
    mode: 'sign', okCount: 1, failCount: 1, now: SATURDAY
  })
  const text = view.textFallback
  assert.ok(text.includes('A（1）'), '要带账号名和ID')
  assert.ok(text.includes('连续 1 天'))
  assert.ok(text.includes('营地币x25'), '数量不是 1 要带 xN')
  assert.ok(text.includes('B（2）'))
  assert.ok(text.includes('登录态失效'), '失败原因要原样带出来')
  assert.ok(text.includes('1 个签到成功'))
  assert.ok(text.includes('1 个失败'))
})

test('buildSignText：单独调用也能用（数字段缺省时不写 undefined）', () => {
  const text = buildSignText({
    views: [{ name: 'A', campId: '1', stateClass: 'fail', stateText: '查询失败', failReason: '超时' }],
    mode: 'status', now: SATURDAY
  })
  assert.ok(text.includes('查询失败：超时'))
  assert.ok(!text.includes('undefined'))
  assert.ok(!text.includes('未定义'))
})
/**
 * 追加测试：`noRoleCount` 与 `failCount` 必须分开表述。
 *
 * 来源：2026-10-10 真机端到端 —— 主人名下 5 个营地号里 3 个没绑王者角色，
 * 副标题报了「3 个没签上」，看着像插件坏了。
 */

const NOROLE_SAT = new Date('2026-10-10T12:00:00+08:00')

function noroleInfo (over = {}) {
  return { weekSignMap: '0000010', seqSignDays: 1, userTotalSign: 1, weekList: [], totalList: [], ...over }
}

test('副标题：没人绑角色的号不该算成「没签上」', () => {
  // 真机场景：5 个号，2 个签过、3 个没王者角色
  const view = buildSignView({
    views: [
      { name: 'C', campId: '1', stateClass: 'done', stateText: '今天已签', info: noroleInfo() },
      { name: 'B', campId: '2', stateClass: 'done', stateText: '今天已签', info: noroleInfo() },
      { name: 'X', campId: '3', stateClass: 'fail', stateText: '没有王者角色', failReason: '还没绑定王者角色' }
    ],
    mode: 'sign', alreadyCount: 2, failCount: 0, noRoleCount: 3, now: NOROLE_SAT
  })
  assert.equal(view.subText, '今天都已签过', '有已签且零失败时，说「今天都已签过」')
  assert.ok(!view.subText.includes('没签上'), '绝不能出现「没签上」')
})

test('副标题：全是没角色的号时说「能签的号都签过了」', () => {
  const view = buildSignView({
    views: [{ name: 'X', campId: '3', stateClass: 'fail', stateText: '没有王者角色', failReason: '没绑' }],
    mode: 'sign', alreadyCount: 0, failCount: 0, noRoleCount: 1, now: NOROLE_SAT
  })
  assert.equal(view.subText, '能签的号都签过了')
})

test('副标题：真有失败时才说「N 个没签上」', () => {
  const view = buildSignView({
    views: [
      { name: 'A', campId: '1', stateClass: 'fail', stateText: '签到失败', failReason: '网络超时' },
      { name: 'X', campId: '3', stateClass: 'fail', stateText: '没有王者角色', failReason: '没绑' }
    ],
    mode: 'sign', failCount: 1, noRoleCount: 1, now: NOROLE_SAT
  })
  assert.equal(view.subText, '1 个没签上', '只数真失败的那个，不含没角色的')
})

test('副标题：签成功优先说「签上 N 个」', () => {
  const view = buildSignView({
    views: [{ name: 'A', campId: '1', stateClass: 'new', stateText: '签到成功', info: noroleInfo() }],
    mode: 'sign', okCount: 1, noRoleCount: 2, now: NOROLE_SAT
  })
  assert.equal(view.subText, '签上 1 个')
})

test('副标题：状态模式永远是「只看不签」，不受计数影响', () => {
  const view = buildSignView({
    views: [{ name: 'A', campId: '1', stateClass: 'done', stateText: '今天已签', info: noroleInfo() }],
    mode: 'status', okCount: 9, failCount: 9, noRoleCount: 9, now: NOROLE_SAT
  })
  assert.equal(view.subText, '只看不签')
})

test('文字兜底：没角色的号单独成句，不混进「失败」', () => {
  const view = buildSignView({
    views: [
      { name: 'C', campId: '1', stateClass: 'done', stateText: '今天已签', info: noroleInfo() },
      { name: 'X', campId: '3', stateClass: 'fail', stateText: '没有王者角色', failReason: '还没绑定王者角色' }
    ],
    mode: 'sign', alreadyCount: 1, failCount: 0, noRoleCount: 1, now: NOROLE_SAT
  })
  const t = view.textFallback
  assert.ok(t.includes('1 个没绑王者角色'), `实际=${t}`)
  assert.ok(!t.includes('1 个失败'), '没角色不该被说成失败')
})

test('文字兜底：buildSignText 直接调用也支持 noRoleCount', () => {
  const t = buildSignText({
    views: [{ name: 'X', campId: '3', stateClass: 'fail', stateText: '没有王者角色', failReason: '没绑' }],
    mode: 'sign', noRoleCount: 2, now: NOROLE_SAT
  })
  assert.ok(t.includes('2 个没绑王者角色'))
})

test('不传 noRoleCount 时行为不变（向后兼容，老调用方不会炸）', () => {
  const view = buildSignView({
    views: [{ name: 'A', campId: '1', stateClass: 'fail', stateText: '签到失败', failReason: 'x' }],
    mode: 'sign', failCount: 1, now: NOROLE_SAT
  })
  assert.equal(view.subText, '1 个没签上')
})
