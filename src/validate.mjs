/**
 * 入参校验。QQ 号和营地ID 在格式上没法区分，都是 5~12 位纯数字，所以共用一个判定。
 * 上限 12 位是留了余量：QQ 目前最长 11 位，营地ID 实际 8~10 位。
 */

const ID_PATTERN = /^\d{5,12}$/

/** 一个 QQ 最多允许共享多少个营地ID。正常用户绑 1~3 个，20 是防滥用的天花板 */
export const MAX_CAMP_IDS = 20

/**
 * 数字型 ID 的规范化。去空白、转字符串、按 pattern 校验。
 * @param {unknown} raw
 * @returns {string|null} 合法则返回规范化后的字符串，否则 null
 */
export function normalizeId (raw) {
  if (raw === null || typeof raw === 'undefined') return null
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) return null
    raw = String(raw)
  }
  if (typeof raw !== 'string') return null

  const text = raw.trim()
  return ID_PATTERN.test(text) ? text : null
}

/**
 * 校验并规范化一次性上传的一组营地ID：逐个判格式、去重、限长。
 *
 * @param {unknown} raw
 * @returns {{ok: true, ids: string[]}|{ok: false, error: string, message: string}}
 */
export function normalizeCampIds (raw) {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'invalid_camp_ids', message: 'campIds 必须是数组' }
  }
  if (raw.length === 0) {
    // 空数组代表「本实例一个营地ID 都没有」。服务端不能把它当成撤销——
    // 撤销有专门的 DELETE，混在一起会让「在本实例删光绑定」误伤别的实例贡献的记录
    return { ok: false, error: 'empty_camp_ids', message: 'campIds 不能为空，撤销共享请用 DELETE' }
  }
  if (raw.length > MAX_CAMP_IDS) {
    return { ok: false, error: 'too_many_camp_ids', message: `一次最多上传 ${MAX_CAMP_IDS} 个营地ID` }
  }

  const ids = []
  for (const item of raw) {
    const id = normalizeId(item)
    if (!id) {
      return { ok: false, error: 'invalid_camp_id', message: '营地ID 必须是 5~12 位数字' }
    }
    if (!ids.includes(id)) ids.push(id)
  }

  return { ok: true, ids }
}

/** 截断超长字符串，避免把用户输入原样塞进审计表 */
export function clip (text, max = 200) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}
