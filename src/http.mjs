/**
 * HTTP 层的读写工具：请求体读取（带硬上限）、JSON 响应、统一错误体。
 */

/** 请求体上限。正常请求不到 1 KiB，64 KiB 是给批量接口留的余量 */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * 带状态码的错误。抛出后由顶层捕获并转成统一错误体。
 * `error` 是给程序分支用的稳定标识，`message` 是给人看的、随时可以改。
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} error 稳定 slug，如 unauthorized / not_found
   * @param {string} message 人话
   * @param {Record<string,string>} [headers]
   */
  constructor (status, error, message, headers = {}) {
    super(message)
    this.status = status
    this.error = error
    this.headers = headers
  }
}

export function sendJson (res, status, payload, headers = {}) {
  if (res.writableEnded) return

  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    // 共享库的响应一律不许任何中间层缓存：撤销要立刻生效
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  })
  res.end(body)
}

export function sendError (res, error) {
  const status = Number(error?.status) || 500
  const slug = status === 500 ? 'internal' : (error?.error || 'error')
  // 500 绝不回显内部信息：堆栈只进日志
  const message = status === 500 ? '服务内部错误' : (error?.message || '请求失败')

  sendJson(res, status, { ok: false, error: slug, message }, error?.headers || {})
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 先看 Content-Length 是为了在超大请求上尽早拒绝（省掉读完整段流量），
 * 但**不能只信它**——分块传输时没有这个头，或者被伪造得很小。
 * 所以流式累计时还要再数一遍字节，超了立刻销毁连接。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<unknown>}
 */
export function readJsonBody (req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0)
    if (declared > limit) {
      reject(new HttpError(413, 'payload_too_large', `请求体不能超过 ${limit} 字节`))
      // 不读直接销毁会让客户端收到 ECONNRESET 而不是响应，所以先让它把响应收完
      req.resume()
      return
    }

    const chunks = []
    let size = 0
    let done = false

    const finish = (fn, value) => {
      if (done) return
      done = true
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      fn(value)
    }

    function onData (chunk) {
      size += chunk.length
      if (size > limit) {
        // req.destroy() 会连响应一起掐掉，这里只停止读取并让上层回 413
        finish(reject, new HttpError(413, 'payload_too_large', `请求体不能超过 ${limit} 字节`))
        return
      }
      chunks.push(chunk)
    }

    function onEnd () {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        finish(reject, new HttpError(400, 'bad_json', '请求体是空的，需要 JSON'))
        return
      }

      try {
        finish(resolve, JSON.parse(raw))
      } catch {
        finish(reject, new HttpError(400, 'bad_json', '请求体不是合法的 JSON'))
      }
    }

    function onError (error) {
      finish(reject, error)
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

/**
 * 取客户端 IP。默认**不信** X-Forwarded-For——直接暴露在公网时，
 * 任何人都能靠伪造这个头把按 IP 的限流绕过去。
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 */
export function clientIp (req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    if (forwarded) return forwarded
  }
  return req.socket?.remoteAddress || 'unknown'
}
