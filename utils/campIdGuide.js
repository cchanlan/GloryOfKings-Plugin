/** Unified camp-ID guidance: standalone miniapp card, then instructions; diagnostics stay in logger. */
import path from 'path'
import { PluginPath } from '#components'
import Button from './button.js'
import { sendCampMiniapp } from './campMiniappSender.js'
import { CAMP_MINIAPP_URL } from './campMiniappDiag.js'

const CAMP_ID_GUIDE_IMG = '营地ID获取.png'
export const CAMP_ID_GUIDE_HINT = '绑定方式：#绑定营地 + 营地ID（纯数字）\n示例：#绑定营地 123456'
export const CAMP_ID_SUFFIX_HINT = '未查询到营地ID：可以直接在指令后附带营地ID，也可以先绑定'
function guideText(hint) {
  return `${hint}\n\n点开「王者营地」小程序并授权登录，进入「我的 → 编辑资料」，复制「营地ID」。\n打不开时点此入口：${CAMP_MINIAPP_URL}`
}
/** Backward-compatible image/link fallback for callers outside the plugin. */
export function campIdGuidePayload(hint = CAMP_ID_GUIDE_HINT) {
  return [guideText(hint), segment.image(path.join(PluginPath, 'resources', 'img', CAMP_ID_GUIDE_IMG)), Button.bind()]
}
export async function replyCampIdGuide(e, hint = CAMP_ID_GUIDE_HINT, replyOptions) {
  const outcome = await sendCampMiniapp(e)
  try {
    const payload = outcome.fallback ? campIdGuidePayload(hint) : [guideText(hint), Button.bind()]
    const result = await e.reply(payload, replyOptions)
    const receipt = outcome.receipt(result)
    if (receipt.explicitFailure) {
      const error = new Error('guide_send_rejected')
      error.code = 'GUIDE_SEND_REJECTED'
      error.error = result
      throw error
    }
    outcome.log(receipt.messageIds.length ? 'info' : 'warn', 'guide_receipt', { receipt })
    return result
  } catch (error) {
    outcome.fail('guide_send_failed', error)
    try {
      const result = await e.reply(guideText(hint), replyOptions)
      const receipt = outcome.receipt(result)
      outcome.log(receipt.explicitFailure || !receipt.messageIds.length ? 'warn' : 'info', 'guide_text_fallback', { receipt })
      if (receipt.explicitFailure) return false
      return result
    } catch (fallbackError) {
      outcome.fail('guide_text_fallback_failed', fallbackError)
      return false
    }
  } finally {
    outcome.log('info', 'flow_end', { cardReceiptConfirmed: outcome.confirmed, serverVerification: outcome.serverVerification, usedImageFallback: outcome.fallback })
  }
}
