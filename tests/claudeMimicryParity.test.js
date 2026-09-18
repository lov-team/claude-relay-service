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
  includesClaudeCodeSystemPrompt: jest.fn(() => false)
}))

const claudeRelayService = require('../src/services/relay/claudeRelayService')
const { normalizeDateline, normalizeText } = require('../src/utils/anthropicFingerprint')
const {
  buildBillingAttributionText,
  computeClaudeCodeFingerprint,
  syncBillingHeaderVersion
} = require('../src/utils/claudeBillingFingerprint')
const {
  filterResponseHeaders,
  isResponseHeaderAllowed
} = require('../src/utils/responseHeaderFilter')

describe('anthropicFingerprint dateline normalization', () => {
  test('rewrites steganographic apostrophe + slash separator to canonical ASCII', () => {
    const input = 'Today\u2019s date is 2026/07/01.'
    const { text, hits } = normalizeText(input)
    expect(text).toBe("Today's date is 2026-07-01.")
    expect(hits).toBe(1)
  })

  test('leaves canonical ASCII dateline untouched (hits=0)', () => {
    const input = "Today's date is 2026-07-01."
    const { text, hits } = normalizeText(input)
    expect(text).toBe(input)
    expect(hits).toBe(0)
  })

  test('only rewrites inside <system-reminder> blocks in message content', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content:
            'User prose: Today\u2019s date is 2026/07/01. <system-reminder>Today\u2019s date is 2026/07/01.</system-reminder>'
        }
      ]
    }
    const { body: out, hits } = normalizeDateline(body)
    expect(hits).toBe(1)
    const text = out.messages[0].content
    // outside the tag the fingerprinted sentence is preserved
    expect(text).toContain('Today\u2019s date is 2026/07/01. <system-reminder>')
    expect(text).toContain("<system-reminder>Today's date is 2026-07-01.</system-reminder>")
  })

  test('normalizes system string and system[] text blocks', () => {
    const { body: s1 } = normalizeDateline({ system: 'Today\u2019s date is 2026/07/01.' })
    expect(s1.system).toBe("Today's date is 2026-07-01.")

    const { body: s2 } = normalizeDateline({
      system: [{ type: 'text', text: 'Today\u02bcs date is 2026/07/01.' }]
    })
    expect(s2.system[0].text).toBe("Today's date is 2026-07-01.")
  })

  test('does not touch user prose, code, or tool blocks', () => {
    const body = {
      messages: [
        { role: 'user', content: 'Today\u2019s date is 2026/07/01.' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { c: 'echo Today' } }]
        }
      ]
    }
    const { body: out, hits } = normalizeDateline(body)
    expect(hits).toBe(0)
    expect(out.messages[0].content).toBe('Today\u2019s date is 2026/07/01.')
  })
})

describe('claudeBillingFingerprint', () => {
  const body = {
    messages: [{ role: 'user', content: 'Write a hello world function in Python' }]
  }

  test('computeClaudeCodeFingerprint is deterministic 3-hex', () => {
    const fp = computeClaudeCodeFingerprint(body, '2.1.255')
    expect(fp).toMatch(/^[0-9a-f]{3}$/)
    expect(computeClaudeCodeFingerprint(body, '2.1.255')).toBe(fp)
  })

  test('buildBillingAttributionText emits cc_version=X.Y.Z.{fp}; cc_entrypoint=cli;', () => {
    const text = buildBillingAttributionText(body, '2.1.255')
    expect(text).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.255\.[0-9a-f]{3}; cc_entrypoint=cli;$/
    )
  })

  test('syncBillingHeaderVersion upgrades version and appends fp', () => {
    const inBody = {
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.0.1; cc_entrypoint=cli;'
        }
      ],
      messages: [{ role: 'user', content: 'Write a hello world function in Python' }]
    }
    const out = syncBillingHeaderVersion(inBody, '2.1.255')
    expect(out.system[0].text).toMatch(/cc_version=2\.1\.255\.[0-9a-f]{3}/)
    // original untouched
    expect(inBody.system[0].text).toContain('cc_version=2.0.1;')
  })
})

