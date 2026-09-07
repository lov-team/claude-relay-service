const crypto = require('crypto')
const { DEFAULT_CLAUDE_TRAFFIC_GUARDRAILS } = require('./claudeTrafficGuardrail')

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
  defaultEnabledForNewMax20x: true,
  usageSnapshotMaxAgeMs: 300000,
  paceBuffer: 1.08,
  maxDailySevenDayDelta: { pro: 10, max: 15, max20x: 30 },
  steadyCaps: {
    pro: {
      rpm: 30,
      fiveHour: 86,
      sevenDay: 82,
      sevenDayOpus: 78,
      sevenDayVelocity: 10,
      localRequests: 260
    },
    max20x: {
      rpm: 100,
      fiveHour: 89,
      sevenDay: 89,
      sevenDayOpus: 88,
      sevenDayVelocity: 30,
      localRequests: 960
    },
    max: {
      rpm: 50,
      fiveHour: 88,
      sevenDay: 86,
      sevenDayOpus: 84,
      sevenDayVelocity: 15,
      localRequests: 480
    }
  },
  oauthErrorPatterns: {
    blocked: [],
    revoked: []
  },
  trafficGuardrails: { ...DEFAULT_CLAUDE_TRAFFIC_GUARDRAILS },
  proDayPlans: DEFAULT_PRO_DAY_PLANS,
  maxDayPlans: DEFAULT_MAX_DAY_PLANS,
  max20xDayPlans: DEFAULT_MAX_DAY_PLANS.map((plan) => ({
    ...plan,
    rpm: plan.rpm * 2,
    localRequestsMin: plan.localRequestsMin * 2,
    localRequestsMax: plan.localRequestsMax * 2
  })),
  // 秒：Day 1–7 后接常驻期。max 保留旧配置键，对应 Max 5x。
  rateLimitCooldowns: {
    // 秒：第 1–7 天及常驻期。随着养号时间增加，冷却时间逐步缩短。
    pro: [3600, 3000, 2400, 1800, 1500, 1200, 900, 600],
    max: [2700, 2100, 1500, 900, 600, 450, 360, 300],
    max20x: [1800, 1500, 900, 600, 450, 360, 300, 300]
  },
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

function normalizePatternList(value, label) {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\r?\n|\|/)
      : []
  const normalized = [...new Set(source.map((item) => String(item).trim()).filter(Boolean))]
  if (normalized.length > 50) {
    throw new Error(`${label} cannot contain more than 50 patterns`)
  }
  if (normalized.some((pattern) => pattern.length > 200)) {
    throw new Error(`${label} pattern length cannot exceed 200 characters`)
  }
  return normalized
}

