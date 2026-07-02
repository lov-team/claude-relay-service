const crypto = require('crypto')

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const MAX_CAP_PERCENT = 90

const buildDayPlan = (day, rpm, fiveHour, sevenDay, localRequests) => ({
  day,
  rpm,
  fiveHourMin: fiveHour[0],
  fiveHourMax: fiveHour[1],
  sevenDayMin: sevenDay[0],
  sevenDayMax: sevenDay[1],
  localRequestsMin: localRequests[0],
  localRequestsMax: localRequests[1]
})

const DEFAULT_PRO_DAY_PLANS = [
  buildDayPlan(1, 3, [12, 18], [8, 12], [20, 30]),
  buildDayPlan(2, 5, [18, 25], [15, 20], [40, 55]),
  buildDayPlan(3, 8, [25, 32], [22, 28], [70, 90]),
  buildDayPlan(4, 12, [32, 40], [30, 36], [100, 130]),
  buildDayPlan(5, 16, [40, 50], [38, 45], [140, 170]),
  buildDayPlan(6, 20, [50, 60], [48, 55], [180, 210]),
  buildDayPlan(7, 25, [60, 72], [58, 68], [220, 260])
]

const DEFAULT_MAX_DAY_PLANS = [
  buildDayPlan(1, 6, [18, 25], [12, 18], [40, 60]),
  buildDayPlan(2, 10, [25, 35], [20, 28], [80, 110]),
  buildDayPlan(3, 15, [35, 45], [30, 38], [130, 170]),
  buildDayPlan(4, 20, [45, 55], [40, 48], [180, 230]),
  buildDayPlan(5, 28, [55, 65], [50, 58], [250, 300]),
  buildDayPlan(6, 35, [65, 75], [60, 68], [320, 380]),
  buildDayPlan(7, 45, [75, 85], [70, 78], [400, 480])
]

const DEFAULT_ACCOUNT_NURTURE_CONFIG = {
  enabled: true,
  defaultEnabledForNewPro: true,
  defaultEnabledForNewMax: true,
  usageSnapshotMaxAgeMs: 300000,
  paceBuffer: 1.08,
  maxDailySevenDayDelta: { pro: 10, max: 15 },
  steadyCaps: {
    pro: { rpm: 30, fiveHour: 86, sevenDay: 82, sevenDayOpus: 78 },
    max: { rpm: 50, fiveHour: 88, sevenDay: 86, sevenDayOpus: 84 }
  },
  proDayPlans: DEFAULT_PRO_DAY_PLANS,
  maxDayPlans: DEFAULT_MAX_DAY_PLANS,
  updatedAt: null,
  updatedBy: null
}

function cloneDefaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_ACCOUNT_NURTURE_CONFIG))
}

function normalizeRangePair(minValue, maxValue, label) {
  const min = Number(minValue)
  const max = Number(maxValue)
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error(`${label} must be numeric`)
  }
  if (min > max) {
    throw new Error(`${label} min cannot exceed max`)
  }
  return { min, max }
}

function normalizeCapPercent(value, label) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0 || num >= MAX_CAP_PERCENT) {
    throw new Error(`${label} must be greater than 0 and below ${MAX_CAP_PERCENT}`)
  }
  return num
}

function assertSteadyCapsBelowMax(steadyCaps) {
  ;['pro', 'max'].forEach((tier) => {
    ;['fiveHour', 'sevenDay', 'sevenDayOpus'].forEach((field) => {
      const value = steadyCaps?.[tier]?.[field]
      if (!Number.isFinite(value) || value >= MAX_CAP_PERCENT) {
        throw new Error(`steadyCaps.${tier}.${field} must be below ${MAX_CAP_PERCENT}`)
      }
    })
  })
}

function normalizeDayPlans(dayPlans, label) {
  if (!Array.isArray(dayPlans) || dayPlans.length !== 7) {
    throw new Error(`${label} must contain exactly 7 day plans`)
  }

  return dayPlans.map((plan, index) => {
    const day = index + 1
    const rpm = Number(plan?.rpm)
    if (!Number.isFinite(rpm) || rpm < 1) {
      throw new Error(`${label} day ${day} rpm must be >= 1`)
    }

    const fiveHour = normalizeRangePair(
      plan.fiveHourMin,
      plan.fiveHourMax,
      `${label} day ${day} 5h`
    )
    const sevenDay = normalizeRangePair(
      plan.sevenDayMin,
      plan.sevenDayMax,
      `${label} day ${day} 7d`
    )
    const localRequests = normalizeRangePair(
      plan.localRequestsMin,
      plan.localRequestsMax,
      `${label} day ${day} local requests`
    )

    return {
      day,
      rpm,
      fiveHourMin: fiveHour.min,
      fiveHourMax: fiveHour.max,
      sevenDayMin: sevenDay.min,
      sevenDayMax: sevenDay.max,
      localRequestsMin: localRequests.min,
      localRequestsMax: localRequests.max
    }
  })
}

