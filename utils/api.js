import fetch from 'node-fetch'

/**
 * API服务类，封装了与王者荣耀助手相关的各种接口请求
 * 包含用户资料、战绩、英雄数据等接口的请求方法
 */
class ApiService {
  /**
   * 初始化API服务实例
   * 设置基础URL和默认请求头
   */
  constructor() {
    this.baseUrls = {
      main: 'https://kohcamp.qq.com',
      game: 'https://ssl.kohsocialapp.qq.com:10001',
      token: 'https://api.t1qq.com/api/tool/wzrr/wztoken'
    }
    this.headers = this.#getDefaultHeaders()
  }

  /**
   * 获取默认请求头
   * @private
   * @returns {Object} 包含身份验证和客户端信息的请求头
   */
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

  /**
   * 生成通用请求头
   * @private
   * @param {string} url - 请求的URL
   * @returns {Object} 包含动态Host和其他通用头的请求头对象
   */
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

  /**
   * 通用请求方法（带重试机制）
   * @private
   * @param {string} method - HTTP方法 (GET/POST等)
   * @param {string} endpoint - API端点路径
   * @param {Object|null} body - 请求体数据
   * @param {Object} additionalHeaders - 附加请求头
   * @param {number} retries - 重试次数（默认3次）
   * @returns {Promise<Object>} 响应数据
   * @throws {Error} 请求失败时抛出错误
   */
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

  /**
   * 获取API访问令牌
   * @private
   * @returns {Promise<string>} 访问令牌
   */
  async #getToken() {
    const response = await (await fetch(this.baseUrls.token)).json()
    return response.token
  }

  /**
   * 创建带认证的请求
   * @private
   * @param {string} endpoint - API端点路径
   * @param {Object} body - 请求体数据
   * @returns {Promise<Object>} 响应数据
   */
  async #makeAuthRequest(endpoint, body) {
    return this.#request('POST', endpoint, body, {
      ...this.headers,
      token: await this.#getToken()
    })
  }

  /**
   * 获取更多对战列表
   * @param {string} ID - 用户ID
   * @returns {Promise<Object>} 包含对战列表的响应数据
   */
  async getMoreBattleList(ID) {
    return this.#makeAuthRequest('/game/morebattlelist', {
      lastTime: 0,
      recommendPrivacy: 0,
      apiVersion: 5,
      friendUserId: ID,
      option: 0
    })
  }

  /**
   * 获取对战详情
   * @param {string} ID - 用户ID
   * @param {number} battleType - 对战类型
   * @param {string} gameSvr - 游戏服务器
   * @param {string} relaySvr - 中继服务器
   * @param {string} targetRoleId - 目标角色ID
   * @param {string} gameSeq - 游戏序列号
   * @returns {Promise<Object>} 包含对战详情的响应数据
   */
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

  /**
   * 获取用户资料
   * @param {string} ID - 用户ID
   * @returns {Promise<Object>} 包含用户资料的响应数据
   */
  async getProfile(ID) {
    return this.#makeAuthRequest('/game/koh/profile', {
      targetUserId: ID,
      targetRoleId: '0',
      resVersion: '3',
      recommendPrivacy: '0',
      apiVersion: '2'
    })
  }

  /**
   * 获取赛季页面数据
   * @param {string} ID - 用户ID
   * @returns {Promise<Object>} 包含赛季数据的响应数据
   */
  async getSeasonpage(ID) {
    return this.#makeAuthRequest('/game/seasonpage', {
      recommendPrivacy: 0,
      seasonId: 0,
      roleId: ID
    })
  }

  /**
   * 获取英雄详细排名列表
   * @returns {Promise<Object>} 包含英雄排名数据的响应数据
   */
  async getdetailranklistbyid() {
    return this.#makeAuthRequest('/hero/getdetailranklistbyid', {
      bottomTab: "",
      rankId: 0,
      segment: 1,
      position: 0,
      recommendPrivacy: 0
    })
  }

  /**
   * 获取英雄战力数据（多平台）
   * @param {string} heroName - 英雄名称（中文）
   * @returns {Promise<Array>} 包含各平台战力数据的数组
   * @throws {Error} 英雄不存在或请求失败时抛出错误
   */
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

  /**
   * 获取所有英雄列表
   * @returns {Promise<Array>} 包含英雄信息的数组
   * @throws {Error} 请求失败时抛出错误
   */
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

  /**
   * 获取爆料站-皮肤数据
   * @returns {Promise<Object>} 包含爆料站-皮肤数据的响应数据
   * @throws {Error} 请求失败时抛出错误
   */
  async getHeroXpflby() {
    try {
      const response = await fetch('https://pvp.qq.com/zlkdatasys/data_zlk_xpflby.json')
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.json()
    } catch (error) {
      logger.error("[获取爆料站-皮肤数据] 接口请求失败", error);
      throw new Error(`获取爆料站-皮肤数据失败。错误: ${error}`);
    }
  }
}

export default new ApiService()
