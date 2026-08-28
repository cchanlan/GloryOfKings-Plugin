/**
 * #观战 —— 查某人是不是正在对局，并把营地的**观战入口原样交给用户**。
 *
 * 思路和 R 插件处理直播一样：Bot 不负责渲染画面，只负责「查状态 + 把能打开的地址递过去」。
 * 营地的观战入口是 App scheme（`smobagamehelper://video_battle?...`，在 `gaming.watchBattleUrl`），
 * 手机上打开会拉起王者营地进观战 —— 画面由营地/游戏渲染，这是 Bot 唯一能做到的「观战」。
 *
 * 三个如实告诉用户的限制（都来自实测，别粉饰）：
 *   - scheme 不是 http，QQ 不会渲染成可点链接，要**长按复制到手机浏览器**
 *   - 只在装了王者营地 App 的手机上有效，PC 打不开
 *   - 营地自己有 `canBeWatch` 开关，实测常为 false（一般要开局几分钟后、且双方是营地好友），
 *     为 false 时链接大概率打不开，这时也照发但把话说明白
 *
 * 数据走 pushStore.fetchLatest（战绩列表接口），**一次请求同时拿到在局状态和观战地址**，
 * 顺手还把战绩归档了。「本群谁在打」用 #谁在打游戏（读推送快照，零请求），别用这条刷。
 */
import { fetchLatest, getHeroNameMap, FETCH_HIDDEN } from '../utils/pushStore.js'
import {
  getCurrentId, Button, shouldQuote, parsePerfArgs,
  AT_HEAD, stripAtText, resolveTargetUserId, resolveMemberName, pickGroupSafe
} from '#utils'

const toInt = value => {
  const num = Number(value)
  return Number.isFinite(num) ? Math.trunc(num) : 0
}

export class WatchBattle extends plugin {
  constructor () {
    super({
      name: '王者观战',
      dsc: '查谁正在对局，并给出营地观战入口',
      event: 'message',
      // 同 heroGuide / whoIsPlaying：完整锚定的短指令要抢在 queryGameStats 的宽匹配前面
      priority: 0,
      rule: [
        { reg: `${AT_HEAD}#(王者)?观战\\s*(.*)$`, fnc: 'watch' }
      ]
    })
  }

  async watch (e) {
    const { userId, hint } = await resolveTargetUserId(e)
    if (hint) return e.reply(hint, shouldQuote())

    const input = stripAtText(e.msg).replace(/^#(王者)?观战\s*/, '').trim()
    const args = parsePerfArgs(input)
    const campId = args.campId || getCurrentId(userId)

    if (!campId) {
      return e.reply([
        String(userId) === String(e.user_id)
          ? '你还没有绑定营地ID，先发送 #绑定营地 [营地ID]'
          : 'TA 还没有绑定营地ID，查不到在不在打',
        Button.bind()
      ], shouldQuote())
    }

    const who = await this.resolveName(e, userId, campId, Boolean(args.campId))

    const data = await fetchLatest(campId, String(e.user_id))

    // 「看不见」和「没在打」必须分开报，否则最容易误判的一种情况会被说成「他没在打」：
    // 营地的可见性是**按请求方账号**判的，Bot 用的是共享登录态，和目标往往不是营地好友。
    // 实测 1603403809（营地里显示「游客仅你可见」）返回 returnCode=0 但
    // `invisible: true` + `list: []` + `gaming: null` —— 人明明在打排位。
    if (data === FETCH_HIDDEN) {
      return e.reply([
        `${who}的战绩对 Bot 不可见，所以查不到在不在对局中。`,
        '营地是按「请求方账号」判可见性的：Bot 用的是共享营地账号，和 TA 不是营地好友，',
        'TA 又把资料设成了「仅好友可见」——这种情况营地会直接返回空列表，不是真的没在打。',
        '要查只能让 TA 把营地隐私改成对所有人公开。'
      ].join('\n'), shouldQuote())
    }

    if (!data) {
      return e.reply('拉取对局状态失败（可能是营地频控），稍后再试', shouldQuote())
    }

    const gaming = data.gaming
    if (!gaming?.isGaming) {
      return e.reply([
        `${who}现在没在对局里`,
        '想看本群谁在打，发送 #谁在打游戏（读的是推送快照，不额外发请求）'
      ].join('\n'), shouldQuote())
    }

    const heroMap = await getHeroNameMap()
    const heroName = heroMap[String(gaming.heroId)] || (gaming.heroId ? `英雄${gaming.heroId}` : '')
    const duration = toInt(gaming.duration)
    const gameNum = toInt(gaming.gameNum)

    const stat = []
    if (gameNum > 0) stat.push(`${gameNum} 场`)
    if (gaming.winRate) stat.push(`胜率 ${gaming.winRate}`)

    const lines = [`🎮 ${who}正在打${String(gaming.mapName || '').trim() || '对局'}`]
    if (heroName) lines.push(`${heroName}${stat.length ? `（${stat.join(' · ')}）` : ''}`)
    // title 是营地现成的文案（「开局7分钟」），比自己拼更准；没有时用 duration 兜
    if (gaming.title) lines.push(String(gaming.title))
    else if (duration > 0) lines.push(`已进行 ${duration} 分钟`)

    const url = String(gaming.watchBattleUrl || '').trim()
    if (url) {
      lines.push('', '📱 长按复制下面这行，用手机浏览器打开会拉起王者营地进观战：', url)
      if (gaming.canBeWatch === false) {
        lines.push('', '⚠️ 营地标记这局当前不可观战，链接可能打不开 —— 一般要开局几分钟后、且你和 TA 是营地好友')
      }
      if (gaming.gameTypeCanBeWatch === false) {
        lines.push('⚠️ 这个模式本身不支持观战')
      }
    } else {
      lines.push('', '营地这局没给观战入口（娱乐模式或隐私设置），只能看上面的开局信息')
    }

    const msg = [lines.join('\n')]
    if (gaming.heroIcon) msg.unshift(segment.image(gaming.heroIcon))

    await e.reply(msg, shouldQuote())
  }

  /**
   * 显示名。三种情形分开，否则会出现「你现在没在对局里」而其实查的是别人的号：
   *   - 指令里直接给了别人的营地ID（不是自己当前那个）→ 报营地ID，@ 谁都不算
   *   - 查自己 → 「你」
   *   - @ 了别人 → 群名片 / 昵称，取不到就「TA」
   */
  async resolveName (e, userId, campId, byId) {
    if (byId && String(campId) !== String(getCurrentId(e.user_id) || '')) {
      return `营地ID ${campId} `
    }
    if (String(userId) === String(e.user_id)) return '你'
    try {
      const name = await resolveMemberName(pickGroupSafe(e.group_id), userId)
      return name ? `${name} ` : 'TA '
    } catch {
      return 'TA '
    }
  }
}
