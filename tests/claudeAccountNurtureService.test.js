jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/services/accountNurtureConfigService', () => ({
  getConfig: jest.fn(),
  clearCache: jest.fn()
}))

jest.mock('../src/services/account/claudeAccountService', () => ({
  getAllAccounts: jest.fn(),
  fetchOAuthUsage: jest.fn(),
  updateClaudeUsageSnapshot: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn(),
  setClaudeAccount: jest.fn(),
  getClient: jest.fn(() => null),
  getClientSafe: jest.fn(),
  setAccountLock: jest.fn(),
  releaseAccountLock: jest.fn()
}))

const redis = require('../src/models/redis')
const accountNurtureConfigService = require('../src/services/accountNurtureConfigService')
const claudeAccountService = require('../src/services/account/claudeAccountService')
const {
  WINDOW_MS,
  cloneDefaultConfig,
  MAX_CAP_PERCENT,
  pickInRange
} = require('../src/utils/accountNurtureDefaults')

const claudeAccountNurtureService = require('../src/services/account/claudeAccountNurtureService')
const {
  getNurtureTier,
  isProAccount,
  isMaxAccount,
  NURTURE_SCHEDULER_ERROR_CODES,
  createAllNurtureLimitedError,
  createDedicatedNurtureLimitedError,
  isNurtureSchedulerError,
  buildNurtureLimitBody,
  buildNurtureLimitHttpResponse
} = claudeAccountNurtureService

const FIXED_NOW = Date.parse('2026-07-10T12:00:00.000Z')

/** 计算 resetsAt，使 pace 上限高于给定利用率（避免节奏护栏抢先触发） */
const resetsAtAllowingUtil = (util, steadySevenDayCap, paceBuffer, nowMs = FIXED_NOW) => {
  const neededProgress = Math.min(1, util / (steadySevenDayCap * paceBuffer) + 0.02)
  const remainingMs = WINDOW_MS * (1 - neededProgress)
  return new Date(nowMs + Math.max(remainingMs, 60 * 60 * 1000)).toISOString()
}

const buildAccount = (overrides = {}) => {
  const config = cloneDefaultConfig()
  const steadySevenDay = config.steadyCaps.pro.sevenDay
  const defaultResetsAt = resetsAtAllowingUtil(80, steadySevenDay, config.paceBuffer)

  return {
    id: 'acc-pro-1',
    nurtureEnabled: 'true',
    nurturePhase: 'steady',
    nurtureTier: 'pro',
    nurtureDayIndex: '3',
    nurtureDailySeed: '2026-07-10',
    nurtureLocalRequestCount: '0',
    claudeFiveHourUtilization: '10',
    claudeSevenDayUtilization: '10',
    claudeSevenDayOpusUtilization: '5',
    claudeSevenDayResetsAt: defaultResetsAt,
    claudeSevenDayOpusResetsAt: defaultResetsAt,
    claudeUsageUpdatedAt: new Date(FIXED_NOW).toISOString(),
    subscriptionInfo: JSON.stringify({ accountType: 'claude_pro', hasClaudePro: true }),
    ...overrides
  }
}

const setupRedisClient = ({ rpmCount = 0, sevenDayBaseline = null } = {}) => {
  const client = {
    zremrangebyscore: jest.fn().mockResolvedValue(0),
    zcard: jest.fn().mockResolvedValue(rpmCount),
    zadd: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(sevenDayBaseline === null ? null : String(sevenDayBaseline)),
    set: jest.fn().mockResolvedValue('OK')
  }
  redis.getClientSafe.mockReturnValue(client)
  redis.getClient.mockReturnValue(client)
}

