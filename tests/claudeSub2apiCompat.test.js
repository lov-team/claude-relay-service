jest.mock('../config/config', () => ({
  claude: {
    apiVersion: '2023-06-01',
    betaHeader: '',
    systemPrompt: '',
    codeVersion: '',
    autoSyncCodeVersion: true,
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

const mockRedisStore = new Map()
const mockRedisClient = {
  get: jest.fn(async (key) => mockRedisStore.get(key) || null),
  set: jest.fn(async (key, val) => {
    mockRedisStore.set(key, val)
    return 'OK'
  }),
  setex: jest.fn(),
  expire: jest.fn(),
  del: jest.fn(),
  pipeline: jest.fn(() => ({
    zadd: jest.fn().mockReturnThis(),
    hset: jest.fn().mockReturnThis(),
    zremrangebyrank: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([])
  })),
  zrevrange: jest.fn().mockResolvedValue([]),
  hget: jest.fn().mockResolvedValue(null),
  hmget: jest.fn().mockResolvedValue([])
}

jest.mock('../src/models/redis', () => ({
  client: mockRedisClient,
  getClientSafe: jest.fn(() => mockRedisClient),
  getClaudeAccount: jest.fn(() => ({})),
  deleteSessionAccountMapping: jest.fn()
}))

jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForStream: jest.fn(),
  getHttpsAgentForNonStream: jest.fn(),
  getPricingData: jest.fn(() => null),
  getCachedConfig: jest.fn(() => null),
  setCachedConfig: jest.fn(),
  deleteCachedConfig: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({
  getAccount: jest.fn(() => Promise.resolve(null))
}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  clearSessionMapping: jest.fn(() => Promise.resolve())
}))
jest.mock('../src/services/claudeCodeHeadersService', () => ({}))
jest.mock('../src/services/userMessageQueueService', () => ({}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(() => Promise.resolve({ success: true })),
  recordErrorHistory: jest.fn(),
  parseRetryAfter: jest.fn(() => null)
}))
jest.mock('axios', () => ({
  get: jest.fn()
}))

const axios = require('axios')
const claudeRelayService = require('../src/services/relay/claudeRelayService')
const { createClaudeTestPayload } = require('../src/utils/testPayloadHelper')
const {
  CLAUDE_CODE_COMPACT_PREAMBLE,
  OPENCODE_SYSTEM_SENTENCE,
  CLAUDE_CODE_SYSTEM_SENTENCE,
  rejectsTemperature,
  adaptClaude55Thinking,
  sanitizeOpenCodeSystemPrompt,
  isClaudeCodeCompactionRequest
} = require('../src/utils/claudeRequestCompat')
const userAgentPoolService = require('../src/services/userAgentPoolService')
const claudeCodeVersionSyncService = require('../src/services/claudeCodeVersionSyncService')

describe('sub2api Claude compat transforms & version sync', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRedisStore.clear()
    userAgentPoolService.syncedVersion = null
  })

  afterEach(() => {
    claudeCodeVersionSyncService.stop()
  })

  test('downgrades compaction requests from 1h cache TTL to 5m while keeping ordinary 1h requests', () => {
    const compactBody = {
      model: 'claude-sonnet-4-6',
      tools: [
        {
          name: 'Bash',
          description: 'Run bash',
          input_schema: { type: 'object' },
          cache_control: { type: 'ephemeral', ttl: '1h' }
        }
      ],
      system: [
        {
          type: 'text',
          text: CLAUDE_CODE_SYSTEM_SENTENCE,
          cache_control: { type: 'ephemeral', ttl: '1h' }
        }
      ],
      messages: [
        { role: 'user', content: 'early turn' },
        { role: 'assistant', content: 'ok' },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' },
            {
              type: 'text',
              text: `${CLAUDE_CODE_COMPACT_PREAMBLE}Summarize the conversation.`,
              cache_control: { type: 'ephemeral', ttl: '1h' }
            }
          ]
        }
      ]
    }

    expect(isClaudeCodeCompactionRequest(compactBody)).toBe(true)
    const processedCompact = claudeRelayService._processRequestBody(compactBody, null, true)
    expect(processedCompact.tools[0].cache_control.ttl).toBe('5m')
    expect(processedCompact.system[0].cache_control.ttl).toBe('5m')
    expect(processedCompact.messages[2].content[1].cache_control.ttl).toBe('5m')
    expect(claudeRelayService._hasExtendedCacheTtl(processedCompact)).toBe(false)

    const ordinaryBody = {
      model: 'claude-sonnet-4-6',
      system: [
        {
          type: 'text',
          text: CLAUDE_CODE_SYSTEM_SENTENCE,
          cache_control: { type: 'ephemeral', ttl: '1h' }
        }
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Please summarize this PR diff',
              cache_control: { type: 'ephemeral', ttl: '1h' }
            }
          ]
        }
      ]
    }
    expect(isClaudeCodeCompactionRequest(ordinaryBody)).toBe(false)
    const processedOrdinary = claudeRelayService._processRequestBody(ordinaryBody, null, true)
    expect(processedOrdinary.system[0].cache_control.ttl).toBe('1h')
    expect(processedOrdinary.messages[0].content[0].cache_control.ttl).toBe('1h')
    expect(claudeRelayService._hasExtendedCacheTtl(processedOrdinary)).toBe(true)
  })

  test('strips temperature on Opus 4.7/4.8, 5.5, and Fable/Mythos 5.2 while keeping it on 4.6', () => {
    const rejectingModels = [
      'claude-opus-4-7',
      'us.anthropic.claude-opus-4-8-20260101',
      'claude-opus-5.5',
      'claude-fable-5-2',
      'claude-mythos-5-2'
    ]
    for (const model of rejectingModels) {
      expect(rejectsTemperature(model)).toBe(true)
      const realProcessed = claudeRelayService._processRequestBody(
        {
          model,
          temperature: 0.7,
          messages: [{ role: 'user', content: 'hi' }]
        },
        null,
        true
      )
      expect(realProcessed.temperature).toBeUndefined()

      const mimicProcessed = claudeRelayService._processRequestBody(
        {
          model,
          messages: [{ role: 'user', content: 'hi' }]
        },
        null,
        false
      )
      expect(mimicProcessed.temperature).toBeUndefined()

      expect(createClaudeTestPayload(model).temperature).toBeUndefined()
    }

    for (const allowedModel of ['claude-opus-4-6', 'claude-sonnet-4-6']) {
      expect(rejectsTemperature(allowedModel)).toBe(false)
      const mimicProcessed = claudeRelayService._processRequestBody(
        {
          model: allowedModel,
          messages: [{ role: 'user', content: 'hi' }]
        },
        null,
        false
      )
      expect(mimicProcessed.temperature).toBe(1)
      expect(createClaudeTestPayload(allowedModel).temperature).toBe(1)
    }
  })

  test('adapts Claude 5.5/5.2 thinking modes safely', () => {
    const enabledBody = adaptClaude55Thinking({
      model: 'claude-opus-5.5',
      thinking: { type: 'enabled', budget_tokens: 4096 }
    })
    expect(enabledBody.thinking).toEqual({ type: 'adaptive' })

    const sonnetDisabledBody = adaptClaude55Thinking({
      model: 'claude-sonnet-5-5',
      thinking: { type: 'disabled' }
    })
    expect(sonnetDisabledBody.thinking).toEqual({ type: 'between_tools' })

    const processed = claudeRelayService._processRequestBody(
      {
        model: 'claude-opus-5-5',
        thinking: { type: 'enabled', budget_tokens: 8000 },
        messages: [{ role: 'user', content: 'hi' }]
      },
      null,
      false
    )
    expect(processed.thinking).toEqual({ type: 'adaptive' })
    expect(processed.context_management).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }]
    })
  })

  test('scrubs only the fixed OpenCode identity sentence in system prompt without touching user prose', () => {
    const body = {
      model: 'claude-sonnet-4-6',
      system: [{ type: 'text', text: `${OPENCODE_SYSTEM_SENTENCE}\nKeep responses concise.` }],
      messages: [
        {
          role: 'user',
          content: `Explain "${OPENCODE_SYSTEM_SENTENCE}" in code.`
        }
      ]
    }

    sanitizeOpenCodeSystemPrompt(body)
    expect(body.system[0].text).toBe(`${CLAUDE_CODE_SYSTEM_SENTENCE}\nKeep responses concise.`)
    expect(body.messages[0].content).toBe(`Explain "${OPENCODE_SYSTEM_SENTENCE}" in code.`)
  })

  test('claudeCodeVersionSyncService advances monotonically on stable releases and skips prereleases/downgrades', async () => {
    axios.get.mockResolvedValueOnce({
      data: [
        { tag_name: 'v2.9.99-beta.1', draft: false, prerelease: true },
        { tag_name: 'v2.1.320', draft: false, prerelease: false },
        { tag_name: 'v2.1.335', draft: false, prerelease: false },
        { tag_name: 'v9.9.9', draft: true, prerelease: false }
      ]
    })

    const first = await claudeCodeVersionSyncService.runOnce()
    expect(first).toBe('2.1.335')
    expect(userAgentPoolService.getEffectiveMinClaudeCodeVersion()).toBe('2.1.335')
    expect(userAgentPoolService.getDefaultClaudeUserAgent()).toBe(
      'claude-cli/2.1.335 (external, cli)'
    )
    expect(
      userAgentPoolService.normalizeClaudeCodeUserAgent('claude-cli/2.1.255 (external, cli)')
    ).toBe('claude-cli/2.1.335 (external, cli)')

    // Subsequent response returning an older tag must NOT downgrade stored synced version
    axios.get.mockResolvedValueOnce({
      data: [{ tag_name: 'v2.1.325', draft: false, prerelease: false }]
    })

    const second = await claudeCodeVersionSyncService.runOnce()
    expect(second).toBe('2.1.335')
    expect(userAgentPoolService.getEffectiveMinClaudeCodeVersion()).toBe('2.1.335')
  })
})
