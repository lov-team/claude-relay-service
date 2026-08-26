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
  client: {
    get: jest.fn(),
    setex: jest.fn(),
    expire: jest.fn()
  },
  getAllClaudeAccounts: jest.fn()
}))

jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForStream: jest.fn(),
  getHttpsAgentForNonStream: jest.fn(),
  getPricingData: jest.fn(() => null)
}))

jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({
  getAccount: jest.fn(),
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  clearSessionMapping: jest.fn()
}))
jest.mock('../src/services/claudeCodeHeadersService', () => ({}))
jest.mock('../src/services/requestIdentityService', () => ({
  transform: jest.fn(({ body, headers }) => ({ body, headers })),
  extractAccountUuid: jest.fn(() => null),
  buildRelayGeneratedUserId: jest.fn(() =>
    JSON.stringify({
      device_id: 'relay-device',
      account_uuid: '',
      session_id: 'relay-session'
    })
  )
}))
jest.mock('../src/services/userMessageQueueService', () => ({}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(),
  recordErrorHistory: jest.fn()
}))
jest.mock('../src/validators/clients/claudeCodeValidator', () => ({
  includesClaudeCodeSystemPrompt: jest.fn(() => true)
}))

const claudeRelayService = require('../src/services/relay/claudeRelayService')
const ClaudeCodeValidator = require('../src/validators/clients/claudeCodeValidator')
const claudeAccountService = require('../src/services/account/claudeAccountService')
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const redis = require('../src/models/redis')

