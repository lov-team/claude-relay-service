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
  client: { get: jest.fn(), setex: jest.fn(), expire: jest.fn(), del: jest.fn() },
  getClientSafe: jest.fn(() => ({ set: jest.fn(), del: jest.fn() })),
  getClaudeAccount: jest.fn(() => ({})),
  deleteSessionAccountMapping: jest.fn()
}))

jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForStream: jest.fn(),
  getHttpsAgentForNonStream: jest.fn(),
  getPricingData: jest.fn(() => null)
}))

jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({
  getAccount: jest.fn(() => Promise.resolve(null)),
  fetchOAuthUsage: jest.fn(),
  updateClaudeUsageSnapshot: jest.fn()
}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  clearSessionMapping: jest.fn(() => Promise.resolve()),
  markAccountRateLimited: jest.fn(() => Promise.resolve({ success: true }))
}))
jest.mock('../src/services/claudeCodeHeadersService', () => ({}))
jest.mock('../src/services/userMessageQueueService', () => ({}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(() => Promise.resolve({ success: true })),
  recordErrorHistory: jest.fn(),
  parseRetryAfter: jest.fn(() => null)
}))

const claudeRelayService = require('../src/services/relay/claudeRelayService')
const claudeAccountService = require('../src/services/account/claudeAccountService')
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

const ACCOUNT_ID = 'acct-usage-cap'
const FUTURE_ISO = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
const FUTURE_SECONDS = Math.floor(Date.parse(FUTURE_ISO) / 1000)

describe('non-quota 429 usage-cap fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('marks account rate limited when OAuth usage shows 5h window exhausted', async () => {
    claudeAccountService.fetchOAuthUsage.mockResolvedValue({
      five_hour: { utilization: 100, resets_at: FUTURE_ISO },
      seven_day: { utilization: 50, resets_at: FUTURE_ISO }
    })

    const result = await claudeRelayService._applyNonQuotaRateLimitCooldown(
      ACCOUNT_ID,
      'claude-official',
      'session-x',
      'Non-quota 429',
      {}
    )

    expect(result.usageCapConfirmed).toBe(true)
    expect(unifiedClaudeScheduler.markAccountRateLimited).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'claude-official',
      'session-x',
      FUTURE_SECONDS
    )
  })

  test('falls back to 7d window when 5h is not exhausted', async () => {
    claudeAccountService.fetchOAuthUsage.mockResolvedValue({
      five_hour: { utilization: 40, resets_at: FUTURE_ISO },
      seven_day: { utilization: 100, resets_at: FUTURE_ISO }
    })

    const result = await claudeRelayService._applyNonQuotaRateLimitCooldown(
      ACCOUNT_ID,
      'claude-official',
      null,
      'Non-quota stream 429',
      {}
    )

    expect(result.usageCapConfirmed).toBe(true)
    expect(unifiedClaudeScheduler.markAccountRateLimited).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'claude-official',
      null,
      FUTURE_SECONDS
    )
  })

  test('keeps short cooldown when no window is exhausted', async () => {
    claudeAccountService.fetchOAuthUsage.mockResolvedValue({
      five_hour: { utilization: 60, resets_at: FUTURE_ISO },
      seven_day: { utilization: 70, resets_at: FUTURE_ISO }
    })

    const result = await claudeRelayService._applyNonQuotaRateLimitCooldown(
      ACCOUNT_ID,
      'claude-official',
      null,
      'Non-quota 429',
      {}
    )

    expect(result.usageCapConfirmed).not.toBe(true)
    expect(unifiedClaudeScheduler.markAccountRateLimited).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'claude-official',
      429
    )
  })

  test('keeps short cooldown when usage fetch fails', async () => {
    claudeAccountService.fetchOAuthUsage.mockRejectedValue(new Error('network'))

    const result = await claudeRelayService._applyNonQuotaRateLimitCooldown(
      ACCOUNT_ID,
      'claude-official',
      null,
      'Non-quota 429',
      {}
    )

    expect(result.usageCapConfirmed).not.toBe(true)
    expect(unifiedClaudeScheduler.markAccountRateLimited).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalled()
  })

  test('skips usage check entirely for non-official account types', async () => {
    await claudeRelayService._applyNonQuotaRateLimitCooldown(
      ACCOUNT_ID,
      'claude-console',
      null,
      'Non-quota 429',
      {}
    )

    expect(claudeAccountService.fetchOAuthUsage).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'claude-console',
      429
    )
  })
})
