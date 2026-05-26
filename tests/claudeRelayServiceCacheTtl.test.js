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
  }
}))

jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForStream: jest.fn(),
  getHttpsAgentForNonStream: jest.fn(),
  getPricingData: jest.fn(() => null)
}))

jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({}))
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
const ClaudeCodeValidator = require('../src/validators/clients/claudeCodeValidator')

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

  test('recognizes modern Claude Code requests by headers and metadata when prompt templates change', () => {
    ClaudeCodeValidator.includesClaudeCodeSystemPrompt.mockReturnValueOnce(false)

    const requestBody = {
      model: 'claude-opus-4-7',
      metadata: {
        user_id: JSON.stringify({
          device_id: 'device-1',
          account_uuid: '',
          session_id: '22222222-3333-4444-8555-666666666666'
        })
      },
      messages: [{ role: 'user', content: 'hello' }]
    }
    const headers = {
      'user-agent': 'claude-cli/2.1.150 (external, sdk-cli)',
      'x-app': 'cli',
      'anthropic-beta': 'claude-code-20250219,context-management-2025-06-27',
      'anthropic-version': '2023-06-01'
    }

    expect(claudeRelayService._isActualClaudeCodeRequest(requestBody, headers)).toBe(true)
  })
})
