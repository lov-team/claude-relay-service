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
  clearClaudeAccountRateLimitAtomic: jest.fn(),
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
    jest.setSystemTime(new Date('2026-07-29T00:00:00.000Z'))
    redis.client.hdel.mockResolvedValue(1)
    redis.setClaudeAccount.mockResolvedValue(true)
    redis.clearClaudeAccountRateLimitAtomic.mockResolvedValue({
      status: 1,
      currentStatus: 'active'
    })
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

    expect(redis.clearClaudeAccountRateLimitAtomic).toHaveBeenCalledWith('account-1')
    expect(redis.setClaudeAccount).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.clearTempUnavailable).toHaveBeenCalledWith(
      'account-1',
      'claude-official'
    )
    expect(upstreamErrorHelper.clearTempUnavailable).toHaveBeenCalledWith('account-1', 'claude')
  })

  test('keeps an active cooldown when an in-flight request succeeds', async () => {
    redis.getClaudeAccount.mockResolvedValue({
      id: 'account-1',
      name: 'max-account',
      schedulable: 'false',
      rateLimitAutoStopped: 'true',
      rateLimitStatus: 'limited',
      rateLimitedAt: '2026-07-28T23:59:00.000Z',
      rateLimitEndAt: '2026-07-29T05:00:00.000Z'
    })

    const result = await claudeAccountService.removeAccountRateLimit('account-1')

    expect(result).toEqual({
      success: true,
      cleared: false,
      reason: 'cooldown_active',
      rateLimitEndAt: '2026-07-29T05:00:00.000Z'
    })
    expect(redis.clearClaudeAccountRateLimitAtomic).not.toHaveBeenCalled()
    expect(redis.setClaudeAccount).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.clearTempUnavailable).not.toHaveBeenCalled()
  })

  test('allows an explicit force clear before the cooldown expires', async () => {
    redis.getClaudeAccount.mockResolvedValue({
      id: 'account-1',
      name: 'max-account',
      schedulable: 'false',
      rateLimitAutoStopped: 'true',
      rateLimitStatus: 'limited',
      rateLimitedAt: '2026-07-28T23:59:00.000Z',
      rateLimitEndAt: '2026-07-29T05:00:00.000Z'
    })

    const result = await claudeAccountService.removeAccountRateLimit('account-1', { force: true })

    expect(result).toEqual({ success: true, cleared: true })
    expect(redis.clearClaudeAccountRateLimitAtomic).toHaveBeenCalledWith('account-1')
    expect(redis.setClaudeAccount).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.clearTempUnavailable).toHaveBeenCalledTimes(2)
  })

  test('keeps the legacy one-hour cooldown when rateLimitEndAt is missing', async () => {
    redis.getClaudeAccount.mockResolvedValue({
      id: 'account-1',
      name: 'max-account',
      schedulable: 'false',
      rateLimitAutoStopped: 'true',
      rateLimitStatus: 'limited',
      rateLimitedAt: '2026-07-28T23:30:00.000Z'
    })

    const result = await claudeAccountService.removeAccountRateLimit('account-1')

    expect(result).toEqual({
      success: true,
      cleared: false,
      reason: 'cooldown_active',
      rateLimitEndAt: '2026-07-29T00:30:00.000Z'
    })
    expect(redis.clearClaudeAccountRateLimitAtomic).not.toHaveBeenCalled()
    expect(upstreamErrorHelper.clearTempUnavailable).not.toHaveBeenCalled()
  })

  test('clears rate-limit metadata without re-enabling a permanently disabled account', async () => {
    redis.getClaudeAccount.mockResolvedValue({
      id: 'account-1',
      name: 'max-account',
      status: 'unauthorized',
      schedulable: 'false',
      rateLimitAutoStopped: 'true',
      rateLimitEndAt: '2026-07-17T15:00:00.000Z'
    })
    redis.clearClaudeAccountRateLimitAtomic.mockResolvedValue({
      status: 2,
      currentStatus: 'unauthorized'
    })

    await expect(claudeAccountService.removeAccountRateLimit('account-1')).resolves.toEqual({
      success: true,
      cleared: true
    })

    expect(redis.clearClaudeAccountRateLimitAtomic).toHaveBeenCalledWith('account-1')
    expect(redis.setClaudeAccount).not.toHaveBeenCalled()
  })
})

describe('nurture cooldown and authoritative reset times', () => {
  let configSpy
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-07-29T00:00:00Z'))
    configSpy = jest
      .spyOn(require('../src/services/accountNurtureConfigService'), 'getConfig')
      .mockResolvedValue(require('../src/utils/accountNurtureDefaults').cloneDefaultConfig())
  })
  afterEach(() => {
    configSpy.mockRestore()
    jest.useRealTimers()
  })

  test('waits for the later of nurture cooldown and quota reset', async () => {
    const account = { nurtureEnabled: 'true', nurtureTier: 'max20x', nurtureDayIndex: '1' }
    const now = Date.now() / 1000
    expect(await claudeAccountService._getNurtureRateLimitEndAt(account, now + 60)).toBe(
      '2026-07-29T00:30:00.000Z'
    )
    expect(await claudeAccountService._getNurtureRateLimitEndAt(account, now + 7 * 86400)).toBe(
      '2026-08-05T00:00:00.000Z'
    )
    expect(
      await claudeAccountService._getNurtureRateLimitEndAt(
        { ...account, nurturePhase: 'steady' },
        now + 10
      )
    ).toBe('2026-07-29T00:05:00.000Z')
    expect(
      await claudeAccountService._getNurtureRateLimitEndAt(
        { ...account, nurtureEnabled: false },
        now + 60
      )
    ).toBe('2026-07-29T00:01:00.000Z')
  })

  test('model family limit uses its own cooldown without stopping the whole account', async () => {
    jest.clearAllMocks()
    redis.getClaudeAccount.mockResolvedValue({
      id: 'model-account',
      nurtureEnabled: true,
      nurtureTier: 'max20x',
      nurturePhase: 'steady'
    })
    await claudeAccountService.markAccountModelRateLimited(
      'model-account',
      'opus',
      Date.now() / 1000 + 10
    )
    expect(redis.setClaudeAccount.mock.calls[0][1]).toEqual(
      expect.objectContaining({ opusRateLimitEndAt: '2026-07-29T00:05:00.000Z' })
    )
    expect(redis.setClaudeAccount.mock.calls[0][1].schedulable).toBeUndefined()
  })
})
