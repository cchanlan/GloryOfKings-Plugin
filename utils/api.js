import fetch from 'node-fetch'

class ApiService {
  constructor() {
    this.baseUrls = {
      main: 'https://kohcamp.qq.com',
      game: 'https://ssl.kohsocialapp.qq.com:10001',
      token: 'https://api.t1qq.com/api/tool/wzrr/wztoken'
    }
    this.headers = this.#getDefaultHeaders()
  }

  #getDefaultHeaders() {
    return {
      Host: 'kohcamp.qq.com',
      cchannelid: '2002',
      cclientversioncode: '2037905606',
      cclientversionname: '8.101.1017',
      ccurrentgameid: '20001',
      cgameid: '20001',
      cgzip: '1',
      cisarm64: 'false',
      'content-type': 'application/json',
      cpuhardware: 'unknown',
      crand: '1734580133908',
      csupportarm64: 'true',
      csystem: 'android',
      csystemversioncode: '32',
      csystemversionname: '12',
      gameareaid: '1',
      gameid: '20001',
      gameopenid: '54533036A3D6E4241440CBCD66694578',
      gameroleid: '2157931910',
      gameserverid: '1312',
      gameusersex: '2',
      kohdimgender: '1',
      noencrypt: '1',
      openid: '472AD0DD361C8EC026E52F445041F843',
      tinkerid: '2037905606_32_0',
      userid: '2118558336',
      'x-client-proto': 'https'
    }
  }

  #getCommonHeaders(url) {
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

    headers.Host = url.includes(this.baseUrls.main) ? 'kohcamp.qq.com' : 'ssl.kohsocialapp.qq.com'
    return headers
  }

  async #request(method, endpoint, body = null, additionalHeaders = {}, retries = 3) {
    const url = `${this.baseUrls.main}${endpoint}`
    const headers = { ...this.#getCommonHeaders(url), ...additionalHeaders }

    for (let i = 0; i < retries; i++) {
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
        if (i === retries - 1) {
          logger.error(`API请求失败: ${error.message}`, { url, method, body: JSON.stringify(body) })
          throw error
        }
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)))
      }
    }
  }

  async #getToken() {
    const response = await (await fetch(this.baseUrls.token)).json()
    return response.token
  }

  async #makeAuthRequest(endpoint, body) {
    return this.#request('POST', endpoint, body, {
      ...this.headers,
      token: await this.#getToken()
    })
  }

  async getMoreBattleList(ID) {
    return this.#makeAuthRequest('/game/morebattlelist', {
      lastTime: 0,
      recommendPrivacy: 0,
      apiVersion: 5,
      friendUserId: ID,
      option: 0
    })
  }

  async getBattledetail(ID, battleType, gameSvr, relaySvr, targetRoleId, gameSeq) {
    return this.#makeAuthRequest('/game/battledetail', {
      recommendPrivacy: 0,
      battleType,
      gameSvr,
      relaySvr,
      targetRoleId,
      gameSeq,
      friendUserId: ID
    })
  }

  async getProfile(ID) {
    return this.#makeAuthRequest('/game/koh/profile', {
      targetUserId: ID,
      targetRoleId: '0',
      resVersion: '3',
      recommendPrivacy: '0',
      apiVersion: '2'
    })
  }

  async getSeasonpage(ID) {
    return this.#makeAuthRequest('/game/seasonpage', {
      recommendPrivacy: 0,
      seasonId: 0,
      roleId: ID
    })
  }

  async getdetailranklistbyid() {
    return this.#makeAuthRequest('/hero/getdetailranklistbyid', {
      bottomTab: "",
      rankId: 0,
      segment: 1,
      position: 0,
      recommendPrivacy: 0
    })
  }

  async newsignin(token, ID) {
    return this.#makeAuthRequest('/operation/action/newsignin', {
      gameId: "20001",
      recommendPrivacy: 0,
      roleId: ID
    })
  }

  async getHeroFightingCapacity(heroName) {
    const regions = ["aqq", "awx", "iqq", "iwx"]
    return Promise.all(regions.map(async (hero) => {
      try {
        const res = await fetch(`https://www.sapi.run/hero/select.php?hero=${heroName}&type=${hero}`)
        const data = await res.json()
        if (data.code !== 200) throw new Error(`该英雄不存在，请检查。错误: ${data}`)
        return data.data
      } catch (err) {
        logger.error("[战力] 接口请求失败", err)
        throw new Error(`战力接口请求失败。错误: ${err}`)
      }
    }))
  }

  /** 获取英雄列表 */
  async getHeroList() {
    try {
      const response = await fetch('https://pvp.qq.com/web201605/js/herolist.json');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      logger.error("[获取英雄列表] 接口请求失败", error);
      throw new Error(`获取英雄列表失败。错误: ${error}`);
    }
  }

  async getPublicTokenAndOpenID() {
    const response = await (await fetch('https://gitee.com/Tloml-Starry/resources/raw/master/resources/json/WzryToken.json')).json()
    return response
  }
}

export default new ApiService()