describe('responseHeaderFilter', () => {
  test('allows semantic headers, strips infra/hop-by-hop', () => {
    const upstream = {
      'content-type': 'application/json',
      'x-request-id': 'req-1',
      'x-ratelimit-remaining-tokens': '123',
      'anthropic-ratelimit-unified-reset': '999',
      'retry-after': '5',
      'cf-ray': 'abc-zzz',
      server: 'cloudflare',
      'x-internal-trace': 't',
      'content-length': '42',
      'transfer-encoding': 'chunked'
    }
    const filtered = filterResponseHeaders(upstream)
    expect(filtered['content-type']).toBe('application/json')
    expect(filtered['x-request-id']).toBe('req-1')
    expect(filtered['x-ratelimit-remaining-tokens']).toBe('123')
    expect(filtered['anthropic-ratelimit-unified-reset']).toBe('999')
    expect(filtered['retry-after']).toBe('5')
    expect(filtered['cf-ray']).toBeUndefined()
    expect(filtered.server).toBeUndefined()
    expect(filtered['x-internal-trace']).toBeUndefined()
    expect(filtered['content-length']).toBeUndefined()
  })

  test('isResponseHeaderAllowed', () => {
    expect(isResponseHeaderAllowed('X-RateLimit-Limit-Tokens')).toBe(true)
    expect(isResponseHeaderAllowed('cf-connecting-ip')).toBe(false)
  })
})

describe('claudeRelayService mimicry parity', () => {
  test('non-CC request gets 3-block system with billing block', () => {
    const body = {
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Write a hello world function in Python' }]
    }
    const processed = claudeRelayService._processRequestBody(body, null, false)
    expect(Array.isArray(processed.system)).toBe(true)
    expect(processed.system.length).toBe(3)
    expect(processed.system[0].text).toMatch(
      /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3}; cc_entrypoint=cli;$/
    )
    expect(processed.system[1].text).toContain('You are Claude Code')
    expect(processed.system[2].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' })
    // original system migrated into messages as user/assistant pair
    expect(processed.messages[0].role).toBe('user')
    expect(processed.messages[0].content[0].text).toContain('You are a helpful assistant.')
    expect(processed.messages[1].role).toBe('assistant')
  })

  test('CLI shape completion: tools/temperature/max_tokens defaults injected', () => {
    const body = {
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'Write a hello world function' }]
    }
    const processed = claudeRelayService._processRequestBody(body, null, false)
    expect(processed.tools).toEqual([])
    expect(processed.temperature).toBe(1)
    expect(processed.max_tokens).toBe(128000)
    expect(processed.tool_choice).toBeUndefined()
  })

  test('context_management auto-added when thinking enabled', () => {
    const body = {
      model: 'claude-sonnet-4-5',
      thinking: { type: 'enabled', budget_tokens: 1000 },
      messages: [{ role: 'user', content: 'Write a hello world function' }]
    }
    const processed = claudeRelayService._processRequestBody(body, null, false)
    expect(processed.context_management).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }]
    })
  })

  test('real CC request keeps its own system and gets fp-aware billing sync', () => {
    const body = {
      model: 'claude-sonnet-4-5',
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.0.1; cc_entrypoint=cli;'
        },
        { type: 'text', text: 'You are Claude Code, Anthropic official CLI for Claude.' }
      ],
      messages: [{ role: 'user', content: 'Write a hello world function' }]
    }
    const processed = claudeRelayService._processRequestBody(body, null, true)
    expect(processed.system[0].text).toMatch(/cc_version=2\.1\.255\.[0-9a-f]{3}/)
    expect(processed.system[1].text).toContain('You are Claude Code')
  })

  test('sanitize strips beta-gated fields when token missing', () => {
    const body = {
      context_management: { edits: [] },
      fallbacks: 'default',
      fallback_credit_token: 'tok',
      thinking: { type: 'enabled', block_binding: {} },
      messages: [{ role: 'system', output_config: { effort: 'high' } }]
    }
    const out = claudeRelayService._sanitizeBodyForBetaTokens(body, 'oauth-2025-04-20')
    expect(out.context_management).toBeUndefined()
    expect(out.fallbacks).toBeUndefined()
    expect(out.fallback_credit_token).toBeUndefined()
    expect(out.thinking.block_binding).toBeUndefined()
    expect(out.messages[0].output_config).toBeUndefined()
  })

  test('sanitize keeps fields when beta token present', () => {
    const body = {
      context_management: { edits: [] },
      fallbacks: 'default',
      messages: [{ role: 'system', output_config: { effort: 'high' } }]
    }
    const beta =
      'context-management-2025-06-27,server-side-fallback-2026-07-01,mid-conversation-output-config-2026-07-01'
    const out = claudeRelayService._sanitizeBodyForBetaTokens(body, beta)
    expect(out.context_management).toEqual({ edits: [] })
    expect(out.fallbacks).toBe('default')
    expect(out.messages[0].output_config).toEqual({ effort: 'high' })
  })
})
