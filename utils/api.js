import fetch from 'node-fetch'

class ApiService {
  constructor () {
    this.baseUrls = {
      main: 'https://kohcamp.qq.com',
      game: 'https://ssl.kohsocialapp.qq.com:10001'
    }
  }

  getCommonHeaders (url) {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.71 Mobile Safari/537.36',
      origin: 'https://yingdi.qq.com',
      pragma: 'no-cache',
      'q-guid': '4c3328459d6b53c1fbc97281377988cb',
      'q-ua2': 'PR=PC&CO=WBK&QV=3&PL=WIN&PB=GE&PPVN=12.2.0.5544&COVC=049400&CHID=10031074&RL=1920*1080&MO=QB&VE=GA&BIT=64&OS=10.0.19045&RT=32',
      'sec-ch-ua-mobile': '?1',
      'sec-ch-ua-platform': '"Android"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      ssoappid: 'campAuthor',
      ssobusinessid: 'web'
    }

    if (url.includes(this.baseUrls.main)) {
      headers.Host = 'kohcamp.qq.com'
    } else if (url.includes(this.baseUrls.game)) {
      headers.Host = 'ssl.kohsocialapp.qq.com'
    }

    return headers
  }

  async requestWithRetry(method, endpoint, body = null, additionalHeaders = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        return await this.request(method, endpoint, body, additionalHeaders)
      } catch (error) {
        if (i === retries - 1) throw error
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)))
      }
    }
  }

  async request(method, endpoint, body = null, additionalHeaders = {}) {
    const url = `${this.baseUrls.main}${endpoint}`
    const headers = {
      ...this.getCommonHeaders(url),
      ...additionalHeaders
    }
    
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null,
        timeout: 10000
      })
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(`HTTP ${response.status}: ${errorData.message || response.statusText}`)
      }
      
      return await response.json()
    } catch (error) {
      logger.error(`API请求失败: ${error.message}`, {
        url,
        method,
        body: JSON.stringify(body)
      })
      throw error
    }
  }

  async post (endpoint, body, additionalHeaders = {}) {
    return this.request('POST', endpoint, body, additionalHeaders)
  }

  async getPublicTokenAndOpenID () {
    const response = await (await fetch('https://gitee.com/Tloml-Starry/resources/raw/master/resources/json/WzryToken.json')).json()
    const { Token, OpenID } = response
    return { Token, OpenID }
  }
}

export default new ApiService()
