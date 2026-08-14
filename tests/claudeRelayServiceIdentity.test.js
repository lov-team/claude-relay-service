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
  getClientSafe: jest.fn(() => ({
    set: jest.fn()
  })),
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
jest.mock('../src/services/userMessageQueueService', () => ({}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(),
  recordErrorHistory: jest.fn()
}))
jest.mock('../src/validators/clients/claudeCodeValidator', () => ({
  includesClaudeCodeSystemPrompt: jest.fn(() => false)
}))

const claudeRelayService = require('../src/services/relay/claudeRelayService')

const ACCOUNT_ID = 'ab5c8254-8e77-4d58-b5ee-a85cfaab7fd8'
const ACCOUNT_UUID = 'afc279d7-aaaa-bbbb-cccc-dddddddddddd'

describe('Claude relay generated identity', () => {
  const account = {
    id: ACCOUNT_ID,
    extInfo: JSON.stringify({ account_uuid: ACCOUNT_UUID, org_uuid: 'org-1' }),
    useUnifiedClientId: 'true',
    unifiedClientId: 'e'.repeat(64)
  }

  it('injects real account_uuid and a conversation-hash session for non-Claude Code requests', () => {
    const body = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'ping' }]
    }

    const first = claudeRelayService._processRequestBody(body, account, false, 'conv-hash-aaa')
    const second = claudeRelayService._processRequestBody(body, account, false, 'conv-hash-aaa')
    const other = claudeRelayService._processRequestBody(body, account, false, 'conv-hash-bbb')

    const firstId = JSON.parse(first.metadata.user_id)
    const secondId = JSON.parse(second.metadata.user_id)
    const otherId = JSON.parse(other.metadata.user_id)

    expect(firstId.account_uuid).toBe(ACCOUNT_UUID)
    expect(firstId.device_id).toBe(account.unifiedClientId)
    expect(firstId.session_id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
    )
    expect(secondId).toEqual(firstId)
    expect(otherId.session_id).not.toBe(firstId.session_id)
  })

  it('fills empty account_uuid when replacing unified client id', () => {
    const body = {
      model: 'claude-opus-4-8',
      max_tokens: 32,
      metadata: {
        user_id: JSON.stringify({
          device_id: 'd'.repeat(64),
          account_uuid: '',
          session_id: 'c72554f2-d198-4fd4-99c8-81e46410a1c5'
        })
      },
      messages: [{ role: 'user', content: 'ping' }]
    }

    const processed = claudeRelayService._processRequestBody(body, account, false)
    const userId = JSON.parse(processed.metadata.user_id)

    expect(userId.device_id).toBe(account.unifiedClientId)
    expect(userId.account_uuid).toBe(ACCOUNT_UUID)
    expect(userId.session_id).toBe('c72554f2-d198-4fd4-99c8-81e46410a1c5')
  })
})
