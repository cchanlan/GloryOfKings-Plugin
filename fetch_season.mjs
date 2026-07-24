// 临时脚本：抓取一份成功的 /game/seasonpage 返回，dump 出真实字段结构
// 用法: node fetch_season.mjs [营地ID]
global.logger = {
  trace: () => {}, debug: () => {},
  info: (...a) => console.log('[INFO]', ...a),
  mark: (...a) => console.log('[MARK]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERR]', ...a),
}

const fs = await import('node:fs')
const api = (await import('./utils/api.js')).default

const ID = process.argv[2] || '1630945798'

function shape(o, depth = 0) {
  if (Array.isArray(o)) return o.length ? [shape(o[0], depth + 1)] : []
  if (o && typeof o === 'object') {
    const out = {}
    for (const k of Object.keys(o)) out[k] = shape(o[k], depth + 1)
    return out
  }
  return typeof o
}

async function main() {
  console.log('== 1. getProfile 拿真实 roleId, ID=', ID)
  let profile
  try { profile = await api.getProfile(ID) } catch (e) { console.log('profile 异常:', e.message) }
  console.log('returnCode:', profile?.returnCode, profile?.returnMsg || '')
  const pdata = profile?.data
  let roleId
  if (pdata) {
    roleId = pdata.targetRoleId
    console.log('targetRoleId:', roleId)
    console.log('roleList:', (pdata.roleList || []).map(r => ({ roleId: r.roleId, roleName: r.roleName, areaName: r.areaName })))
  }

  const tryIds = [...new Set([roleId, ID, ...((pdata?.roleList) || []).map(r => r.roleId)].filter(Boolean))]
  console.log('\n候选 roleId 列表:', tryIds)

  for (const rid of tryIds) {
    console.log('\n== 2. getSeasonpage roleId=', rid)
    try {
      const s = await api.getSeasonpage(rid)
      console.log('returnCode:', s?.returnCode, s?.returnMsg || '')
      if (s?.data && Object.keys(s.data).length) {
        fs.writeFileSync('./data/Seasonpage.sample.json', JSON.stringify(s, null, 2))
        fs.writeFileSync('./data/Seasonpage.shape.json', JSON.stringify(shape(s), null, 2))
        console.log('== 成功! data 顶层字段:', Object.keys(s.data))
        console.log('== 已写入 data/Seasonpage.sample.json 与 Seasonpage.shape.json')
        return
      }
    } catch (e) { console.log('season 异常:', e.message) }
  }
  console.log('\n== 未拿到有效 seasonpage 数据')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
