jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const mockRedisClient = {
  get: jest.fn(),
  set: jest.fn()
}

jest.mock('../src/models/redis', () => ({
  getClient: jest.fn(() => mockRedisClient),
  getClientSafe: jest.fn(() => mockRedisClient)
}))

const { cloneDefaultConfig, MAX_CAP_PERCENT } = require('../src/utils/accountNurtureDefaults')

describe('accountNurtureConfigService', () => {
  let accountNurtureConfigService

  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    accountNurtureConfigService = require('../src/services/accountNurtureConfigService')
    accountNurtureConfigService.clearCache()
  })

  test('returns built-in defaults when redis is empty', async () => {
    mockRedisClient.get.mockResolvedValue(null)
    const config = await accountNurtureConfigService.getConfig()

    expect(config.enabled).toBe(true)
    expect(config.steadyCaps.pro.sevenDay).toBeLessThan(MAX_CAP_PERCENT)
    expect(config.steadyCaps.pro.localRequests).toBe(config.proDayPlans[6].localRequestsMax)
    expect(config.steadyCaps.max.localRequests).toBe(config.maxDayPlans[6].localRequestsMax)
    expect(config.steadyCaps.pro.sevenDayVelocity).toBe(10)
    expect(config.steadyCaps.max.sevenDayVelocity).toBe(15)
    expect(config.proDayPlans).toHaveLength(7)
  })

  test('persists normalized config to redis', async () => {
    mockRedisClient.get.mockResolvedValue(null)
    const updated = await accountNurtureConfigService.updateConfig(
      {
        paceBuffer: 1.05,
        steadyCaps: {
          pro: { rpm: 25, fiveHour: 85, sevenDay: 80, sevenDayOpus: 75 },
          max: { rpm: 40, fiveHour: 87, sevenDay: 84, sevenDayOpus: 82 }
        }
      },
      'tester'
    )

    expect(updated.paceBuffer).toBe(1.05)
    expect(updated.updatedBy).toBe('tester')
    expect(mockRedisClient.set).toHaveBeenCalled()
    const persisted = JSON.parse(mockRedisClient.set.mock.calls[0][1])
    expect(persisted.steadyCaps.max.fiveHour).toBe(87)
  })

  test('rejects steady cap at or above 90%', async () => {
    mockRedisClient.get.mockResolvedValue(null)
    const defaults = cloneDefaultConfig()

    await expect(
      accountNurtureConfigService.updateConfig({
        steadyCaps: {
          ...defaults.steadyCaps,
          max: { rpm: 50, fiveHour: 90, sevenDay: 86, sevenDayOpus: 84 }
        }
      })
    ).rejects.toThrow(/below 90/)

    await expect(
      accountNurtureConfigService.updateConfig({
        steadyCaps: {
          ...defaults.steadyCaps,
          pro: { ...defaults.steadyCaps.pro, sevenDayOpus: 90 }
        }
      })
    ).rejects.toThrow(/below 90/)
  })

  test('resetToDefaults restores built-in steady caps under 90%', async () => {
    mockRedisClient.get.mockResolvedValue(
      JSON.stringify({
        steadyCaps: {
          pro: { rpm: 10, fiveHour: 50, sevenDay: 50, sevenDayOpus: 40 },
          max: { rpm: 20, fiveHour: 60, sevenDay: 60, sevenDayOpus: 50 }
        }
      })
    )

    const reset = await accountNurtureConfigService.resetToDefaults('admin')
    expect(reset.steadyCaps.pro.sevenDay).toBe(cloneDefaultConfig().steadyCaps.pro.sevenDay)
    expect(reset.steadyCaps.pro.sevenDay).toBeLessThan(MAX_CAP_PERCENT)
    expect(reset.updatedBy).toBe('admin')
    expect(mockRedisClient.set).toHaveBeenCalled()
  })

  test('getConfig uses cache within ttl', async () => {
    mockRedisClient.get.mockResolvedValue(null)
    await accountNurtureConfigService.getConfig()
    await accountNurtureConfigService.getConfig()
    expect(mockRedisClient.get).toHaveBeenCalledTimes(1)
  })

  test('clearCache forces redis reload', async () => {
    mockRedisClient.get.mockResolvedValue(null)
    await accountNurtureConfigService.getConfig()
    accountNurtureConfigService.clearCache()
    await accountNurtureConfigService.getConfig()
    expect(mockRedisClient.get).toHaveBeenCalledTimes(2)
  })

  test('rejects invalid maxDailySevenDayDelta', async () => {
    mockRedisClient.get.mockResolvedValue(null)
    await expect(
      accountNurtureConfigService.updateConfig({
        maxDailySevenDayDelta: { pro: 0, max: 15 }
      })
    ).rejects.toThrow(/maxDailySevenDayDelta/)
  })
})
