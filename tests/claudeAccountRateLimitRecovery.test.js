jest.useFakeTimers()

jest.mock(
  '../config/config',
  () => ({
    claude: {}
  }),
  { virtual: true }
)

jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn(),
  setClaudeAccount: jest.fn(),
  client: {
    hdel: jest.fn()
  }
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  clearTempUnavailable: jest.fn()
}))

const redis = require('../src/models/redis')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const claudeAccountService = require('../src/services/account/claudeAccountService')

describe('claudeAccountService.removeAccountRateLimit', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    redis.client.hdel.mockResolvedValue(1)
    redis.setClaudeAccount.mockResolvedValue(true)
    upstreamErrorHelper.clearTempUnavailable.mockResolvedValue(undefined)
  })

  afterAll(() => {
    jest.useRealTimers()
  })

  test('clears scheduler cooldown when a rate-limited account recovers', async () => {
    redis.getClaudeAccount.mockResolvedValue({
      id: 'account-1',
      name: 'max-account',
      schedulable: 'false',
      rateLimitAutoStopped: 'true',
      rateLimitStatus: 'limited',
      rateLimitEndAt: '2026-07-17T15:00:00.000Z'
    })

    await claudeAccountService.removeAccountRateLimit('account-1')

    expect(redis.setClaudeAccount).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({ schedulable: 'true' })
    )
    expect(upstreamErrorHelper.clearTempUnavailable).toHaveBeenCalledWith(
      'account-1',
      'claude-official'
    )
    expect(upstreamErrorHelper.clearTempUnavailable).toHaveBeenCalledWith('account-1', 'claude')
  })
})
