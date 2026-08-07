jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const mockRedisClient = {
  get: jest.fn(),
  set: jest.fn()
}

jest.mock('../src/models/redis', () => ({
  client: mockRedisClient,
  getClient: jest.fn(() => mockRedisClient),
  getClientSafe: jest.fn(() => mockRedisClient)
}))

const mockAxios = {
  post: jest.fn(),
  get: jest.fn()
}

jest.mock('axios', () => mockAxios)

jest.mock('../src/utils/dateHelper', () => ({
  getISOStringWithTimezone: jest.fn((date) => date.toISOString())
}))

// config/config.js 不在仓库中（仅有 config.example.js），虚拟 mock
jest.mock(
  '../config/config',
  () => ({
    system: { timezone: 'Asia/Shanghai' }
  }),
  { virtual: true }
)

const axios = mockAxios

describe('webhookService - feishu_app', () => {
  let webhookService

  const platform = {
    type: 'feishu_app',
    name: '飞书自建应用',
    appId: 'cli_test_app_id',
    appSecret: 'test_app_secret',
    chatId: 'oc_test_chat_id',
    timeout: 10000
  }

  const tokenResponse = {
    status: 200,
    data: {
      code: 0,
      msg: 'ok',
      tenant_access_token: 't-test-tenant-token',
      expire: 7200
    }
  }

  const messageResponse = {
    status: 200,
    data: {
      code: 0,
      msg: 'success',
      data: { message_id: 'om_test_message_id' }
    }
  }

  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    mockRedisClient.get.mockResolvedValue(null)
    mockRedisClient.set.mockResolvedValue('OK')
    webhookService = require('../src/services/webhookService')
  })

  test('使用 chatId 直发成功：依次请求 token 接口和消息接口', async () => {
    axios.post
      .mockResolvedValueOnce(tokenResponse) // 获取 tenant_access_token
      .mockResolvedValueOnce(messageResponse) // 发送消息

    await webhookService.sendToPlatform(platform, 'test', { message: '测试消息' })

    expect(axios.post).toHaveBeenCalledTimes(2)

    // token 请求
    expect(axios.post.mock.calls[0][0]).toBe(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'
    )
    expect(axios.post.mock.calls[0][1]).toEqual({
      app_id: 'cli_test_app_id',
      app_secret: 'test_app_secret'
    })

    // 消息请求
    const [messageUrl, messagePayload, messageOptions] = axios.post.mock.calls[1]
    expect(messageUrl).toBe(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id'
    )
    expect(messageOptions.headers.Authorization).toBe('Bearer t-test-tenant-token')
    expect(messagePayload.receive_id).toBe('oc_test_chat_id')
    expect(messagePayload.msg_type).toBe('interactive')

    const card = JSON.parse(messagePayload.content)
    expect(card.header.title.content).toBe('🧪 测试通知')
    expect(card.header.template).toBe('blue')
    expect(card.elements[0].tag).toBe('markdown')
    expect(card.elements[0].content).toContain('测试消息')

    // token 写入缓存，TTL = expire - 120
    expect(mockRedisClient.set).toHaveBeenCalledWith(
      'webhook_feishu_app_token:cli_test_app_id',
      expect.any(String),
      'EX',
      7080
    )
  })

  test('token 缓存命中时不重复请求 token 接口', async () => {
    mockRedisClient.get.mockResolvedValueOnce(
      JSON.stringify({ token: 't-cached-token', expiresAt: Date.now() + 3600 * 1000 })
    )
    axios.post.mockResolvedValueOnce(messageResponse)

    await webhookService.sendToPlatform(platform, 'test', { message: '测试消息' })

    // 只有消息请求，没有 token 请求
    expect(axios.post).toHaveBeenCalledTimes(1)
    expect(axios.post.mock.calls[0][0]).toBe(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id'
    )
    expect(axios.post.mock.calls[0][2].headers.Authorization).toBe('Bearer t-cached-token')
  })

  test('chatName 解析：search 接口命中', async () => {
    const namePlatform = { ...platform, chatId: undefined, chatName: '运维通知群' }
    axios.post.mockResolvedValueOnce(tokenResponse).mockResolvedValueOnce(messageResponse)
    axios.get.mockResolvedValueOnce({
      data: {
        code: 0,
        msg: 'ok',
        data: {
          items: [
            { chat_id: 'oc_other', name: '其他群' },
            { chat_id: 'oc_matched', name: '运维通知群' }
          ]
        }
      }
    })

    await webhookService.sendToPlatform(namePlatform, 'test', { message: '测试消息' })

    expect(axios.get).toHaveBeenCalledTimes(1)
    expect(axios.get.mock.calls[0][0]).toBe('https://open.feishu.cn/open-apis/im/v1/chats/search')
    expect(axios.get.mock.calls[0][1].params.query).toBe('运维通知群')
    expect(axios.post.mock.calls[1][1].receive_id).toBe('oc_matched')

    // chat_id 解析结果缓存 1 小时
    expect(mockRedisClient.set).toHaveBeenCalledWith(
      'webhook_feishu_app_chat:cli_test_app_id:运维通知群',
      'oc_matched',
      'EX',
      3600
    )
  })

  test('chatName 解析：search 未命中时回退到群列表分页匹配', async () => {
    const namePlatform = { ...platform, chatId: undefined, chatName: '告警群' }
    axios.post.mockResolvedValueOnce(tokenResponse).mockResolvedValueOnce(messageResponse)
    axios.get
      .mockResolvedValueOnce({
        // search 接口无精确匹配
        data: { code: 0, msg: 'ok', data: { items: [{ chat_id: 'oc_x', name: '告警' }] } }
      })
      .mockResolvedValueOnce({
        // 群列表第一页未命中，has_more
        data: {
          code: 0,
          msg: 'ok',
          data: {
            items: [{ chat_id: 'oc_y', name: '告警通知' }],
            has_more: true,
            page_token: 'page2'
          }
        }
      })
      .mockResolvedValueOnce({
        // 群列表第二页命中
        data: {
          code: 0,
          msg: 'ok',
          data: {
            items: [{ chat_id: 'oc_alert', name: '告警群' }],
            has_more: false
          }
        }
      })

    await webhookService.sendToPlatform(namePlatform, 'test', { message: '测试消息' })

    expect(axios.get).toHaveBeenCalledTimes(3)
    expect(axios.get.mock.calls[1][0]).toBe('https://open.feishu.cn/open-apis/im/v1/chats')
    expect(axios.get.mock.calls[1][1].params.page_size).toBe(100)
    expect(axios.get.mock.calls[2][1].params.page_token).toBe('page2')
    expect(axios.post.mock.calls[1][1].receive_id).toBe('oc_alert')
  })

  test('飞书返回 code != 0 时抛错并被 retryWithBackoff 重试', async () => {
    axios.post
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValue({ data: { code: 230002, msg: 'chat not found' } })

    await expect(
      webhookService.sendToPlatform(
        platform,
        'test',
        { message: '测试' },
        {
          maxRetries: 3,
          retryDelay: 1
        }
      )
    ).rejects.toThrow('code=230002')

    // 1 次 token 请求 + 3 次消息请求（重试 2 次）
    expect(axios.post).toHaveBeenCalledTimes(4)
  })

  test('自定义 apiBaseUrl 会去除结尾斜杠', async () => {
    const customPlatform = { ...platform, apiBaseUrl: 'https://open.larksuite.com/' }
    axios.post.mockResolvedValueOnce(tokenResponse).mockResolvedValueOnce(messageResponse)

    await webhookService.sendToPlatform(customPlatform, 'test', { message: '测试' })

    expect(axios.post.mock.calls[0][0]).toBe(
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal'
    )
    expect(axios.post.mock.calls[1][0]).toBe(
      'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id'
    )
  })
})

