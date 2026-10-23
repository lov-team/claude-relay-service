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
  buildRelayGeneratedUserId: jest.fn(() => 'relay-user')
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

describe('Claude relay request sanitization', () => {
  test('drops unsigned thinking blocks and keeps signed ones', () => {
    const body = {
      model: 'claude-sonnet-5-5',
      max_tokens: 128,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'no signature' },
            { type: 'thinking', thinking: 'kept', signature: 'sig_ok' },
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'text', text: 'answer' },
            { type: 'tool_use', id: 'toolu_ok', name: 'Read', input: {} }
          ]
        }
      ]
    }

    const processed = claudeRelayService._processRequestBody(body, null, true)
    const { content } = processed.messages[1]

    expect(content).toEqual([
      { type: 'thinking', thinking: 'kept', signature: 'sig_ok' },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'toolu_ok', name: 'Read', input: {} }
    ])
    expect(body.messages[1].content).toHaveLength(5)
  })

  test('replaces an assistant message that only contained unsigned thinking', () => {
    const processed = claudeRelayService._processRequestBody(
      {
        model: 'claude-opus-5-5',
        max_tokens: 32,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'only this', signature: '   ' }]
          }
        ]
      },
      null,
      true
    )

    expect(processed.messages[0].content).toEqual([
      { type: 'text', text: '[unsigned thinking omitted]' }
    ])
  })

  test('rewrites illegal tool ids on both tool_use and tool_result', () => {
    const processed = claudeRelayService._processRequestBody(
      {
        model: 'claude-sonnet-5-5',
        max_tokens: 32,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'call.abc+def', name: 'Bash', input: {} },
              { type: 'tool_use', id: 'call_abc_def', name: 'Read', input: {} },
              { type: 'tool_use', id: 'toolu_ok', name: 'Grep', input: {} }
            ]
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call.abc+def', content: 'done' },
              { type: 'tool_result', tool_use_id: 'call_abc_def', content: 'done' },
              { type: 'tool_result', tool_use_id: 'toolu_ok', content: 'done' },
              { type: 'tool_result', tool_use_id: 'orphan.id/1', content: 'x' }
            ]
          }
        ]
      },
      null,
      true
    )

    const assistant = processed.messages[0].content
    const user = processed.messages[1].content
    expect(assistant[0].id).toBe('call_abc_def_2')
    expect(assistant[1].id).toBe('call_abc_def')
    expect(assistant[2].id).toBe('toolu_ok')
    expect(user.map((block) => block.tool_use_id)).toEqual([
      'call_abc_def_2',
      'call_abc_def',
      'toolu_ok',
      'orphan_id_1'
    ])
  })
})