describe('nurture scheduler error helpers', () => {
  test('creates dedicated and all-account nurture errors with 403', () => {
    const dedicated = createDedicatedNurtureLimitedError('acc-1', { reason: 'seven_day_pace' })
    expect(dedicated.code).toBe(NURTURE_SCHEDULER_ERROR_CODES.DEDICATED_LIMITED)
    expect(dedicated.statusCode).toBe(403)
    expect(dedicated.accountId).toBe('acc-1')
    expect(dedicated.nurtureReason).toBe('seven_day_pace')

    const allLimited = createAllNurtureLimitedError({ reason: 'seven_day_velocity' })
    expect(allLimited.code).toBe(NURTURE_SCHEDULER_ERROR_CODES.ALL_LIMITED)
    expect(allLimited.statusCode).toBe(403)
    expect(allLimited.nurtureReason).toBe('seven_day_velocity')
    expect(isNurtureSchedulerError(dedicated)).toBe(true)
    expect(isNurtureSchedulerError(allLimited)).toBe(true)
    expect(isNurtureSchedulerError(new Error('other'))).toBe(false)
  })

  test('buildNurtureLimitHttpResponse uses 403 and structured body', () => {
    jest.useFakeTimers()
    jest.setSystemTime(Date.parse('2026-07-10T12:00:00.000Z'))

    const response = buildNurtureLimitHttpResponse('seven_day_pace', 403)
    expect(response.statusCode).toBe(403)
    expect(response.headers['Retry-After']).toBeTruthy()

    const body = JSON.parse(response.body)
    expect(body.error.type).toBe('nurture_limit_reached')
    expect(body.error.code).toBe('nurture_limit_reached')
    expect(body.error.reason).toBe('seven_day_pace')
    expect(buildNurtureLimitBody('rpm').error.reason).toBe('rpm')

    jest.useRealTimers()
  })
})

describe('nurture tier helpers', () => {
  test('detects pro and max from subscription info', () => {
    expect(
      isProAccount({ hasClaudePro: true, hasClaudeMax: false, accountType: 'claude_pro' })
    ).toBe(true)
    expect(isMaxAccount({ hasClaudeMax: true, accountType: 'claude_max' })).toBe(true)
    expect(
      getNurtureTier({ subscriptionInfo: JSON.stringify({ accountType: 'claude_pro' }) })
    ).toBe('pro')
    expect(
      getNurtureTier({ subscriptionInfo: JSON.stringify({ accountType: 'claude_max' }) })
    ).toBe('max')
    expect(getNurtureTier({ subscriptionInfo: JSON.stringify({ accountType: 'free' }) })).toBeNull()
  })
})

