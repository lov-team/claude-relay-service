jest.mock('../config/config', () => ({
  claude: {
    apiVersion: '2023-06-01',
    betaHeader: '',
    systemPrompt: '',
    overloadHandling: { enabled: 0 }
  },
  requestTimeout: 600000
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  api: jest.fn(),
  database: jest.fn(),
  performance: jest.fn()
}))
jest.mock('../src/models/redis', () => ({
  client: { get: jest.fn(), setex: jest.fn(), expire: jest.fn() },
  getAllClaudeAccounts: jest.fn()
}))
jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForStream: jest.fn(),
  getHttpsAgentForNonStream: jest.fn(),
  getPricingData: jest.fn(() => null)
}))
jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({
  refreshAccountToken: jest.fn()
}))
jest.mock('../src/services/account/claudeAccountNurtureService', () => ({}))
jest.mock('../src/services/accountNurtureConfigService', () => ({
  getConfig: jest.fn(async () => ({
    trafficGuardrails: {
      enabled: true,
      maxBodyBytes: 1024,
      maxMessages: 1,
      maxTools: 2,
      maxOutputTokens: 64,
      retryAfterSeconds: 15
    },
    oauthErrorPatterns: { blocked: [], revoked: [] }
  }))
}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  markAccountUnauthorized: jest.fn()
}))
jest.mock('../src/services/claudeCodeHeadersService', () => ({}))
jest.mock('../src/services/requestIdentityService', () => ({
  transform: jest.fn(({ body, headers }) => ({ body, headers }))
}))
jest.mock('../src/services/userMessageQueueService', () => ({}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))
jest.mock('../src/validators/clients/claudeCodeValidator', () => ({
  includesClaudeCodeSystemPrompt: jest.fn(() => true)
}))

const claudeRelayService = require('../src/services/relay/claudeRelayService')
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')
const accountNurtureConfigService = require('../src/services/accountNurtureConfigService')
const claudeAccountService = require('../src/services/account/claudeAccountService')

const oversizedRequest = {
  model: 'claude-sonnet-4-5',
  max_tokens: 65,
  messages: [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' }
  ]
}

describe('Claude relay traffic guardrail integration', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('blocks non-stream traffic before account selection', async () => {
    const response = await claudeRelayService.relayRequest(
      oversizedRequest,
      { id: 'key-1', name: 'test-key' },
      null,
      null,
      {}
    )

    expect(response.statusCode).toBe(429)
    expect(response.headers['Retry-After']).toBe('15')
    expect(JSON.parse(response.body).error).toMatchObject({
      code: 'claude_request_guardrail',
      metadata: { limit_kind: 'request_guardrail', retryable: true }
    })
    expect(unifiedClaudeScheduler.selectAccountForApiKey).not.toHaveBeenCalled()
    expect(accountNurtureConfigService.getConfig).toHaveBeenCalled()
  })

  test('writes the same guardrail response for stream traffic', async () => {
    const responseStream = {
      headersSent: false,
      status: jest.fn(),
      setHeader: jest.fn(),
      write: jest.fn(),
      end: jest.fn()
    }

    await claudeRelayService.relayStreamRequestWithUsageCapture(
      oversizedRequest,
      { id: 'key-1', name: 'test-key' },
      responseStream,
      {},
      null
    )

    expect(responseStream.status).toHaveBeenCalledWith(429)
    expect(responseStream.setHeader).toHaveBeenCalledWith('Retry-After', '15')
    expect(responseStream.end).toHaveBeenCalledTimes(1)
    expect(unifiedClaudeScheduler.selectAccountForApiKey).not.toHaveBeenCalled()
  })

  test('refreshes a generic Claude OAuth 401 once for both relay paths', async () => {
    claudeAccountService.refreshAccountToken.mockResolvedValue({
      success: true,
      accessToken: 'refreshed-access-token'
    })

    await expect(
      claudeRelayService._recoverClaudeOAuth401({
        accountId: 'account-1',
        accountType: 'claude-official',
        sessionHash: 'session-1'
      })
    ).resolves.toEqual({
      retry: true,
      handled: false,
      accessToken: 'refreshed-access-token'
    })
  })

  test('marks a repeated post-refresh 401 unauthorized for one anomaly notification', async () => {
    unifiedClaudeScheduler.markAccountUnauthorized.mockResolvedValue({ success: true })

    await expect(
      claudeRelayService._recoverClaudeOAuth401({
        accountId: 'account-1',
        accountType: 'claude-official',
        sessionHash: 'session-1',
        alreadyRetried: true,
        oauthError: { message: 'Invalid authentication credentials' }
      })
    ).resolves.toEqual({ retry: false, handled: true })

    expect(unifiedClaudeScheduler.markAccountUnauthorized).toHaveBeenCalledWith(
      'account-1',
      'claude-official',
      'session-1',
      expect.objectContaining({
        force: true,
        errorCode: 'CLAUDE_OAUTH_REPEATED_401'
      })
    )
  })
})
