/**
 * 让一批**互相独立**的异步任务并发跑。
 *
 * 为什么需要它：请求本身已经是「按账号并发」的（`utils/api.js` 的 `#acquireSlot`
 * 按账号分队列，见那里的注释），但调用方要是写成 `for (...) await xxx()`，
 * 同一时刻就只有**一个**请求在飞——池里再多账号也用不上，等于 5 条收银台只开 1 条。
 * 这个工具补的就是调用方这一层。
 *
 * 并发数默认取「池里可用的全局账号数」：和账号队列数正好对齐，
 * 开多了只会在队列里排队，开少了浪费账号。
 *
 * ⚠️ **只适用于互不依赖的任务**。有依赖的（典型是翻页：下一页要用上一页返回的游标）
 * 必须老老实实串行，套上这个只会拿错数据。判断标准很简单：
 * 每个任务的输入在开始前就确定了没有？是 → 能用；否 → 串行。
 *
 * 任务抛错会直接中断整批（Promise.all 的语义）——需要「单个失败不影响其它」的话，
 * 在 handler 里自己 try/catch，别指望这里兜。
 */
import ApiService from './api.js'

/** 默认并发路数：池里能用的全局账号数，读不出来时退成 1（串行，等于没并发） */
function defaultConcurrency () {
  try {
    return Math.max(1, ApiService.usableAccountCount())
  } catch {
    return 1
  }
}

/**
 * @param {Iterable} items 待处理的任务输入
 * @param {(item: any, index: number) => Promise<any>} handler 单个任务
 * @param {object} [opts]
 * @param {number} [opts.concurrency] 手动指定并发路数（默认按账号数）
 * @returns {Promise<Array>} 与 items 同序的结果数组
 */
export async function mapConcurrent (items, handler, { concurrency } = {}) {
  const list = Array.from(items || [])
  if (!list.length) return []

  const lanes = Math.max(1, Math.min(Number(concurrency) || defaultConcurrency(), list.length))
  const results = new Array(list.length)
  // 单线程下 cursor++ 是原子的，多路协程抢号不会重复
  let cursor = 0

  const lane = async () => {
    for (;;) {
      const index = cursor++
      if (index >= list.length) return
      results[index] = await handler(list[index], index)
    }
  }

  await Promise.all(Array.from({ length: lanes }, lane))
  return results
}