function normalizeIntegerRange(value, fallback, min, max, label) {
  const parsed = Number.parseInt(value ?? fallback, 10)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

function assertSteadyCapsBelowMax(steadyCaps) {
  ;['pro', 'max', 'max20x'].forEach((tier) => {
    ;['fiveHour', 'sevenDay', 'sevenDayOpus', 'sevenDayVelocity'].forEach((field) => {
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

  const maxDailySevenDayDelta = {}
  const steadyCaps = {}
  const dayPlans = {}
  const rateLimitCooldowns = {}
  for (const tier of ['pro', 'max', 'max20x']) {
    const delta = Number(merged.maxDailySevenDayDelta?.[tier] ?? base.maxDailySevenDayDelta[tier])
    if (!Number.isFinite(delta) || delta <= 0) {
      throw new Error('maxDailySevenDayDelta must be positive numbers')
    }
    maxDailySevenDayDelta[tier] = delta
    const planKey = `${tier}DayPlans`
    dayPlans[planKey] = normalizeDayPlans(merged[planKey], planKey)
    const daySevenMax = dayPlans[planKey][6].localRequestsMax
    const capInput = merged.steadyCaps?.[tier] || {}
    const cap = { ...base.steadyCaps[tier], ...capInput }
    cap.rpm = Number(cap.rpm)
    if (!Number.isFinite(cap.rpm) || cap.rpm < 1) {
      throw new Error(`steadyCaps.${tier}.rpm must be >= 1`)
    }
    for (const field of ['fiveHour', 'sevenDay', 'sevenDayOpus', 'sevenDayVelocity']) {
      cap[field] = normalizeCapPercent(cap[field], `steadyCaps.${tier}.${field}`)
    }
    cap.localRequests = Number(
      capInput.localRequests ?? Math.max(base.steadyCaps[tier].localRequests, daySevenMax)
    )
    if (!Number.isInteger(cap.localRequests) || cap.localRequests < daySevenMax) {
      throw new Error(
        `steadyCaps.${tier}.localRequests must be an integer at or above Day 7 maximum`
      )
    }
    steadyCaps[tier] = cap

    const cooldowns = merged.rateLimitCooldowns?.[tier] ?? base.rateLimitCooldowns[tier]
    if (!Array.isArray(cooldowns) || cooldowns.length !== 8) {
      throw new Error(`rateLimitCooldowns.${tier} must contain 8 values (Day 1–7 and steady)`)
    }
    rateLimitCooldowns[tier] = cooldowns.map((value, index) => {
      const seconds = Number(value)
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
        throw new Error(`rateLimitCooldowns.${tier} must be integer seconds between 1 and 86400`)
      }
      if (index > 0 && seconds > Number(cooldowns[index - 1])) {
        throw new Error(`rateLimitCooldowns.${tier} must not increase as the account matures`)
      }
      return seconds
    })
  }
  assertSteadyCapsBelowMax(steadyCaps)

  const oauthErrorPatterns = {
    blocked: normalizePatternList(
      merged.oauthErrorPatterns?.blocked ?? base.oauthErrorPatterns.blocked,
      'oauthErrorPatterns.blocked'
    ),
    revoked: normalizePatternList(
      merged.oauthErrorPatterns?.revoked ?? base.oauthErrorPatterns.revoked,
      'oauthErrorPatterns.revoked'
    )
  }
  const trafficInput = {
    ...base.trafficGuardrails,
    ...(merged.trafficGuardrails || {})
  }
  const trafficGuardrails = {
    enabled: trafficInput.enabled === true || trafficInput.enabled === 'true',
    maxBodyBytes: normalizeIntegerRange(
      trafficInput.maxBodyBytes,
      base.trafficGuardrails.maxBodyBytes,
      65536,
      32 * 1024 * 1024,
      'trafficGuardrails.maxBodyBytes'
    ),
    maxMessages: normalizeIntegerRange(
      trafficInput.maxMessages,
      base.trafficGuardrails.maxMessages,
      1,
      1000,
      'trafficGuardrails.maxMessages'
    ),
    maxTools: normalizeIntegerRange(
      trafficInput.maxTools,
      base.trafficGuardrails.maxTools,
      1,
      256,
      'trafficGuardrails.maxTools'
    ),
    maxOutputTokens: normalizeIntegerRange(
      trafficInput.maxOutputTokens,
      base.trafficGuardrails.maxOutputTokens,
      1,
      128000,
      'trafficGuardrails.maxOutputTokens'
    ),
    retryAfterSeconds: normalizeIntegerRange(
      trafficInput.retryAfterSeconds,
      base.trafficGuardrails.retryAfterSeconds,
      1,
      3600,
      'trafficGuardrails.retryAfterSeconds'
    )
  }

  return {
    enabled,
    defaultEnabledForNewPro,
    defaultEnabledForNewMax,
    defaultEnabledForNewMax20x:
      merged.defaultEnabledForNewMax20x === true || merged.defaultEnabledForNewMax20x === 'true',
    usageSnapshotMaxAgeMs,
    paceBuffer,
    maxDailySevenDayDelta,
    steadyCaps,
    oauthErrorPatterns,
    trafficGuardrails,
    ...dayPlans,
    rateLimitCooldowns,
    updatedAt: merged.updatedAt || null,
    updatedBy: merged.updatedBy || null
  }
}

function parseSubscriptionInfo(account) {
  if (!account?.subscriptionInfo) {
    return null
  }
  try {
    return typeof account.subscriptionInfo === 'string'
      ? JSON.parse(account.subscriptionInfo)
      : account.subscriptionInfo
  } catch (error) {
    return null
  }
}

function isProAccount(info) {
  if (!info) {
    return false
  }
  if (info.hasClaudePro === true && info.hasClaudeMax !== true) {
    return true
  }
  return info.accountType === 'claude_pro'
}

function isMaxAccount(info) {
  if (!info) {
    return false
  }
  if (info.hasClaudeMax === true) {
    return true
  }
  return (
    info.accountType === 'claude_max' ||
    info.accountType === 'claude_max_5x' ||
    info.accountType === 'claude_max_20x'
  )
}

function getNurtureTier(account) {
  const info = parseSubscriptionInfo(account)
  if (isMaxAccount(info)) {
    return info.accountType === 'claude_max_20x' ? 'max20x' : 'max'
  }
  if (isProAccount(info)) {
    return 'pro'
  }
  return null
}

function getNurtureRateLimitCooldownSeconds(config, account) {
  const flag = (value) => value === true || value === 'true'
  if (
    !flag(config?.enabled) ||
    !flag(account?.nurtureEnabled) ||
    flag(account?.disableAutoProtection)
  ) {
    return null
  }
  const tier =
    getNurtureTier(account) || (account?.nurtureTier === 'max5x' ? 'max' : account?.nurtureTier)
  const cooldowns = config.rateLimitCooldowns?.[tier]
  if (!cooldowns) return null
  const day = Number.parseInt(account.nurtureDayIndex, 10)
  const index =
    account.nurturePhase === 'steady'
      ? 7
      : Math.min(6, Math.max(0, (Number.isFinite(day) ? day : 1) - 1))
  return cooldowns[index]
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

const DAY_MS = 24 * 60 * 60 * 1000

function parsePercentUtil(value) {
  const num = Number(value)
  return Number.isFinite(num) ? Math.max(0, num) : null
}

function calcSevenDayRemainingMs(resetsAt, nowMs = Date.now()) {
  if (!resetsAt) {
    return null
  }
  const resetMs = new Date(resetsAt).getTime()
  if (!Number.isFinite(resetMs)) {
    return null
  }
  return resetMs - nowMs
}

function calcSevenDaySteadyPaceLimit(
  steadyCap,
  currentUtil,
  resetsAt,
  paceBuffer,
  nowMs = Date.now()
) {
  const remainingMs = calcSevenDayRemainingMs(resetsAt, nowMs)
  if (remainingMs === null) {
    return calcSevenDayPaceLimit(steadyCap, resetsAt, paceBuffer, nowMs)
  }
  if (remainingMs <= 0) {
    return steadyCap * paceBuffer
  }

  const util = parsePercentUtil(currentUtil) ?? 0
  const headroom = Math.max(0, steadyCap - util)
  const remainingFraction = Math.min(1, remainingMs / WINDOW_MS)
  const remainingBasedCap = steadyCap - headroom * remainingFraction
  const linearCap = calcSevenDayPaceLimit(steadyCap, resetsAt, paceBuffer, nowMs)

  return Math.min(steadyCap * paceBuffer, Math.max(remainingBasedCap * paceBuffer, linearCap ?? 0))
}

function calcSevenDaySteadyVelocityLimit(
  steadyCap,
  currentUtil,
  resetsAt,
  paceBuffer,
  nowMs = Date.now()
) {
  const util = parsePercentUtil(currentUtil)
  if (util === null) {
    return null
  }

  const remainingMs = calcSevenDayRemainingMs(resetsAt, nowMs)
  const headroom = Math.max(0, steadyCap - util)
  if (remainingMs === null) {
    return null
  }
  if (remainingMs <= 0) {
    return headroom
  }

  const dailyShare = Math.min(1, DAY_MS / remainingMs)
  return headroom * dailyShare * paceBuffer
}

function getUtcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

module.exports = {
  getNurtureTier,
  isProAccount,
  isMaxAccount,
  getNurtureRateLimitCooldownSeconds,
  WINDOW_MS,
  DAY_MS,
  MAX_CAP_PERCENT,
  DEFAULT_ACCOUNT_NURTURE_CONFIG,
  cloneDefaultConfig,
  normalizeAccountNurtureConfig,
  assertSteadyCapsBelowMax,
  seededUnitRandom,
  pickInRange,
  calcSevenDayWindowProgress,
  calcSevenDayPaceLimit,
  calcSevenDayRemainingMs,
  calcSevenDaySteadyPaceLimit,
  calcSevenDaySteadyVelocityLimit,
  getUtcDateKey
}