describe('claudeAccountNurtureService.evaluate', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    jest.setSystemTime(FIXED_NOW)
    accountNurtureConfigService.getConfig.mockResolvedValue(cloneDefaultConfig())
    setupRedisClient()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('inactive when global or account nurture is disabled', async () => {
    accountNurtureConfigService.getConfig.mockResolvedValue({
      ...cloneDefaultConfig(),
      enabled: false
    })
    redis.getClaudeAccount.mockResolvedValue(buildAccount())

    const globalOff = await claudeAccountNurtureService.evaluate('acc-pro-1')
    expect(globalOff.active).toBe(false)
    expect(globalOff.blocked).toBe(false)

    accountNurtureConfigService.getConfig.mockResolvedValue(cloneDefaultConfig())
    redis.getClaudeAccount.mockResolvedValue(buildAccount({ nurtureEnabled: 'false' }))
    const accountOff = await claudeAccountNurtureService.evaluate('acc-pro-1')
    expect(accountOff.active).toBe(false)
  })

  test('inactive for non pro/max accounts', async () => {
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        nurtureTier: '',
        subscriptionInfo: JSON.stringify({ accountType: 'free' })
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1')
    expect(result.active).toBe(false)
    expect(result.blocked).toBe(false)
  })

  test('steady pro allows usage just below permanent caps when pace window is mature', async () => {
    const config = cloneDefaultConfig()
    const sevenDayUtil = config.steadyCaps.pro.sevenDay - 1
    const resetsAt = resetsAtAllowingUtil(
      sevenDayUtil,
      config.steadyCaps.pro.sevenDay,
      config.paceBuffer
    )

    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        claudeFiveHourUtilization: String(config.steadyCaps.pro.fiveHour - 1),
        claudeSevenDayUtilization: String(sevenDayUtil),
        claudeSevenDayOpusUtilization: String(config.steadyCaps.pro.sevenDayOpus - 1),
        claudeSevenDayResetsAt: resetsAt,
        claudeSevenDayOpusResetsAt: resetsAt
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.blocked).toBe(false)
    expect(result.reason).toBeNull()
    expect(result.limits.steadyCaps.fiveHour).toBeLessThan(MAX_CAP_PERCENT)
    expect(result.limits.steadyCaps.sevenDay).toBeLessThan(MAX_CAP_PERCENT)
    expect(result.limits.paceSevenDay).toBeGreaterThan(sevenDayUtil)
  })

  test('steady pro blocks five_hour_steady at permanent cap', async () => {
    const config = cloneDefaultConfig()
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        claudeFiveHourUtilization: String(config.steadyCaps.pro.fiveHour)
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('five_hour_steady')
  })

  test('steady pro blocks seven_day_steady before hitting 90%', async () => {
    const config = cloneDefaultConfig()
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        claudeSevenDayUtilization: String(config.steadyCaps.pro.sevenDay)
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('seven_day_steady')
    expect(config.steadyCaps.pro.sevenDay).toBeLessThan(90)
  })

  test('blocks seven_day_pace when young window would allow too much usage', async () => {
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        nurturePhase: 'nurturing',
        nurtureDayIndex: '7',
        claudeSevenDayUtilization: '30',
        claudeSevenDayResetsAt: new Date(FIXED_NOW + 5 * 24 * 60 * 60 * 1000).toISOString()
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('seven_day_pace')
  })

  test('allows seven_day usage under pace limit in young window', async () => {
    setupRedisClient({ sevenDayBaseline: 18 })
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        claudeSevenDayUtilization: '20',
        claudeSevenDayResetsAt: new Date(FIXED_NOW + 5 * 24 * 60 * 60 * 1000).toISOString()
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.blocked).toBe(false)
    expect(result.actual.dayDelta).toBe(2)
    expect(result.actual.maxDailyDelta).toBeGreaterThan(2)
  })

  test('blocks seven_day_velocity when daily jump exceeds configured delta in nurturing', async () => {
    const config = cloneDefaultConfig()
    const sevenDayUtil = 24
    const baseline = 13
    const resetsAt = new Date(FIXED_NOW + 5 * 24 * 60 * 60 * 1000).toISOString()

    setupRedisClient({ sevenDayBaseline: baseline })
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        nurturePhase: 'nurturing',
        nurtureDayIndex: '3',
        claudeSevenDayUtilization: String(sevenDayUtil),
        claudeSevenDayResetsAt: resetsAt,
        claudeSevenDayOpusResetsAt: resetsAt
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('seven_day_velocity')
    expect(result.actual.dayDelta).toBe(sevenDayUtil - baseline)
    expect(result.actual.dayDelta).toBeGreaterThan(config.maxDailySevenDayDelta.pro)
    expect(sevenDayUtil).toBeLessThan(result.limits.paceSevenDay)
  })

  test('steady allows usage ahead of linear pace when remaining window supports it', async () => {
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        claudeSevenDayUtilization: '30',
        claudeSevenDayResetsAt: new Date(FIXED_NOW + 5 * 24 * 60 * 60 * 1000).toISOString()
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.blocked).toBe(false)
    expect(result.limits.paceSevenDay).toBeGreaterThan(30)
  })

  test('steady blocks seven_day_velocity when daily jump exceeds remaining-time budget', async () => {
    const sevenDayUtil = 75
    const baseline = 65
    const resetsAt = new Date(FIXED_NOW + 24 * 60 * 60 * 1000).toISOString()

    setupRedisClient({ sevenDayBaseline: baseline })
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        claudeSevenDayUtilization: String(sevenDayUtil),
        claudeSevenDayResetsAt: resetsAt,
        claudeSevenDayOpusResetsAt: resetsAt
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('seven_day_velocity')
    expect(result.actual.dayDelta).toBe(10)
    expect(result.actual.maxDailyDelta).toBeLessThan(10)
  })

  test('blocks seven_day_opus steady cap', async () => {
    const config = cloneDefaultConfig()
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        claudeSevenDayOpusUtilization: String(config.steadyCaps.pro.sevenDayOpus)
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('seven_day_opus')
  })

  test('blocks rpm when sliding window is full', async () => {
    setupRedisClient({ rpmCount: 30 })
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        nurturePhase: 'steady'
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('rpm')
  })

  test('nurturing phase blocks five_hour_curve and local_request_count', async () => {
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        nurturePhase: 'nurturing',
        nurtureDayIndex: '1',
        nurtureDailySeed: '2026-07-10',
        claudeFiveHourUtilization: '30',
        claudeSevenDayUtilization: '5',
        nurtureLocalRequestCount: '999'
      })
    )

    const fiveHour = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(fiveHour.blocked).toBe(true)
    expect(fiveHour.reason).toBe('five_hour_curve')

    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        nurturePhase: 'nurturing',
        nurtureDayIndex: '1',
        nurtureDailySeed: '2026-07-10',
        claudeFiveHourUtilization: '5',
        claudeSevenDayUtilization: '5',
        nurtureLocalRequestCount: '999'
      })
    )
    const local = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(local.blocked).toBe(true)
    expect(local.reason).toBe('local_request_count')
  })

  test('max tier steady caps are higher than pro but still below 90%', async () => {
    const config = cloneDefaultConfig()
    const sevenDayUtil = config.steadyCaps.max.sevenDay - 1
    const resetsAt = resetsAtAllowingUtil(
      sevenDayUtil,
      config.steadyCaps.max.sevenDay,
      config.paceBuffer
    )

    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        nurtureTier: 'max',
        subscriptionInfo: JSON.stringify({ accountType: 'claude_max', hasClaudeMax: true }),
        claudeFiveHourUtilization: String(config.steadyCaps.max.fiveHour - 1),
        claudeSevenDayUtilization: String(sevenDayUtil),
        claudeSevenDayResetsAt: resetsAt,
        claudeSevenDayOpusResetsAt: resetsAt
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.blocked).toBe(false)
    expect(result.tier).toBe('max')
    expect(result.limits.steadyCaps.fiveHour).toBeGreaterThan(config.steadyCaps.pro.fiveHour)
    expect(result.limits.steadyCaps.sevenDay).toBeGreaterThan(config.steadyCaps.pro.sevenDay)
    expect(result.limits.steadyCaps.fiveHour).toBeLessThan(MAX_CAP_PERCENT)
    expect(result.limits.steadyCaps.sevenDay).toBeLessThan(MAX_CAP_PERCENT)
    expect(result.limits.steadyCaps.sevenDayOpus).toBeLessThan(MAX_CAP_PERCENT)
  })

  test('subscription tier overrides and repairs a stale stored nurture tier', async () => {
    const config = cloneDefaultConfig()
    setupRedisClient({ rpmCount: config.proDayPlans[1].rpm })
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        nurturePhase: 'nurturing',
        nurtureDayIndex: '2',
        nurtureTier: 'pro',
        nurtureLastBlockReason: 'local_request_count',
        subscriptionInfo: JSON.stringify({
          accountType: 'claude_max',
          hasClaudeMax: true,
          hasClaudePro: false
        })
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })

    expect(result.blocked).toBe(false)
    expect(result.tier).toBe('max')
    expect(result.limits.rpmLimit).toBe(config.maxDayPlans[1].rpm)
    expect(redis.setClaudeAccount).toHaveBeenCalledWith(
      'acc-pro-1',
      expect.objectContaining({
        nurtureTier: 'max',
        nurtureLastBlockReason: ''
      })
    )
  })

  test('incrementRpm records a request in redis when allowed', async () => {
    setupRedisClient({ rpmCount: 0 })
    redis.getClaudeAccount.mockResolvedValue(buildAccount())

    const client = redis.getClientSafe()
    await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true,
      incrementRpm: true
    })

    expect(client.zadd).toHaveBeenCalled()
  })

  test('account steady cap override is honored when enabled', async () => {
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        nurtureOverrideEnabled: 'true',
        nurtureOverrideSteadyCaps: JSON.stringify({ sevenDay: 70 }),
        claudeSevenDayUtilization: '70',
        claudeSevenDayResetsAt: resetsAtAllowingUtil(70, 70, cloneDefaultConfig().paceBuffer)
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('seven_day_steady')
    expect(result.limits.steadyCaps.sevenDay).toBe(70)
    expect(result.limits.steadyCaps.sevenDay).toBeLessThan(MAX_CAP_PERCENT)
  })

  test('invalid steady cap override is ignored without crashing', async () => {
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        nurtureOverrideEnabled: 'true',
        nurtureOverrideSteadyCaps: '{bad json',
        claudeSevenDayUtilization: '10'
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.active).toBe(true)
    expect(result.limits.steadyCaps.sevenDay).toBe(cloneDefaultConfig().steadyCaps.pro.sevenDay)
  })

  test('nurturing phase blocks seven_day_curve before steady cap', async () => {
    const config = cloneDefaultConfig()
    const day1 = config.proDayPlans[0]
    const curveSevenDay = pickInRange(
      day1.sevenDayMin,
      day1.sevenDayMax,
      '2026-07-10',
      'acc-pro-1',
      'sevenDay'
    )

    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        nurturePhase: 'nurturing',
        nurtureDayIndex: '1',
        claudeFiveHourUtilization: '5',
        claudeSevenDayUtilization: String(curveSevenDay),
        claudeSevenDayResetsAt: new Date(FIXED_NOW + 5 * 24 * 60 * 60 * 1000).toISOString()
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('seven_day_curve')
    expect(curveSevenDay).toBeLessThan(config.steadyCaps.pro.sevenDay)
  })

  test('rpm is checked before five_hour and seven_day limits', async () => {
    const config = cloneDefaultConfig()
    setupRedisClient({ rpmCount: config.steadyCaps.pro.rpm })
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        claudeFiveHourUtilization: String(config.steadyCaps.pro.fiveHour),
        claudeSevenDayUtilization: String(config.steadyCaps.pro.sevenDay)
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('rpm')
  })

  test('seven_day_pace takes precedence over velocity when both would block', async () => {
    setupRedisClient({ sevenDayBaseline: 5 })
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        nurturePhase: 'nurturing',
        nurtureDayIndex: '7',
        claudeSevenDayUtilization: '30',
        claudeSevenDayResetsAt: new Date(FIXED_NOW + 5 * 24 * 60 * 60 * 1000).toISOString()
      })
    )

    const result = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('seven_day_pace')
  })

  test('ensureSevenDayBaseline writes redis when baseline is missing', async () => {
    setupRedisClient({ sevenDayBaseline: null })
    redis.getClaudeAccount.mockResolvedValue(buildAccount({ claudeSevenDayUtilization: '12' }))

    await claudeAccountNurtureService.evaluate('acc-pro-1', { skipUsageRefresh: true })

    const client = redis.getClientSafe()
    expect(client.set).toHaveBeenCalledWith(
      expect.stringContaining('nurture:7d:baseline:acc-pro-1:'),
      '12',
      'EX',
      172800
    )
  })

  test('nurturing rpm limit is lower than steady rpm limit', async () => {
    const config = cloneDefaultConfig()
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        nurturePhase: 'nurturing',
        nurtureDayIndex: '1',
        claudeFiveHourUtilization: '5',
        claudeSevenDayUtilization: '5'
      })
    )

    const nurturing = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })
    redis.getClaudeAccount.mockResolvedValue(buildAccount({ nurturePhase: 'steady' }))
    const steady = await claudeAccountNurtureService.evaluate('acc-pro-1', {
      skipUsageRefresh: true
    })

    expect(nurturing.limits.rpmLimit).toBe(config.proDayPlans[0].rpm)
    expect(steady.limits.rpmLimit).toBe(config.steadyCaps.pro.rpm)
    expect(nurturing.limits.rpmLimit).toBeLessThan(steady.limits.rpmLimit)
  })
})

