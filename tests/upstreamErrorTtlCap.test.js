// Regression test: temp-unavailable is a *transient* cooldown. A weekly-scale
// upstream retry-after (observed: 443300s ≈ 5.1 days) must never sideline an account
// for days — that key is a separate TTL'd Redis key and the account hash looks clean,
// which made it nearly impossible to diagnose in production.

const mockSetex = jest.fn(async () => 'OK')
const mockDel = jest.fn(async () => 1)
const mockHgetall = jest.fn(async () => ({}))
const mockGet = jest.fn(async () => null)
const mockTtl = jest.fn(async () => -2)

jest.mock('../src/models/redis', () => ({
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

  it('clamps a weekly-scale retry-after (5.1 days) to the 30 minute cap', async () => {
    await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, 443300)
    expect(mockSetex).toHaveBeenCalledTimes(1)
    expect(ttlPassedToSetex()).toBe(1800)
  })

  it('clamps the other observed value (4.2 days) too', async () => {
    await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, 360117)
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

    expect(response.statusCode).toBe(503)
    expect(response.headers['Retry-After']).toBe('7')
    expect(JSON.parse(response.body).error.metadata).toEqual(
      expect.objectContaining({
        retryable: true,
        disable_channel: false,
        retry_after_seconds: 7,
        retry_at: '2026-09-01T00:00:07.000Z'
      })
    )
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
    expect(
      (await upstreamErrorHelper.markTempUnavailable(ACCOUNT, TYPE, 429, 443300)).ttlSeconds
    ).toBe(1800)
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