describe('Claude relay cache_control ttl handling', () => {
  beforeEach(() => {
    ClaudeCodeValidator.includesClaudeCodeSystemPrompt.mockReturnValue(true)
  })

  test('preserves supported cache_control ttl values for Claude Code requests', () => {
    const body = {
      model: 'claude-opus-4-7',
      max_tokens: 64,
      system: [
        {
          type: 'text',
          text: 'system prompt',
          cache_control: { type: 'ephemeral', ttl: '1H' }
        }
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'cached prompt',
              cache_control: { type: 'ephemeral', ttl: '5m' }
            }
          ]
        }
      ]
    }

    const processed = claudeRelayService._processRequestBody(body, null, true)

    expect(processed.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(processed.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '5m'
    })
  })

  test('removes unsupported cache_control ttl values', () => {
    const body = {
      model: 'claude-opus-4-7',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'cached prompt',
              cache_control: { type: 'ephemeral', ttl: '30m' }
            }
          ]
        }
      ]
    }

    const processed = claudeRelayService._processRequestBody(body, null, true)

    expect(processed.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  test('retains the four deepest cache breakpoints when the request exceeds the limit', () => {
    const body = {
      model: 'claude-opus-4-8',
      tools: [
        {
          name: 'Read',
          input_schema: { type: 'object' },
          cache_control: { type: 'ephemeral' }
        }
      ],
      system: [
        {
          type: 'text',
          text: 'early system prompt',
          cache_control: { type: 'ephemeral' }
        },
        {
          type: 'text',
          text: 'late system prompt',
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'first cached turn',
              cache_control: { type: 'ephemeral' }
            }
          ]
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'second cached turn',
              cache_control: { type: 'ephemeral' }
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'latest cached turn',
              cache_control: { type: 'ephemeral' }
            }
          ]
        }
      ]
    }

    const processed = claudeRelayService._processRequestBody(body, null, true)

    expect(processed.tools[0].cache_control).toBeUndefined()
    expect(processed.system[0].cache_control).toBeUndefined()
    expect(processed.system[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(processed.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(processed.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(processed.messages[2].content[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  test('leaves requests with four cache breakpoints unchanged', () => {
    const body = {
      model: 'claude-opus-4-8',
      system: [
        {
          type: 'text',
          text: 'system prompt',
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: ['one', 'two', 'three'].map((text) => ({
        role: 'user',
        content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
      }))
    }

    const processed = claudeRelayService._processRequestBody(body, null, true)

    expect(processed.system[0].cache_control).toEqual({ type: 'ephemeral' })
    processed.messages.forEach((message) => {
      expect(message.content[0].cache_control).toEqual({ type: 'ephemeral' })
    })
  })

  test('adds extended cache ttl beta when request uses one hour cache', () => {
    const betaHeader = claudeRelayService._getBetaHeader('claude-opus-4-7', '', {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'cached prompt',
              cache_control: { type: 'ephemeral', ttl: '1h' }
            }
          ]
        }
      ]
    })

    expect(betaHeader.split(',')).toContain('extended-cache-ttl-2025-04-11')
  })

  test('adds prompt caching scope beta when request uses cache_control', () => {
    const betaHeader = claudeRelayService._getBetaHeader('claude-opus-4-7', '', {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'cached prompt',
              cache_control: { type: 'ephemeral' }
            }
          ]
        }
      ]
    })

    expect(betaHeader.split(',')).toContain('prompt-caching-scope-2026-01-05')
  })

  test('adds context management beta when request uses context_management', () => {
    const betaHeader = claudeRelayService._getBetaHeader('claude-opus-4-7', '', {
      context_management: { edits: [] },
      messages: []
    })

    expect(betaHeader.split(',')).toContain('context-management-2025-06-27')
  })

  test('adds Claude Code session header from metadata user id when missing', () => {
    const headers = {}

    claudeRelayService._applyClaudeCodeSessionHeaders(headers, {
      metadata: {
        user_id: JSON.stringify({
          device_id: 'device-1',
          account_uuid: '',
          session_id: 'session-123'
        })
      }
    })

    expect(headers['X-Claude-Code-Session-Id']).toBe('session-123')
  })

  test('merges standard Anthropic cache usage fields from delta usage', () => {
    const target = { model: 'claude-opus-4-7' }

    claudeRelayService._mergeClaudeUsageData(target, {
      input_tokens: 77,
      output_tokens: 7,
      cache_creation_input_tokens: 241,
      cache_read_input_tokens: 171248,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 241
      }
    })

    expect(target).toEqual({
      model: 'claude-opus-4-7',
      input_tokens: 77,
      output_tokens: 7,
      cache_creation_input_tokens: 241,
      cache_read_input_tokens: 171248,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 241
      }
    })
  })

  test('recognizes modern Claude Code requests by CLI headers when prompt templates change', () => {
    ClaudeCodeValidator.includesClaudeCodeSystemPrompt.mockReturnValueOnce(false)

    const requestBody = {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hello' }]
    }
    const headers = {
      'user-agent': 'Go-http-client/2.0',
      'x-app': 'cli',
      'x-claude-code-session-id': 'session-123',
      'anthropic-beta': 'claude-code-20250219,context-management-2025-06-27'
    }

    expect(claudeRelayService._isActualClaudeCodeRequest(requestBody, headers)).toBe(true)
  })

  test('rebuilds Claude Code user agent when NewAPI replaces it', () => {
    const requestBody = {
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.150.00f; cc_entrypoint=sdk-cli; cch=7ec52;'
        }
      ]
    }

    expect(
      claudeRelayService._resolveClaudeUserAgent(
        { 'user-agent': 'Go-http-client/2.0' },
        requestBody,
        true,
        null
      )
    ).toBe('claude-cli/2.1.150 (external, sdk-cli)')
  })

  test('keeps real Claude Code user agent when present', () => {
    expect(
      claudeRelayService._resolveClaudeUserAgent(
        { 'user-agent': 'claude-cli/2.1.150 (external, cli)' },
        {},
        true,
        null
      )
    ).toBe('claude-cli/2.1.150 (external, cli)')
  })

  test('uses the account-pinned user agent ahead of the legacy unified value', () => {
    expect(
      claudeRelayService._resolveClaudeUserAgent(
        { 'user-agent': 'claude-cli/2.1.150 (external, cli)' },
        {},
        true,
        'claude-cli/2.1.151 (external, cli)',
        'claude-cli/2.2.0 (external, cli, linux, x64)',
        'pinned'
      )
    ).toBe('claude-cli/2.2.0 (external, cli, linux, x64)')
  })

  test('keeps the legacy unified user agent when the account has not been pinned', () => {
    expect(
      claudeRelayService._resolveClaudeUserAgent(
        { 'user-agent': 'claude-cli/2.1.150 (external, cli)' },
        {},
        true,
        'claude-cli/2.1.151 (external, cli)',
        'claude-cli/2.2.0 (external, cli, linux, x64)'
      )
    ).toBe('claude-cli/2.1.151 (external, cli)')
  })
})

