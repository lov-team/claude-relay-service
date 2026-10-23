// Regression test: temp-unavailable is a *transient* cooldown. A weekly-scale
// upstream retry-after (observed: 443300s ≈ 5.1 days) must never sideline an account
// for days — that key is a separate TTL'd Redis key and the account hash looks clean,
// which made it nearly impossible to diagnose in production.

const mockSetex = jest.fn(async () => 'OK')
const mockSetClaudeAccount = jest.fn(async () => ({}))
const mockDel = jest.fn(async () => 1)
const mockHgetall = jest.fn(async () => ({}))
const mockGet = jest.fn(async () => null)
const mockTtl = jest.fn(async () => -2)

jest.mock('../src/models/redis', () => ({
  setClaudeAccount: (...args) => mockSetClaudeAccount(...args),
  getClientSafe: () => ({
    setex: mockSetex,
    del: mockDel,
    get: mockGet,
    ttl: mockTtl,
    hgetall: mockHgetall,
    zadd: jest.fn(async () => 1),
    expire: jest.fn(async () => 1),
    zremrangebyrank: jest.fn(async () => 1)
  })
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))
jest.mock('../config/config', () => ({ upstreamError: {} }))

const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')

const ACCOUNT = 'acct-1'
const TYPE = 'claude-official'
const ttlPassedToSetex = () => mockSetex.mock.calls[0][1]

describe('markTempUnavailable clamps upstream retry-after', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('clamps a weekly-scale retry-after (5.1 days) to the 30 minute cap when the account is unknown', async () => {
    // 拿不到账户哈希时无法写 fiveHourAutoStopped，退回钳制后的 temp_unavailable
    await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, 443300)
    expect(mockSetex).toHaveBeenCalledTimes(1)
    expect(ttlPassedToSetex()).toBe(1800)
  })

  it('leaves a short, sane retry-after untouched', async () => {
    await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, 600)
    expect(ttlPassedToSetex()).toBe(600)
  })

  it('falls back to the per-error-type default when no retry-after is given', async () => {
    await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, null)
    expect(ttlPassedToSetex()).toBe(300) // DEFAULT_TTL.rate_limit
  })

  it('returns the current temporary cooldown TTL and stored recovery time', async () => {
    mockTtl.mockResolvedValue(17)
    mockGet.mockResolvedValue(JSON.stringify({ expiresAt: '2026-09-01T00:00:17.000Z' }))

    await expect(upstreamErrorHelper.getTempUnavailableInfo(ACCOUNT, TYPE)).resolves.toEqual({
      remainingSeconds: 17,
      expiresAt: '2026-09-01T00:00:17.000Z'
    })
  })

  it('builds an upstream-safe retry response with Retry-After metadata', () => {
    const response = upstreamErrorHelper.buildTempUnavailableHttpResponse({
      retryAfterSeconds: 7,
      temporaryUnavailableUntil: '2026-09-01T00:00:07.000Z'
    })

    expect(response.statusCode).toBe(429)
    expect(response.headers['Retry-After']).toBe('7')
    const body = JSON.parse(response.body)
    expect(body.error.type).toBe('rate_limit_error')
    expect(body.error.metadata).toEqual(
      expect.objectContaining({
        retryable: true,
        disable_channel: false,
        retry_after_seconds: 7,
        retry_at: '2026-09-01T00:00:07.000Z'
      })
    )
  })
})