function normalizeAccountNurtureConfig(input = {}) {
  const base = cloneDefaultConfig()
  const merged = { ...base, ...input }

  const enabled = merged.enabled === true || merged.enabled === 'true'
  const defaultEnabledForNewPro =
    merged.defaultEnabledForNewPro === true || merged.defaultEnabledForNewPro === 'true'
  const defaultEnabledForNewMax =
    merged.defaultEnabledForNewMax === true || merged.defaultEnabledForNewMax === 'true'

  const usageSnapshotMaxAgeMs = Number(merged.usageSnapshotMaxAgeMs)
  if (!Number.isFinite(usageSnapshotMaxAgeMs) || usageSnapshotMaxAgeMs < 60000) {
    throw new Error('usageSnapshotMaxAgeMs must be >= 60000')
  }

  const paceBuffer = Number(merged.paceBuffer)
  if (!Number.isFinite(paceBuffer) || paceBuffer < 1 || paceBuffer > 1.2) {
    throw new Error('paceBuffer must be between 1 and 1.2')
  }

  const maxDailySevenDayDelta = {
    pro: Number(merged.maxDailySevenDayDelta?.pro ?? base.maxDailySevenDayDelta.pro),
    max: Number(merged.maxDailySevenDayDelta?.max ?? base.maxDailySevenDayDelta.max)
  }
  if (
    !Number.isFinite(maxDailySevenDayDelta.pro) ||
    maxDailySevenDayDelta.pro <= 0 ||
    !Number.isFinite(maxDailySevenDayDelta.max) ||
    maxDailySevenDayDelta.max <= 0
  ) {
    throw new Error('maxDailySevenDayDelta must be positive numbers')
  }

  const steadyCaps = {
    pro: {
      rpm: Number(merged.steadyCaps?.pro?.rpm ?? base.steadyCaps.pro.rpm),
      fiveHour: normalizeCapPercent(
        merged.steadyCaps?.pro?.fiveHour ?? base.steadyCaps.pro.fiveHour,
        'steadyCaps.pro.fiveHour'
      ),
      sevenDay: normalizeCapPercent(
        merged.steadyCaps?.pro?.sevenDay ?? base.steadyCaps.pro.sevenDay,
        'steadyCaps.pro.sevenDay'
      ),
      sevenDayOpus: normalizeCapPercent(
        merged.steadyCaps?.pro?.sevenDayOpus ?? base.steadyCaps.pro.sevenDayOpus,
        'steadyCaps.pro.sevenDayOpus'
      )
    },
    max: {
      rpm: Number(merged.steadyCaps?.max?.rpm ?? base.steadyCaps.max.rpm),
      fiveHour: normalizeCapPercent(
        merged.steadyCaps?.max?.fiveHour ?? base.steadyCaps.max.fiveHour,
        'steadyCaps.max.fiveHour'
      ),
      sevenDay: normalizeCapPercent(
        merged.steadyCaps?.max?.sevenDay ?? base.steadyCaps.max.sevenDay,
        'steadyCaps.max.sevenDay'
      ),
      sevenDayOpus: normalizeCapPercent(
        merged.steadyCaps?.max?.sevenDayOpus ?? base.steadyCaps.max.sevenDayOpus,
        'steadyCaps.max.sevenDayOpus'
      )
    }
  }

  if (!Number.isFinite(steadyCaps.pro.rpm) || steadyCaps.pro.rpm < 1) {
    throw new Error('steadyCaps.pro.rpm must be >= 1')
  }
  if (!Number.isFinite(steadyCaps.max.rpm) || steadyCaps.max.rpm < 1) {
    throw new Error('steadyCaps.max.rpm must be >= 1')
  }

  assertSteadyCapsBelowMax(steadyCaps)

  return {
    enabled,
    defaultEnabledForNewPro,
    defaultEnabledForNewMax,
    usageSnapshotMaxAgeMs,
    paceBuffer,
    maxDailySevenDayDelta,
    steadyCaps,
    proDayPlans: normalizeDayPlans(merged.proDayPlans, 'proDayPlans'),
    maxDayPlans: normalizeDayPlans(merged.maxDayPlans, 'maxDayPlans'),
    updatedAt: merged.updatedAt || null,
    updatedBy: merged.updatedBy || null
  }
}

function seededUnitRandom(seed, accountId, field) {
  const digest = crypto.createHash('sha256').update(`${seed}:${accountId}:${field}`).digest('hex')
  return parseInt(digest.slice(0, 8), 16) / 0xffffffff
}

function pickInRange(min, max, seed, accountId, field) {
  const low = Number(min)
  const high = Number(max)
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    return null
  }
  if (low === high) {
    return low
  }
  const ratio = seededUnitRandom(seed, accountId, field)
  return low + ratio * (high - low)
}

function calcSevenDayWindowProgress(resetsAt, nowMs = Date.now()) {
  if (!resetsAt) {
    return null
  }
  const resetMs = new Date(resetsAt).getTime()
  if (!Number.isFinite(resetMs)) {
    return null
  }
  const remainingMs = resetMs - nowMs
  if (remainingMs <= 0) {
    return 1
  }
  const elapsedMs = Math.max(0, WINDOW_MS - remainingMs)
  return Math.min(1, elapsedMs / WINDOW_MS)
}

function calcSevenDayPaceLimit(steadySevenDayCap, resetsAt, paceBuffer, nowMs = Date.now()) {
  const progress = calcSevenDayWindowProgress(resetsAt, nowMs)
  if (progress === null) {
    return null
  }
  return steadySevenDayCap * progress * paceBuffer
}

function getUtcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

module.exports = {
  WINDOW_MS,
  MAX_CAP_PERCENT,
  DEFAULT_ACCOUNT_NURTURE_CONFIG,
  cloneDefaultConfig,
  normalizeAccountNurtureConfig,
  assertSteadyCapsBelowMax,
  seededUnitRandom,
  pickInRange,
  calcSevenDayWindowProgress,
  calcSevenDayPaceLimit,
  getUtcDateKey
}
