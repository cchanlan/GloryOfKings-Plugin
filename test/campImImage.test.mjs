/**
 * 营地**图片消息**的解析与去重。
 *
 * 背景（2026-10-14 实测）：营地好友发图片时消息正文**是空的**，
 * 地址在 `links` 里 —— 下游只认 `message`，于是「别人发的图片收不到」。
 * 这个文件钉住三件事：
 *   · `extractImages` 能从真实样本里提取原图地址
 *   · 图片消息**不能**被当空消息丢掉（dispatch 的判据）
 *   · 两张不同的图（正文都为空、同一秒发出）不会被去重键误判成同一条
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, ensurePluginRoot, makeSandbox, run } from './helpers/sandbox.mjs'

/** 真实样本：2026-10-14 从 gok-im 队列里抓的（1300×2796 的游戏截图） */
const REAL_LINK = [[7, 0, 0, '{"origin":"https://chat-1255653016.cos.ap-guangzhou.myqcloud.com/1762241423/20001/6BDB35586A027F314FB76C540DF54DCF.png","height":2796,"emojiName":null,"width":1290,"thumb":"https://chat-1255653016.cos.ap-guangzhou.myqcloud.com/1762241423/20001/6BDB35586A027F314FB76C540DF54DCF.png?imageMogr2/thumbnail/!30p","type":0,"scale":1}']]

const CASE = `
import assert from 'node:assert/strict'
import { extractImages, photoMark } from './utils/campImImage.js'
import * as store from './utils/campImStore.js'

globalThis.logger = { info(){}, warn(){}, error(){}, debug(){}, mark(){} }

const REAL_LINK = ${JSON.stringify(REAL_LINK)}
const ORIGIN = 'https://chat-1255653016.cos.ap-guangzhou.myqcloud.com/1762241423/20001/6BDB35586A027F314FB76C540DF54DCF.png'

// ① 真实样本：取到原图地址（origin 优先，不是 30% 缩略图）
{
  const msg = { selfUserId: '1580886057', fromUserId: '1762241423', text: '', raw: { type: 'photo', message: '', links: REAL_LINK } }
  const pics = extractImages(msg)
  assert.equal(pics.length, 1)
  assert.equal(pics[0].url, ORIGIN)
  assert.equal(pics[0].width, 1290)
  assert.equal(pics[0].height, 2796)
  assert.ok(!pics[0].url.includes('imageMogr2'), '拿到了缩略图，应当优先原图')
}

// ② 两种调用形态都认：消息对象（{raw}）与裸 param
{
  const bare = { selfUserId: 'x', links: REAL_LINK }
  assert.equal(extractImages(bare).length, 1, '裸 param 形态没认出来')
}

// ③ 没有图 / links 是坏数据 → 空数组，不抛
{
  assert.deepEqual(extractImages({ text: '你好' }), [])
  assert.deepEqual(extractImages({ raw: { links: null } }), [])
  assert.deepEqual(extractImages({ raw: { links: [[7, 0, 0]] } }), [])
  assert.deepEqual(extractImages({ raw: { links: [[7, 0, 0, 'not json']] } }), [])
  assert.deepEqual(extractImages({ raw: { links: [[7, 0, 0, '{"origin":"/relative/x.png"}']] } }), [], '相对路径不该当图片')
  assert.deepEqual(extractImages(null), [])
}

// ④ 只有 thumb 没有 origin 时用 thumb 兜底（别整条图丢了）
{
  const onlyThumb = [[7, 0, 0, '{"thumb":"https://example.com/a.png?x=1","width":10,"height":10}']]
  const pics = extractImages({ links: onlyThumb })
  assert.equal(pics.length, 1)
  assert.equal(pics[0].url, 'https://example.com/a.png?x=1')
}

// ④b ⭐⭐ 离线补拉的形态：多包一层 linkData（协议码还是字符串）
//     真实样本（2026-10-13 实测 /chatserver/offline/singlemsg）
{
  const OFFLINE_LINK = [{
    linkData: ['7', '0', '0', JSON.stringify({ origin: ORIGIN, height: 2796, emojiName: null, width: 1290,
      thumb: ORIGIN + '?imageMogr2/thumbnail/!30p', type: 0, scale: 1 })]
  }]
  const msg = { selfUserId: '1580886057', fromUserId: '1762241423', text: '', raw: { message: '', links: OFFLINE_LINK } }
  const pics = extractImages(msg)
  assert.equal(pics.length, 1, '离线补拉的 linkData 形态没认出来（断线期间收的图会全丢）')
  assert.equal(pics[0].url, ORIGIN)
  assert.equal(pics[0].width, 1290)
}

// ④c 坏数据的 linkData（不是数组 / 空对象）也不能抛
{
  assert.deepEqual(extractImages({ links: [{ linkData: null }] }), [])
  assert.deepEqual(extractImages({ links: [{ linkData: 'x' }] }), [])
  assert.deepEqual(extractImages({ links: [{}] }), [])
  assert.deepEqual(extractImages({ links: [null] }), [])
}

// ⑤ 占位文案：单图 [图片]、多图 [图片 ×N]，且不是发件人视角的「我发送了…」
{
  assert.equal(photoMark(1), '[图片]')
  assert.equal(photoMark(2), '[图片 ×2]')
  assert.ok(!photoMark(1).includes('我'), '占位文案不该带发件人视角的「我」')
}

// ⑥ ⭐ 同一人同一秒连发两张**不同的图**（正文都为空）：去重键必须分得开
{
  const base = { selfUserId: '1580886057', fromUserId: '1762241423', time: 1791895865, messageId: '766407358036' }
  const a = { ...base, text: '', raw: { links: REAL_LINK } }
  const b = { ...base, messageId: '766407731549', raw: { links: [[7, 0, 0, JSON.stringify({ origin: 'https://example.com/B.png' })]] } }
  const keysA = store.messageKeys(a)
  const keysB = store.messageKeys(b)
  const overlap = keysA.filter(k => keysB.includes(k))
  assert.deepEqual(overlap, [], '两张不同的图被判成同一条了（会被静默丢掉）')
}

// ⑦ 同一条图片消息重放（换服务端 id）：两条键都必须命中
{
  const one = { selfUserId: '1580886057', fromUserId: '1762241423', time: 1791895865, messageId: '766407358036', text: '', raw: { links: REAL_LINK } }
  const replay = { ...one, id: 9999999999999 }
  assert.deepEqual(store.messageKeys(replay), store.messageKeys(one))
  assert.ok(store.messageKeys(one).includes('1580886057:766407358036'), '游戏消息 id 键丢了')
}

// ⑧ 无图消息的指纹格式**和旧版一字不差**（升级不该让盘上已有的去重键失效）
{
  const plain = { selfUserId: '409420549', fromUserId: '1618788471', time: 1789893406, text: 'dsh测试1155' }
  assert.ok(store.messageKeys(plain).includes('409420549:1618788471:1789893406:dsh测试1155'), '旧格式指纹变了，升级会重推老消息')
}
console.log(JSON.stringify({ ok: true }))
`

test('营地图片消息：提取原图地址、区分连拍、重放仍去重', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, CASE, { timeoutMs: 30000 })
    assert.ok(out.ok, out.stderr)
    assert.deepEqual(JSON.parse(out.stdout), { ok: true })
  } finally {
    cleanup(root)
  }
})