describe('claudeAccountNurtureService lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    accountNurtureConfigService.getConfig.mockResolvedValue(cloneDefaultConfig())
    redis.setClaudeAccount = jest.fn().mockResolvedValue(true)
    redis.getClaudeAccount = jest.fn()
    redis.setAccountLock = jest.fn().mockResolvedValue(true)
    redis.releaseAccountLock = jest.fn().mockResolvedValue(true)
    claudeAccountService.getAllAccounts.mockResolvedValue([{ id: 'acc-1', nurtureEnabled: true }])
  })

  test('recordRequestSuccess increments local count for same utc day', async () => {
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        nurtureLocalCountDate: '2026-07-10',
        nurtureLocalRequestCount: '2'
      })
    )

    jest.useFakeTimers()
    jest.setSystemTime(FIXED_NOW)
    await claudeAccountNurtureService.recordRequestSuccess('acc-pro-1')
    jest.useRealTimers()

    const saved = redis.setClaudeAccount.mock.calls[0][1]
    expect(saved.nurtureLocalRequestCount).toBe('3')
  })

  test('rollover graduates after day 7 and resets counters', async () => {
    redis.getClaudeAccount.mockResolvedValue({
      id: 'acc-1',
      nurtureEnabled: 'true',
      nurturePhase: 'nurturing',
      nurtureDayIndex: '7',
      nurtureStartedAt: new Date(FIXED_NOW).toISOString(),
      nurtureLocalRequestCount: '12'
    })

    jest.useFakeTimers()
    jest.setSystemTime(FIXED_NOW)
    const result = await claudeAccountNurtureService.rolloverDayIndexes()
    jest.useRealTimers()

    expect(result.graduated).toBe(1)
    const saved = redis.setClaudeAccount.mock.calls[0][1]
    expect(saved.nurturePhase).toBe('steady')
    expect(saved.nurtureLocalRequestCount).toBe('0')
  })

  test('advanceToSteady and resetToDayOne mutate expected fields', async () => {
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({ nurturePhase: 'nurturing', nurtureDayIndex: '4' })
    )

    await claudeAccountNurtureService.advanceToSteady('acc-pro-1')
    expect(redis.setClaudeAccount.mock.calls[0][1].nurturePhase).toBe('steady')

    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({ nurturePhase: 'steady', nurtureDayIndex: '8' })
    )
    await claudeAccountNurtureService.resetToDayOne('acc-pro-1')
    const resetSaved = redis.setClaudeAccount.mock.calls[1][1]
    expect(resetSaved.nurturePhase).toBe('nurturing')
    expect(resetSaved.nurtureDayIndex).toBe('1')
  })

  test('getStatus returns null for missing account', async () => {
    redis.getClaudeAccount.mockResolvedValue(null)
    const status = await claudeAccountNurtureService.getStatus('missing')
    expect(status).toBeNull()
  })

  test('getStatus reports the current evaluation instead of a stale stored block reason', async () => {
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({ nurtureLastBlockReason: 'local_request_count' })
    )
    const evaluateSpy = jest
      .spyOn(claudeAccountNurtureService, 'evaluate')
      .mockResolvedValue({ blocked: false, active: true, reason: null })

    const status = await claudeAccountNurtureService.getStatus('acc-pro-1')

    expect(status.lastBlockReason).toBeNull()
    evaluateSpy.mockRestore()
  })

  test('rollover increments day index before graduation', async () => {
    redis.getClaudeAccount.mockResolvedValue({
      id: 'acc-1',
      nurtureEnabled: 'true',
      nurturePhase: 'nurturing',
      nurtureDayIndex: '3',
      nurtureStartedAt: new Date(FIXED_NOW).toISOString()
    })

    jest.useFakeTimers()
    jest.setSystemTime(FIXED_NOW)
    const result = await claudeAccountNurtureService.rolloverDayIndexes()
    jest.useRealTimers()

    expect(result.processed).toBe(1)
    expect(result.graduated).toBe(0)
    const saved = redis.setClaudeAccount.mock.calls[0][1]
    expect(saved.nurtureDayIndex).toBe('4')
    expect(saved.nurturePhase).toBe('nurturing')
    expect(saved.nurtureLocalRequestCount).toBe('0')
  })

  test('rollover skips when lock is not acquired', async () => {
    redis.setAccountLock.mockResolvedValue(false)

    const result = await claudeAccountNurtureService.rolloverDayIndexes()
    expect(result.skipped).toBe(true)
    expect(result.processed).toBe(0)
    expect(claudeAccountService.getAllAccounts).not.toHaveBeenCalled()
  })

  test('rollover skips accounts already rolled over today', async () => {
    redis.getClaudeAccount.mockResolvedValue({
      id: 'acc-1',
      nurtureEnabled: 'true',
      nurturePhase: 'nurturing',
      nurtureDayIndex: '2',
      nurtureStartedAt: new Date(FIXED_NOW).toISOString(),
      nurtureLastRolloverDate: '2026-07-10'
    })

    jest.useFakeTimers()
    jest.setSystemTime(FIXED_NOW)
    const result = await claudeAccountNurtureService.rolloverDayIndexes()
    jest.useRealTimers()

    expect(result.processed).toBe(0)
    expect(redis.setClaudeAccount).not.toHaveBeenCalled()
  })

  test('disableNurture clears phase', async () => {
    redis.getClaudeAccount.mockResolvedValue(buildAccount({ nurturePhase: 'steady' }))
    await claudeAccountNurtureService.disableNurture('acc-pro-1')
    const saved = redis.setClaudeAccount.mock.calls[0][1]
    expect(saved.nurtureEnabled).toBe('false')
    expect(saved.nurturePhase).toBe('')
  })

  test('buildInitialNurtureFields seeds day one nurturing state', () => {
    jest.useFakeTimers()
    jest.setSystemTime(FIXED_NOW)
    const fields = claudeAccountNurtureService.buildInitialNurtureFields('pro', true)
    jest.useRealTimers()

    expect(fields.nurtureEnabled).toBe('true')
    expect(fields.nurturePhase).toBe('nurturing')
    expect(fields.nurtureDayIndex).toBe('1')
    expect(fields.nurtureTier).toBe('pro')
    expect(fields.nurtureLocalRequestCount).toBe('0')
  })

  test('recordRequestSuccess resets count on new utc day', async () => {
    redis.getClaudeAccount.mockResolvedValue(
      buildAccount({
        nurtureLocalCountDate: '2026-07-09',
        nurtureLocalRequestCount: '40'
      })
    )

    jest.useFakeTimers()
    jest.setSystemTime(FIXED_NOW)
    await claudeAccountNurtureService.recordRequestSuccess('acc-pro-1')
    jest.useRealTimers()

    const saved = redis.setClaudeAccount.mock.calls[0][1]
    expect(saved.nurtureLocalCountDate).toBe('2026-07-10')
    expect(saved.nurtureLocalRequestCount).toBe('1')
  })
})
