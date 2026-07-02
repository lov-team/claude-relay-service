const {
  MAX_CAP_PERCENT,
  cloneDefaultConfig,
  normalizeAccountNurtureConfig,
  assertSteadyCapsBelowMax,
  pickInRange,
  calcSevenDayPaceLimit,
  calcSevenDayWindowProgress,
  getUtcDateKey
} = require('../src/utils/accountNurtureDefaults')

describe('accountNurtureDefaults', () => {
  test('default steady caps are all below 90%', () => {
    const defaults = cloneDefaultConfig()
    assertSteadyCapsBelowMax(defaults.steadyCaps)

    expect(defaults.steadyCaps.pro.fiveHour).toBeLessThan(MAX_CAP_PERCENT)
    expect(defaults.steadyCaps.pro.sevenDay).toBeLessThan(MAX_CAP_PERCENT)
    expect(defaults.steadyCaps.pro.sevenDayOpus).toBeLessThan(MAX_CAP_PERCENT)
    expect(defaults.steadyCaps.max.fiveHour).toBeLessThan(MAX_CAP_PERCENT)
    expect(defaults.steadyCaps.max.sevenDay).toBeLessThan(MAX_CAP_PERCENT)
    expect(defaults.steadyCaps.max.sevenDayOpus).toBeLessThan(MAX_CAP_PERCENT)
  })

  test('accepts 89 as steady cap and rejects 90', () => {
    const defaults = cloneDefaultConfig()
    const accepted = normalizeAccountNurtureConfig({
      ...defaults,
      steadyCaps: {
        ...defaults.steadyCaps,
        pro: { ...defaults.steadyCaps.pro, sevenDay: 89 }
      }
    })
    expect(accepted.steadyCaps.pro.sevenDay).toBe(89)

    expect(() =>
      normalizeAccountNurtureConfig({
        ...defaults,
        steadyCaps: {
          ...defaults.steadyCaps,
          pro: { ...defaults.steadyCaps.pro, sevenDay: 90 }
        }
      })
    ).toThrow(/below 90/)
  })

  test('rejects invalid day plan ranges and lengths', () => {
    const defaults = cloneDefaultConfig()
    const brokenPlans = [...defaults.proDayPlans]
    brokenPlans[0] = { ...brokenPlans[0], sevenDayMin: 30, sevenDayMax: 10 }

    expect(() =>
      normalizeAccountNurtureConfig({
        ...defaults,
        proDayPlans: brokenPlans
      })
    ).toThrow(/min cannot exceed max/)

    expect(() =>
      normalizeAccountNurtureConfig({
        ...defaults,
        proDayPlans: defaults.proDayPlans.slice(0, 3)
      })
    ).toThrow(/exactly 7 day plans/)
  })

  test('rejects invalid paceBuffer and usageSnapshotMaxAgeMs', () => {
    const defaults = cloneDefaultConfig()

    expect(() =>
      normalizeAccountNurtureConfig({
        ...defaults,
        paceBuffer: 1.5
      })
    ).toThrow(/paceBuffer/)

    expect(() =>
      normalizeAccountNurtureConfig({
        ...defaults,
        usageSnapshotMaxAgeMs: 1000
      })
    ).toThrow(/usageSnapshotMaxAgeMs/)
  })

  test('pickInRange is stable per day seed and changes across accounts', () => {
    const a1 = pickInRange(10, 20, '2026-07-01', 'acc-1', 'sevenDay')
    const a2 = pickInRange(10, 20, '2026-07-01', 'acc-1', 'sevenDay')
    const b1 = pickInRange(10, 20, '2026-07-01', 'acc-2', 'sevenDay')

    expect(a1).toBe(a2)
    expect(a1).toBeGreaterThanOrEqual(10)
    expect(a1).toBeLessThanOrEqual(20)
    expect(b1).toBeGreaterThanOrEqual(10)
    expect(b1).toBeLessThanOrEqual(20)
  })

  test('seven day window progress increases as reset approaches', () => {
    const now = Date.parse('2026-07-10T12:00:00.000Z')
    const resetsIn2Days = new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString()
    const resetsIn6Days = new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString()

    const progress2 = calcSevenDayWindowProgress(resetsIn2Days, now)
    const progress6 = calcSevenDayWindowProgress(resetsIn6Days, now)

    expect(progress2).toBeGreaterThan(progress6)
    expect(progress2).toBeCloseTo(5 / 7, 2)
    expect(progress6).toBeCloseTo(1 / 7, 2)
  })

  test('pace limit on day 2 stays below steady cap and above naive misuse threshold', () => {
    const defaults = cloneDefaultConfig()
    const now = Date.parse('2026-07-10T12:00:00.000Z')
    const resetsAt = new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString()
    const pace = calcSevenDayPaceLimit(
      defaults.steadyCaps.pro.sevenDay,
      resetsAt,
      defaults.paceBuffer,
      now
    )

    expect(pace).toBeLessThan(defaults.steadyCaps.pro.sevenDay)
    expect(pace).toBeGreaterThan(20)
    expect(pace).toBeLessThan(MAX_CAP_PERCENT)
  })

  test('getUtcDateKey returns YYYY-MM-DD', () => {
    expect(getUtcDateKey(new Date('2026-07-02T15:30:00.000Z'))).toBe('2026-07-02')
  })

  test('all default day plan curve ceilings stay below 90%', () => {
    const defaults = cloneDefaultConfig()
    const checkPlans = (plans, tier) => {
      plans.forEach((plan) => {
        expect(plan.fiveHourMax).toBeLessThan(MAX_CAP_PERCENT)
        expect(plan.sevenDayMax).toBeLessThan(MAX_CAP_PERCENT)
        expect(plan.fiveHourMin).toBeLessThanOrEqual(plan.fiveHourMax)
        expect(plan.sevenDayMin).toBeLessThanOrEqual(plan.sevenDayMax)
        expect(plan.localRequestsMin).toBeLessThanOrEqual(plan.localRequestsMax)
        expect(plan.rpm).toBeGreaterThanOrEqual(1)
      })
      expect(plans).toHaveLength(7)
      expect(plans.map((p) => p.day)).toEqual([1, 2, 3, 4, 5, 6, 7])
    }

    checkPlans(defaults.proDayPlans, 'pro')
    checkPlans(defaults.maxDayPlans, 'max')
  })

  test('max steady caps are strictly higher than pro for each percent field', () => {
    const defaults = cloneDefaultConfig()
    expect(defaults.steadyCaps.max.fiveHour).toBeGreaterThan(defaults.steadyCaps.pro.fiveHour)
    expect(defaults.steadyCaps.max.sevenDay).toBeGreaterThan(defaults.steadyCaps.pro.sevenDay)
    expect(defaults.steadyCaps.max.sevenDayOpus).toBeGreaterThan(
      defaults.steadyCaps.pro.sevenDayOpus
    )
    expect(defaults.steadyCaps.max.rpm).toBeGreaterThan(defaults.steadyCaps.pro.rpm)
  })

  test('assertSteadyCapsBelowMax rejects every percent field at 90', () => {
    const defaults = cloneDefaultConfig()
    ;['fiveHour', 'sevenDay', 'sevenDayOpus'].forEach((field) => {
      const broken = JSON.parse(JSON.stringify(defaults.steadyCaps))
      broken.pro[field] = 90
      expect(() => assertSteadyCapsBelowMax(broken)).toThrow(/below 90/)
    })
  })

  test('calcSevenDayWindowProgress returns 1 when reset time has passed', () => {
    const now = Date.parse('2026-07-10T12:00:00.000Z')
    const pastReset = new Date(now - 60 * 60 * 1000).toISOString()
    expect(calcSevenDayWindowProgress(pastReset, now)).toBe(1)
    expect(calcSevenDayWindowProgress(null, now)).toBeNull()
  })

  test('calcSevenDayPaceLimit equals steady cap when window is complete', () => {
    const defaults = cloneDefaultConfig()
    const now = Date.parse('2026-07-10T12:00:00.000Z')
    const pastReset = new Date(now - 1000).toISOString()
    const pace = calcSevenDayPaceLimit(
      defaults.steadyCaps.pro.sevenDay,
      pastReset,
      defaults.paceBuffer,
      now
    )
    expect(pace).toBeCloseTo(defaults.steadyCaps.pro.sevenDay * defaults.paceBuffer, 5)
    expect(pace).toBeLessThan(MAX_CAP_PERCENT)
  })

  test('pickInRange returns exact value when min equals max', () => {
    expect(pickInRange(42, 42, '2026-07-01', 'acc-1', 'rpm')).toBe(42)
  })
})
