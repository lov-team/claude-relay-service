jest.mock(
  '../config/config',
  () => ({
    concurrency: {}
  }),
  { virtual: true }
)

jest.mock('../src/services/apiKeyService', () => ({
  validateApiKey: jest.fn()
}))

jest.mock('../src/services/userService', () => ({}))

jest.mock('../src/models/redis', () => ({
  getClient: jest.fn()
}))

jest.mock('../src/validators/clientValidator', () => ({
  validateRequest: jest.fn(() => ({ allowed: true }))
}))

jest.mock('../src/validators/clients/claudeCodeValidator', () => ({
  validate: jest.fn(() => true)
}))

jest.mock('../src/services/claudeRelayConfigService', () => ({
  isClaudeCodeOnlyEnabled: jest.fn(() => false),
  getConfig: jest.fn()
}))

jest.mock('../src/utils/statsHelper', () => ({
  calculateWaitTimeStats: jest.fn()
}))

jest.mock('../src/utils/modelHelper', () => ({
  isClaudeFamilyModel: jest.fn(() => false)
}))

jest.mock('../src/utils/logger', () => ({
  security: jest.fn(),
  api: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}))

const apiKeyService = require('../src/services/apiKeyService')
const redis = require('../src/models/redis')
const { authenticateApiKey } = require('../src/middleware/auth')

function createReq() {
  return {
    headers: {
      authorization: 'Bearer cr_secret-token'
    },
    query: {},
    path: '/v1/responses',
    originalUrl: '/openai/v1/responses',
    body: {
      model: 'gpt-5'
    },
    ip: '127.0.0.1',
    connection: {
      remoteAddress: '127.0.0.1'
    },
    once: jest.fn()
  }
}

function createRes() {
  return {
    headers: {},
    statusCode: 200,
    set: jest.fn(function set(name, value) {
      if (typeof name === 'object') {
        Object.assign(this.headers, name)
      } else {
        this.headers[name] = value
      }
      return this
    }),
    setHeader: jest.fn(function setHeader(name, value) {
      this.headers[name] = value
      return this
    }),
    status: jest.fn(function status(code) {
      this.statusCode = code
      return this
    }),
    json: jest.fn(function json(payload) {
      this.body = payload
      return this
    }),
    once: jest.fn()
  }
}

describe('authenticateApiKey CRS local rate limit errors', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('returns retry-without-disable error when request RPM is exhausted', async () => {
    const windowStart = Date.now()
    const client = {
      get: jest.fn(async (key) => {
        if (key.includes('window_start')) {
          return String(windowStart)
        }
        if (key.includes('requests')) {
          return '1'
        }
        if (key.includes('tokens')) {
          return '0'
        }
        if (key.includes('cost')) {
          return '0'
        }
        return null
      }),
      set: jest.fn(),
      incr: jest.fn()
    }

    redis.getClient.mockReturnValue(client)
    apiKeyService.validateApiKey.mockResolvedValue({
      valid: true,
      keyData: {
        id: 'key_1',
        name: 'new-api codex channel',
        permissions: ['openai'],
        concurrencyLimit: 0,
        rateLimitWindow: 1,
        rateLimitRequests: 1,
        tokenLimit: 0,
        rateLimitCost: 0,
        dailyCostLimit: 0,
        totalCostLimit: 0,
        enableClientRestriction: false,
        allowedClients: []
      }
    })

    const req = createReq()
    const res = createRes()
    const next = jest.fn()

    await authenticateApiKey(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.headers['Retry-After']).toBe('60')
    expect(res.headers['X-CRS-Error-Code']).toBe('crs_rate_limited')
    expect(res.headers['X-Relay-Action']).toBe('retry_without_disable')
    expect(res.body).toEqual({
      error: {
        message: 'CRS local rate limit reached; retry another upstream channel',
        type: 'rate_limit_error',
        code: 'crs_rate_limited',
        metadata: {
          source: 'claude-relay-service',
          retryable: true,
          disable_channel: false,
          limit_kind: 'requests'
        }
      }
    })
    expect(JSON.stringify(res.body)).not.toContain('key_1')
    expect(JSON.stringify(res.body)).not.toContain('cr_secret-token')
    expect(client.incr).not.toHaveBeenCalled()
  })
})