describe('webhookConfigService - feishu_app 校验', () => {
  let webhookConfigService

  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    mockRedisClient.get.mockResolvedValue(null)
    mockRedisClient.set.mockResolvedValue('OK')
    webhookConfigService = require('../src/services/webhookConfigService')
  })

  test('合法配置通过校验（chatId 或 chatName 任一即可）', () => {
    expect(() =>
      webhookConfigService.validatePlatformConfig({
        type: 'feishu_app',
        appId: 'cli_xxx',
        appSecret: 'secret',
        chatId: 'oc_xxx'
      })
    ).not.toThrow()

    expect(() =>
      webhookConfigService.validatePlatformConfig({
        type: 'feishu_app',
        appId: 'cli_xxx',
        appSecret: 'secret',
        chatName: '运维通知群'
      })
    ).not.toThrow()
  })

  test('缺少 appId 或 appSecret 时报错', () => {
    expect(() =>
      webhookConfigService.validatePlatformConfig({
        type: 'feishu_app',
        appSecret: 'secret',
        chatId: 'oc_xxx'
      })
    ).toThrow('App ID')

    expect(() =>
      webhookConfigService.validatePlatformConfig({
        type: 'feishu_app',
        appId: 'cli_xxx',
        chatId: 'oc_xxx'
      })
    ).toThrow('App Secret')
  })

  test('chatId 和 chatName 都缺失时报错', () => {
    expect(() =>
      webhookConfigService.validatePlatformConfig({
        type: 'feishu_app',
        appId: 'cli_xxx',
        appSecret: 'secret'
      })
    ).toThrow('群聊 ID 或群聊名称')
  })

  test('validateConfig 接受 feishu_app 且豁免 URL 必填', () => {
    expect(() =>
      webhookConfigService.validateConfig({
        platforms: [
          {
            type: 'feishu_app',
            appId: 'cli_xxx',
            appSecret: 'secret',
            chatId: 'oc_xxx'
          }
        ]
      })
    ).not.toThrow()
  })
})