describe('long upstream cooldown (>1h) marks account unschedulable', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockHgetall.mockResolvedValue({ name: 'acct-1', schedulable: 'true' })
  })
  afterEach(() => {
    mockHgetall.mockResolvedValue({})
  })

  it('stops scheduling instead of writing a temp_unavailable key', async () => {
    const result = await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, 360117)
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        skipped: true,
        reason: 'long_cooldown_unschedulable'
      })
    )
    const update = mockSetClaudeAccount.mock.calls[0][1]
    expect(update).toEqual(
      expect.objectContaining({
        schedulable: 'false',
        fiveHourAutoStopped: 'true',
        stoppedReason: '5小时使用量接近限制，已自动停止调度'
      })
    )
    // 精准恢复：窗口结束被推进到冷却结束时刻，恢复任务据此到期拉起
    expect(Date.parse(update.sessionWindowEnd)).toBeGreaterThanOrEqual(
      Date.now() + 360117 * 1000 - 5000
    )
    expect(mockSetex).not.toHaveBeenCalled()
  })

  it('keeps a later existing window end and never moves it backwards', async () => {
    const futureEnd = new Date(Date.now() + 200 * 3600 * 1000).toISOString() // 比 360117s(~100h) 更晚
    mockHgetall.mockResolvedValue({
      name: 'acct-1',
      schedulable: 'true',
      sessionWindowStart: '2026-09-01T00:00:00.000Z',
      sessionWindowEnd: futureEnd
    })
    await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, 360117)
    const update = mockSetClaudeAccount.mock.calls[0][1]
    expect(update.sessionWindowEnd).toBeUndefined()
    expect(update.schedulable).toBe('false')
  })

  it('respects the account-level auto-protection opt-out', async () => {
    mockHgetall.mockResolvedValue({ name: 'acct-1', disableAutoProtection: 'true' })
    const result = await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, 360117)
    expect(result.ttlSeconds).toBe(1800)
    expect(mockSetClaudeAccount).not.toHaveBeenCalled()
    expect(mockSetex).toHaveBeenCalledTimes(1)
  })

  it('leaves non-claude account types on the clamped cooldown path', async () => {
    await upstreamErrorHelper.markTempUnavailable(ACCOUNT, 'azure-openai', 429, 360117)
    expect(mockSetClaudeAccount).not.toHaveBeenCalled()
    expect(ttlPassedToSetex()).toBe(1800)
  })

  it('keeps a retry-after just under the threshold on the cooldown path', async () => {
    await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, 3599)
    expect(mockSetClaudeAccount).not.toHaveBeenCalled()
    expect(ttlPassedToSetex()).toBe(1800)
  })

  it('is a no-op for an already auto-stopped account', async () => {
    mockHgetall.mockResolvedValue({
      name: 'acct-1',
      schedulable: 'false',
      fiveHourAutoStopped: 'true'
    })
    const result = await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, 360117)
    expect(result.reason).toBe('long_cooldown_unschedulable')
    expect(mockSetClaudeAccount).not.toHaveBeenCalled()
    expect(mockSetex).not.toHaveBeenCalled()
  })
})

describe('nurture-aware upstream 429 temporary cooldown', () => {
  const { cloneDefaultConfig } = require('../src/utils/accountNurtureDefaults')
  const configService = require('../src/services/accountNurtureConfigService')
  let configSpy
  beforeEach(() => {
    jest.clearAllMocks()
    configSpy = jest.spyOn(configService, 'getConfig').mockResolvedValue(cloneDefaultConfig())
    mockHgetall.mockResolvedValue({
      nurtureEnabled: 'true',
      nurtureTier: 'max20x',
      nurtureDayIndex: '1'
    })
  })
  afterEach(() => {
    configSpy.mockRestore()
    mockHgetall.mockResolvedValue({})
  })

  test('uses the tier day cooldown and persists matching expiry metadata', async () => {
    const before = Date.now()
    const result = await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429)
    expect(result.ttlSeconds).toBe(1800)
    const record = JSON.parse(mockSetex.mock.calls[0][2])
    expect(record.cooldownSeconds).toBe(1800)
    expect(Date.parse(record.expiresAt)).toBeGreaterThanOrEqual(before + 1800000)
  })

  test('steady cooldown can be shorter than the original 5-minute fallback', async () => {
    mockHgetall.mockResolvedValue({
      nurtureEnabled: true,
      nurtureTier: 'max20x',
      nurturePhase: 'steady'
    })
    await upstreamErrorHelper.markTempUnavailable(ACCOUNT, 'claude', 429)
    expect(ttlPassedToSetex()).toBe(300)
  })

  test('retains a longer upstream Retry-After and the transient weekly TTL cap', async () => {
    mockHgetall.mockResolvedValue({
      nurtureEnabled: true,
      nurtureTier: 'max20x',
      nurturePhase: 'steady'
    })
    expect(
      (await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, 600)).ttlSeconds
    ).toBe(600)
    // 周级冷却（>1h）不再落在 temp_unavailable：账号直接转为不可调度
    const longCooldown = await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, 443300)
    expect(longCooldown.reason).toBe('long_cooldown_unschedulable')
    expect(mockSetClaudeAccount).toHaveBeenCalledWith(
      ACCOUNT,
      expect.objectContaining({ schedulable: 'false', fiveHourAutoStopped: 'true' })
    )
  })

  test('uses the configured Pro early-day cooldown', async () => {
    mockHgetall.mockResolvedValue({
      nurtureEnabled: true,
      nurtureTier: 'pro',
      nurtureDayIndex: '1'
    })
    expect((await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429)).ttlSeconds).toBe(
      3600
    )
  })

  test('keeps other errors, other platforms and disabled accounts on existing behavior', async () => {
    expect((await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 503)).ttlSeconds).toBe(60)
    expect((await upstreamErrorHelper.markTempUnavailable(ACCOUNT, 'openai', 429)).ttlSeconds).toBe(
      300
    )
    mockHgetall.mockResolvedValue({ nurtureEnabled: false, nurtureTier: 'max20x' })
    expect((await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429)).ttlSeconds).toBe(300)
    mockHgetall.mockResolvedValue({
      nurtureEnabled: true,
      nurtureTier: 'max20x',
      disableTempUnavailable: 'true'
    })
    expect((await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429)).skipped).toBe(true)
  })
})