describe('Claude relay CC rate-limit policy', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    upstreamErrorHelper.markTempUnavailable.mockResolvedValue({ success: true })
    upstreamErrorHelper.recordErrorHistory.mockResolvedValue(undefined)
    claudeAccountService.getAccount.mockResolvedValue(null)
    unifiedClaudeScheduler.clearSessionMapping.mockResolvedValue(true)
  })

  test('treats 5h-status=allowed as an independent model-family limit', () => {
    const resetTimestamp = Math.floor(Date.now() / 1000) + 6 * 24 * 60 * 60
    expect(
      claudeRelayService._isModelFamilyRateLimit(
        { 'Anthropic-Ratelimit-Unified-5h-Status': 'allowed' },
        resetTimestamp
      )
    ).toBe(true)
  })

  test('does not treat a calendar-boundary reset beyond 7 days as a weekly model cap', () => {
    const resetTimestamp = Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60
    expect(
      claudeRelayService._isModelFamilyRateLimit(
        { 'anthropic-ratelimit-unified-5h-status': 'allowed' },
        resetTimestamp
      )
    ).toBe(false)
    expect(claudeRelayService._isImplausibleWeeklyReset(resetTimestamp)).toBe(true)
    expect(
      claudeRelayService._shouldSkipLongCapRateLimit(
        { 'anthropic-ratelimit-unified-5h-status': 'allowed' },
        resetTimestamp
      )
    ).toBe(true)
  })

  test('does not treat a 429 as a weekly model cap when 5h and 7d windows are still allowed', () => {
    const resetTimestamp = Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60
    expect(
      claudeRelayService._isModelFamilyRateLimit(
        {
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-7d-status': 'allowed'
        },
        resetTimestamp
      )
    ).toBe(false)
    expect(
      claudeRelayService._areUsageWindowsStillAllowed({
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-7d-status': 'allowed'
      })
    ).toBe(true)
  })

  test('treats an explicit non-allowed 5h status as an account-wide limit', () => {
    const resetTimestamp = Math.floor(Date.now() / 1000) + 6 * 24 * 60 * 60
    expect(
      claudeRelayService._isModelFamilyRateLimit(
        { 'anthropic-ratelimit-unified-5h-status': 'rejected' },
        resetTimestamp,
        { error: { message: 'weekly limit reached' } }
      )
    ).toBe(false)
  })

  test('recognizes the internal security monitor as an auxiliary request', () => {
    expect(
      claudeRelayService._isAgentViewAuxiliaryRequest(
        {
          model: 'claude-sonnet-5',
          stream: false,
          max_tokens: 64,
          system: 'You are a security monitor for autonomous AI coding agents.',
          messages: [{ role: 'user', content: '<transcript>sample</transcript>' }],
          stop_sequences: ['</block>']
        },
        { 'user-agent': 'Go-http-client/2.0' }
      )
    ).toBe(true)
  })

  test('does not classify ordinary Sonnet requests as auxiliary', () => {
    expect(
      claudeRelayService._isAgentViewAuxiliaryRequest(
        {
          model: 'claude-sonnet-5',
          stream: false,
          max_tokens: 64,
          system: 'ordinary request',
          messages: [{ role: 'user', content: '<transcript>sample</transcript>' }]
        },
        {}
      )
    ).toBe(false)
  })

  test('reports eligible, limited, nurture-blocked and error pool capacity', async () => {
    redis.getAllClaudeAccounts.mockResolvedValue([
      { isActive: 'true', status: 'active', schedulable: 'true' },
      {
        isActive: 'true',
        status: 'active',
        schedulable: 'false',
        rateLimitStatus: { isRateLimited: true }
      },
      {
        isActive: 'true',
        status: 'active',
        schedulable: 'true',
        nurtureLastBlockReason: 'five_hour_curve'
      },
      { isActive: 'true', status: 'error', schedulable: 'true' }
    ])

    await expect(claudeRelayService.healthCheck()).resolves.toMatchObject({
      healthy: true,
      degraded: true,
      eligibleAccounts: 1,
      schedulableAccounts: 2,
      activeAccounts: 3,
      rateLimitedAccounts: 1,
      nurtureBlockedAccounts: 1,
      errorAccounts: 1,
      totalAccounts: 4
    })
  })

  test('uses weekly error text or a reset beyond the 5h window as model-family evidence', () => {
    const shortReset = Math.floor(Date.now() / 1000) + 60 * 60
    const longReset = Math.floor(Date.now() / 1000) + 6 * 60 * 60

    expect(
      claudeRelayService._isModelFamilyRateLimit({}, shortReset, {
        error: { message: 'Weekly model limit reached' }
      })
    ).toBe(true)
    expect(claudeRelayService._isModelFamilyRateLimit({}, longReset)).toBe(true)
    expect(claudeRelayService._isModelFamilyRateLimit({}, shortReset)).toBe(false)
  })

  test('applies a short cooldown and clears sticky mapping for a headerless 429', async () => {
    await claudeRelayService._applyNoResetRateLimitCooldown(
      'account-1',
      'claude-official',
      'session-1',
      'test'
    )

    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
      'account-1',
      'claude-official',
      429
    )
    expect(unifiedClaudeScheduler.clearSessionMapping).toHaveBeenCalledWith('session-1')
  })

  test('does not alter routing for a headerless 429 when auto-protection is disabled', async () => {
    claudeAccountService.getAccount.mockResolvedValue({
      id: 'account-1',
      name: 'protected-account',
      disableAutoProtection: 'true'
    })

    await expect(
      claudeRelayService._applyNoResetRateLimitCooldown(
        'account-1',
        'claude-official',
        'session-1',
        'test'
      )
    ).resolves.toEqual({ success: true, skipped: true })

    expect(upstreamErrorHelper.markTempUnavailable).not.toHaveBeenCalled()
    expect(unifiedClaudeScheduler.clearSessionMapping).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.recordErrorHistory).toHaveBeenCalledWith(
      'account-1',
      'claude-official',
      429,
      'rate_limit'
    )
  })

  test('tries two alternate shared accounts before surfacing a rate limit', () => {
    const canFailover = (accountFailoverAttempt) =>
      claudeRelayService._shouldFailoverToAnotherSharedAccount(
        429,
        true,
        'claude-official',
        false,
        { accountFailoverAttempt }
      )

    expect(canFailover(0)).toBe(true)
    expect(canFailover(1)).toBe(true)
    expect(canFailover(2)).toBe(false)
    expect(
      claudeRelayService._shouldFailoverToAnotherSharedAccount(429, true, 'claude-official', true, {
        accountFailoverAttempt: 0
      })
    ).toBe(false)
  })

  test('returns a structured retryable 429 after the shared pool is exhausted', () => {
    const response = claudeRelayService._buildRetryableSharedPoolRateLimitResponse('account-3')

    expect(response.statusCode).toBe(429)
    expect(response.headers['Retry-After']).toBe('1')
    expect(JSON.parse(response.body)).toEqual({
      error: {
        type: 'rate_limit_error',
        code: 'crs_rate_limited',
        message:
          'CRS shared account pool is temporarily rate limited; retry another upstream channel.',
        metadata: {
          source: 'claude-relay-service',
          retryable: true,
          disable_channel: false,
          limit_kind: 'shared_pool'
        }
      }
    })
    expect(response.accountId).toBe('account-3')
  })

  test('rewrites shared-pool single-account 403 as retryable 429 so new-api does not disable the channel', () => {
    expect(
      claudeRelayService._shouldRewriteSharedPoolErrorAsRetryable(403, 'claude-official', false)
    ).toBe(true)
    expect(
      claudeRelayService._shouldRewriteSharedPoolErrorAsRetryable(403, 'claude-official', true)
    ).toBe(false)

    const response = claudeRelayService._buildRetryableSharedPoolRateLimitResponse(
      'account-3',
      'shared_pool_forbidden'
    )
    const body = JSON.parse(response.body)

    expect(response.statusCode).toBe(429)
    expect(body.error.code).toBe('crs_rate_limited')
    expect(body.error.metadata.disable_channel).toBe(false)
    expect(body.error.metadata.limit_kind).toBe('shared_pool_forbidden')
  })

  test('rewrites Agent View auxiliary 429 as retryable so new-api does not disable the channel', () => {
    expect(
      claudeRelayService._shouldRewriteSharedPoolErrorAsRetryable(
        429,
        'claude-official',
        false,
        true
      )
    ).toBe(true)

    const response = claudeRelayService._buildRetryableSharedPoolRateLimitResponse(
      'account-3',
      'agent_view_auxiliary'
    )
    const body = JSON.parse(response.body)

    expect(response.statusCode).toBe(429)
    expect(body.error.code).toBe('crs_rate_limited')
    expect(body.error.metadata.disable_channel).toBe(false)
    expect(body.error.metadata.limit_kind).toBe('agent_view_auxiliary')
  })

  test('returns retryable 429 when the shared pool is blocked by nurture limits', () => {
    const response = claudeRelayService._buildNurtureLimitedResponse('account-3', 'seven_day_pace')
    const body = JSON.parse(response.body)

    expect(response.statusCode).toBe(429)
    expect(body.error.code).toBe('crs_rate_limited')
    expect(body.error.metadata).toMatchObject({
      source: 'claude-relay-service',
      retryable: true,
      disable_channel: false,
      limit_kind: 'nurture',
      nurture_reason: 'seven_day_pace'
    })
  })
})
