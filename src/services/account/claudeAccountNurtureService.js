const crypto = require('crypto')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const accountNurtureConfigService = require('../accountNurtureConfigService')
const claudeAccountService = require('./claudeAccountService')
const {
  pickInRange,
  calcSevenDayPaceLimit,
  calcSevenDaySteadyPaceLimit,
  calcSevenDaySteadyVelocityLimit,
  calcSevenDayWindowProgress,
  getUtcDateKey
} = require('../../utils/accountNurtureDefaults')

const RPM_KEY_PREFIX = 'nurture:rpm:'
const BASELINE_KEY_PREFIX = 'nurture:7d:baseline:'
const RPM_WINDOW_MS = 60000
const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000
const FIVE_HOUR_GUARD_JITTER_MS = 60 * 60 * 1000
const FIVE_HOUR_BLOCK_REASONS = new Set(['five_hour_curve', 'five_hour_steady'])

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
  return info.accountType === 'claude_max'
}

function getNurtureTier(account) {
  const info = parseSubscriptionInfo(account)
  if (isMaxAccount(info)) {
    return 'max'
  }
  if (isProAccount(info)) {
    return 'pro'
  }
  return null
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function isTruthyFlag(value) {
  return value === true || value === 'true'
}

function isFiveHourBlockReason(reason) {
  return FIVE_HOUR_BLOCK_REASONS.has(reason)
}

function calcFiveHourGuardReleaseAt(accountId, resetsAt) {
  const resetAtMs = Date.parse(resetsAt)
  if (!accountId || !Number.isFinite(resetAtMs)) {
    return null
  }

  const seed = `${accountId}:${new Date(resetAtMs).toISOString()}`
  const offsetMs =
    crypto.createHash('sha256').update(seed).digest().readUInt32BE(0) % FIVE_HOUR_GUARD_JITTER_MS
  return new Date(resetAtMs + offsetMs).toISOString()
}

class ClaudeAccountNurtureService {
  async resolveAndSyncTier(accountId, account) {
    const subscriptionTier = getNurtureTier(account)
    const tier = subscriptionTier || account?.nurtureTier || null

    if (subscriptionTier && account?.nurtureTier !== subscriptionTier) {
      account.nurtureTier = subscriptionTier
      try {
        await redis.setClaudeAccount(accountId, account)
        logger.info(`Synced nurture tier for account ${accountId} to ${subscriptionTier}`)
      } catch (error) {
        logger.warn(`Failed to persist nurture tier for account ${accountId}: ${error.message}`)
      }
    }

    return tier
  }

  async getEffectiveConfig(accountId, accountData = null) {
    const account = accountData || (await redis.getClaudeAccount(accountId))
    const systemConfig = await accountNurtureConfigService.getConfig()
    const tier = getNurtureTier(account) || account?.nurtureTier || 'pro'
    const steadyCaps = { ...systemConfig.steadyCaps[tier] }

    if (isTruthyFlag(account?.nurtureOverrideEnabled) && account?.nurtureOverrideSteadyCaps) {
      try {
        const override =
          typeof account.nurtureOverrideSteadyCaps === 'string'
            ? JSON.parse(account.nurtureOverrideSteadyCaps)
            : account.nurtureOverrideSteadyCaps
        Object.assign(steadyCaps, override)
      } catch (error) {
        logger.warn(`Invalid nurtureOverrideSteadyCaps for account ${accountId}`)
      }
    }

    return {
      ...systemConfig,
      steadyCaps: {
        ...systemConfig.steadyCaps,
        [tier]: steadyCaps
      },
      tier
    }
  }

  getDayPlan(config, tier, dayIndex) {
    const plans = tier === 'max' ? config.maxDayPlans : config.proDayPlans
    return plans.find((plan) => plan.day === dayIndex) || plans[plans.length - 1]
  }

  resolveDailyLimits(config, account, tier) {
    const phase = account.nurturePhase || 'nurturing'
    const dayIndex = Math.max(1, parseInt(account.nurtureDayIndex || '1', 10))
    const seed = account.nurtureDailySeed || getUtcDateKey()
    const steady = config.steadyCaps[tier]

    const dayPlan = this.getDayPlan(config, tier, dayIndex)
    const curve = {
      rpm: dayPlan.rpm,
      fiveHour: pickInRange(dayPlan.fiveHourMin, dayPlan.fiveHourMax, seed, account.id, 'fiveHour'),
      sevenDay: pickInRange(dayPlan.sevenDayMin, dayPlan.sevenDayMax, seed, account.id, 'sevenDay'),
      localRequests: pickInRange(
        dayPlan.localRequestsMin,
        dayPlan.localRequestsMax,
        seed,
        account.id,
        'localRequests'
      )
    }

    const currentSevenDay = toNumberOrNull(account.claudeSevenDayUtilization)
    const currentSevenDayOpus = toNumberOrNull(account.claudeSevenDayOpusUtilization)

    const paceSevenDay =
      phase === 'steady'
        ? calcSevenDaySteadyPaceLimit(
            steady.sevenDay,
            currentSevenDay,
            account.claudeSevenDayResetsAt,
            config.paceBuffer
          )
        : calcSevenDayPaceLimit(steady.sevenDay, account.claudeSevenDayResetsAt, config.paceBuffer)
    const paceSevenDayOpus =
      phase === 'steady'
        ? calcSevenDaySteadyPaceLimit(
            steady.sevenDayOpus,
            currentSevenDayOpus,
            account.claudeSevenDayOpusResetsAt,
            config.paceBuffer
          )
        : calcSevenDayPaceLimit(
            steady.sevenDayOpus,
            account.claudeSevenDayOpusResetsAt,
            config.paceBuffer
          )

    const effectiveSevenDay = Math.min(
      phase === 'nurturing' ? curve.sevenDay : Number.POSITIVE_INFINITY,
      steady.sevenDay,
      paceSevenDay ?? steady.sevenDay
    )
    const effectiveSevenDayOpus = Math.min(
      steady.sevenDayOpus,
      paceSevenDayOpus ?? steady.sevenDayOpus
    )

    return {
      phase,
      dayIndex,
      rpmLimit: phase === 'nurturing' ? curve.rpm : steady.rpm,
      fiveHourLimit: phase === 'nurturing' ? curve.fiveHour : steady.fiveHour,
      sevenDayLimit: effectiveSevenDay,
      sevenDayOpusLimit: effectiveSevenDayOpus,
      localRequestsLimit:
        phase === 'nurturing' ? Math.round(curve.localRequests) : steady.localRequests,
      paceSevenDay,
      paceSevenDayOpus,
      steadyCaps: steady,
      curve
    }
  }

  async checkRpm(accountId, rpmLimit, options = {}) {
    const client = redis.getClientSafe()
    const key = `${RPM_KEY_PREFIX}${accountId}`
    const now = Date.now()

    await client.zremrangebyscore(key, 0, now - RPM_WINDOW_MS)
    const count = await client.zcard(key)
    if (count >= rpmLimit) {
      return { blocked: true, count, limit: rpmLimit }
    }

    if (options.increment) {
      const member = `${now}:${crypto.randomBytes(4).toString('hex')}`
      await client.zadd(key, now, member)
      await client.expire(key, 120)
      return { blocked: false, count: count + 1, limit: rpmLimit }
    }

    return { blocked: false, count, limit: rpmLimit }
  }

  async getSevenDayBaseline(accountId, dateKey) {
    const client = redis.getClient()
    if (!client) {
      return null
    }
    const raw = await client.get(`${BASELINE_KEY_PREFIX}${accountId}:${dateKey}`)
    return toNumberOrNull(raw)
  }

  async ensureSevenDayBaseline(accountId, currentSevenDay) {
    const dateKey = getUtcDateKey()
    const existing = await this.getSevenDayBaseline(accountId, dateKey)
    if (existing !== null) {
      return existing
    }

    const baseline = currentSevenDay ?? 0
    const client = redis.getClientSafe()
    await client.set(
      `${BASELINE_KEY_PREFIX}${accountId}:${dateKey}`,
      String(baseline),
      'EX',
      172800
    )
    return baseline
  }

  async maybeRefreshUsageSnapshot(accountId, account, config, options = {}) {
    const updatedAt = account.claudeUsageUpdatedAt
    const maxAge = config.usageSnapshotMaxAgeMs
    const stale =
      options.force === true || !updatedAt || Date.now() - new Date(updatedAt).getTime() > maxAge

    if (!stale) {
      return account
    }

    try {
      const usageData = await claudeAccountService.fetchOAuthUsage(accountId)
      if (usageData) {
        await claudeAccountService.updateClaudeUsageSnapshot(accountId, usageData)
        return redis.getClaudeAccount(accountId)
      }
    } catch (error) {
      logger.debug(`Nurture usage refresh skipped for ${accountId}: ${error.message}`)
    }

    return account
  }

  resolveFiveHourGuard(accountId, account) {
    const reason = account?.nurtureLastBlockReason
    if (!isFiveHourBlockReason(reason)) {
      return { active: false, expired: false, reason: null, releaseAt: null }
    }

    const releaseAt =
      account.nurtureFiveHourGuardReleaseAt ||
      calcFiveHourGuardReleaseAt(accountId, account.claudeFiveHourResetsAt)
    const releaseAtMs = Date.parse(releaseAt)
    if (!Number.isFinite(releaseAtMs)) {
      return { active: false, expired: false, reason, releaseAt: null }
    }

    return {
      active: Date.now() < releaseAtMs,
      expired: Date.now() >= releaseAtMs,
      reason,
      releaseAt
    }
  }

  isFiveHourSnapshotExpired(accountId, account) {
    const releaseAt = calcFiveHourGuardReleaseAt(accountId, account?.claudeFiveHourResetsAt)
    const releaseAtMs = Date.parse(releaseAt)
    return Number.isFinite(releaseAtMs) && Date.now() >= releaseAtMs
  }

  resolveLocalRequestWindow(accountId, account) {
    const storedResetAt = account?.nurtureLocalWindowResetAt
    const storedReleaseAt = account?.nurtureLocalWindowReleaseAt
    const storedReleaseAtMs = Date.parse(storedReleaseAt)
    if (Number.isFinite(storedReleaseAtMs)) {
      return {
        resetAt: storedResetAt || null,
        releaseAt: storedReleaseAt,
        expired: Date.now() >= storedReleaseAtMs
      }
    }

    const resetAt = account?.claudeFiveHourResetsAt || null
    const releaseAt = calcFiveHourGuardReleaseAt(accountId, resetAt)
    const releaseAtMs = Date.parse(releaseAt)
    return {
      resetAt,
      releaseAt,
      expired: Number.isFinite(releaseAtMs) && Date.now() >= releaseAtMs
    }
  }

  resolveNextLocalRequestWindow(accountId, account) {
    const currentWindow = this.resolveLocalRequestWindow(accountId, account)
    if (currentWindow.releaseAt && !currentWindow.expired) {
      return currentWindow
    }

    let resetAtMs = Date.parse(account?.claudeFiveHourResetsAt)
    if (!Number.isFinite(resetAtMs)) {
      resetAtMs = Date.parse(currentWindow.resetAt)
    }
    if (!Number.isFinite(resetAtMs)) {
      return { resetAt: null, releaseAt: null, expired: false }
    }

    let resetAt = new Date(resetAtMs).toISOString()
    let releaseAt = calcFiveHourGuardReleaseAt(accountId, resetAt)
    while (Date.parse(releaseAt) <= Date.now()) {
      resetAtMs += FIVE_HOUR_WINDOW_MS
      resetAt = new Date(resetAtMs).toISOString()
      releaseAt = calcFiveHourGuardReleaseAt(accountId, resetAt)
    }

    return { resetAt, releaseAt, expired: false }
  }

  async evaluate(accountId, options = {}) {
    const systemConfig = await accountNurtureConfigService.getConfig()
    if (!systemConfig.enabled) {
      return { blocked: false, active: false, reason: null }
    }

    let account = await redis.getClaudeAccount(accountId)
    if (!account || !isTruthyFlag(account.nurtureEnabled)) {
      return { blocked: false, active: false, reason: null }
    }

    const tier = await this.resolveAndSyncTier(accountId, account)
    if (!tier) {
      return { blocked: false, active: false, reason: null }
    }

    let fiveHourGuard = this.resolveFiveHourGuard(accountId, account)
    const expiredFiveHourSnapshot = this.isFiveHourSnapshotExpired(accountId, account)

    if (!options.skipUsageRefresh && !fiveHourGuard.active) {
      account = await this.maybeRefreshUsageSnapshot(accountId, account, systemConfig, {
        force: fiveHourGuard.expired || expiredFiveHourSnapshot
      })
      fiveHourGuard = this.resolveFiveHourGuard(accountId, account)
    }

    const config = await this.getEffectiveConfig(accountId, account)
    const limits = this.resolveDailyLimits(config, account, tier)

    const fiveHourSnapshotExpired = this.isFiveHourSnapshotExpired(accountId, account)
    const fiveHourUtil = fiveHourSnapshotExpired
      ? null
      : toNumberOrNull(account.claudeFiveHourUtilization)
    const sevenDayUtil = toNumberOrNull(account.claudeSevenDayUtilization)
    const sevenDayOpusUtil = toNumberOrNull(account.claudeSevenDayOpusUtilization)
    const localWindow = this.resolveLocalRequestWindow(accountId, account)
    const legacyLocalWindowExpired =
      !localWindow.releaseAt && account.nurtureLocalCountDate !== getUtcDateKey()
    const localCount =
      localWindow.expired || legacyLocalWindowExpired
        ? 0
        : parseInt(account.nurtureLocalRequestCount || '0', 10)

    const rpmResult = await this.checkRpm(accountId, limits.rpmLimit, {
      increment: options.incrementRpm === true
    })

    let dayDelta = null
    let maxDailyDelta = null
    if (sevenDayUtil !== null) {
      const baseline = await this.ensureSevenDayBaseline(accountId, sevenDayUtil)
      dayDelta = sevenDayUtil - baseline
      maxDailyDelta =
        limits.phase === 'steady'
          ? limits.steadyCaps.sevenDayVelocity
          : config.maxDailySevenDayDelta[tier]
      if (limits.phase === 'steady') {
        const dynamicVelocityLimit = calcSevenDaySteadyVelocityLimit(
          limits.steadyCaps.sevenDay,
          sevenDayUtil,
          account.claudeSevenDayResetsAt,
          config.paceBuffer
        )
        if (dynamicVelocityLimit !== null) {
          maxDailyDelta = Math.min(maxDailyDelta, dynamicVelocityLimit)
        }
      }
    }

    const actual = {
      fiveHourUtil,
      sevenDayUtil,
      sevenDayOpusUtil,
      localCount,
      localWindowResetAt: localWindow.resetAt,
      localWindowReleaseAt: localWindow.releaseAt,
      dayDelta,
      maxDailyDelta,
      rpm: rpmResult
    }

    if (rpmResult.blocked) {
      return this._buildResult(true, 'rpm', tier, limits, actual)
    }

    if (fiveHourGuard.active) {
      return this._buildResult(true, fiveHourGuard.reason, tier, limits, actual, {
        blockExpiresAt: fiveHourGuard.releaseAt
      })
    }

    if (fiveHourUtil !== null && fiveHourUtil >= limits.fiveHourLimit) {
      const reason = limits.phase === 'steady' ? 'five_hour_steady' : 'five_hour_curve'
      return this._buildResult(true, reason, tier, limits, actual, {
        blockExpiresAt: calcFiveHourGuardReleaseAt(accountId, account.claudeFiveHourResetsAt),
        blockWindowResetAt: account.claudeFiveHourResetsAt || null
      })
    }

    if (sevenDayUtil !== null && sevenDayUtil >= limits.sevenDayLimit) {
      let reason = 'seven_day_steady'
      if (limits.phase === 'nurturing' && sevenDayUtil >= limits.curve.sevenDay) {
        reason = 'seven_day_curve'
      } else if (
        limits.paceSevenDay !== null &&
        sevenDayUtil >= limits.paceSevenDay &&
        sevenDayUtil < limits.steadyCaps.sevenDay
      ) {
        reason = 'seven_day_pace'
      }
      return this._buildResult(true, reason, tier, limits, actual)
    }

    if (sevenDayOpusUtil !== null && sevenDayOpusUtil >= limits.sevenDayOpusLimit) {
      return this._buildResult(true, 'seven_day_opus', tier, limits, actual)
    }

    if (dayDelta !== null && maxDailyDelta !== null && dayDelta > maxDailyDelta) {
      return this._buildResult(true, 'seven_day_velocity', tier, limits, actual)
    }

    if (limits.localRequestsLimit !== null && localCount >= limits.localRequestsLimit) {
      return this._buildResult(true, 'local_request_count', tier, limits, actual, {
        blockExpiresAt: localWindow.releaseAt,
        blockWindowResetAt: localWindow.resetAt
      })
    }

    const result = this._buildResult(false, null, tier, limits, {
      ...actual,
      windowProgress: calcSevenDayWindowProgress(account.claudeSevenDayResetsAt)
    })

    await this.clearStaleBlockReason(accountId, account)
    return result
  }

  _buildResult(blocked, reason, tier, limits, actual, metadata = {}) {
    return {
      blocked,
      active: true,
      reason,
      tier,
      phase: limits.phase,
      dayIndex: limits.dayIndex,
      limits,
      actual,
      ...metadata
    }
  }

  async clearStaleBlockReason(accountId, account) {
    if (!account?.nurtureLastBlockReason) {
      return
    }

    const previousReason = account.nurtureLastBlockReason
    account.nurtureLastBlockReason = ''
    account.nurtureLastEvaluatedAt = new Date().toISOString()
    delete account.nurtureFiveHourGuardReleaseAt
    delete account.nurtureFiveHourGuardWindowResetAt

    try {
      await redis.setClaudeAccount(accountId, account)
      logger.info(`Cleared stale nurture block reason ${previousReason} for account ${accountId}`)
    } catch (error) {
      logger.warn(
        `Failed to clear stale nurture block reason for account ${accountId}: ${error.message}`
      )
    }
  }

  async recordRequestSuccess(accountId) {
    const account = await redis.getClaudeAccount(accountId)
    if (!account || !isTruthyFlag(account.nurtureEnabled)) {
      return
    }

    const dateKey = getUtcDateKey()
    const localWindow = this.resolveLocalRequestWindow(accountId, account)
    const nextLocalWindow = this.resolveNextLocalRequestWindow(accountId, account)
    if (localWindow.expired) {
      account.nurtureLocalCountDate = dateKey
      account.nurtureLocalRequestCount = '1'
    } else if (!localWindow.releaseAt && account.nurtureLocalCountDate !== dateKey) {
      account.nurtureLocalCountDate = dateKey
      account.nurtureLocalRequestCount = '1'
    } else {
      const current = parseInt(account.nurtureLocalRequestCount || '0', 10)
      account.nurtureLocalRequestCount = String(current + 1)
      account.nurtureLocalCountDate = dateKey
    }

    if (nextLocalWindow.releaseAt) {
      account.nurtureLocalWindowResetAt = nextLocalWindow.resetAt
      account.nurtureLocalWindowReleaseAt = nextLocalWindow.releaseAt
    }

    account.nurtureLastBlockReason = ''
    account.nurtureLastEvaluatedAt = new Date().toISOString()
    delete account.nurtureFiveHourGuardReleaseAt
    delete account.nurtureFiveHourGuardWindowResetAt
    await redis.setClaudeAccount(accountId, account)
  }

  async recordBlocked(accountId, evaluation) {
    const account = await redis.getClaudeAccount(accountId)
    if (!account) {
      return
    }
    account.nurtureLastBlockReason = evaluation.reason || ''
    account.nurtureLastEvaluatedAt = new Date().toISOString()
    if (isFiveHourBlockReason(evaluation.reason)) {
      const releaseAt =
        evaluation.blockExpiresAt ||
        calcFiveHourGuardReleaseAt(accountId, account.claudeFiveHourResetsAt)
      account.nurtureFiveHourGuardReleaseAt = releaseAt || ''
      account.nurtureFiveHourGuardWindowResetAt =
        evaluation.blockWindowResetAt || account.claudeFiveHourResetsAt || ''
    } else if (evaluation.reason === 'local_request_count') {
      const localWindow = this.resolveNextLocalRequestWindow(accountId, account)
      account.nurtureLocalWindowResetAt = evaluation.blockWindowResetAt || localWindow.resetAt || ''
      account.nurtureLocalWindowReleaseAt = evaluation.blockExpiresAt || localWindow.releaseAt || ''
      delete account.nurtureFiveHourGuardReleaseAt
      delete account.nurtureFiveHourGuardWindowResetAt
    } else {
      delete account.nurtureFiveHourGuardReleaseAt
      delete account.nurtureFiveHourGuardWindowResetAt
    }
    await redis.setClaudeAccount(accountId, account)
  }

  buildInitialNurtureFields(tier, enabled) {
    const now = new Date().toISOString()
    return {
      nurtureEnabled: enabled ? 'true' : 'false',
      nurturePhase: enabled ? 'nurturing' : '',
      nurtureTier: enabled ? tier : '',
      nurtureStartedAt: enabled ? now : '',
      nurtureDayIndex: enabled ? '1' : '',
      nurtureDailySeed: enabled ? getUtcDateKey() : '',
      nurtureGraduatedAt: '',
      nurtureLocalRequestCount: '0',
      nurtureLocalCountDate: getUtcDateKey(),
      nurtureLocalWindowResetAt: '',
      nurtureLocalWindowReleaseAt: '',
      nurtureOverrideEnabled: 'false',
      nurtureOverrideSteadyCaps: '',
      nurtureLastBlockReason: '',
      nurtureLastEvaluatedAt: '',
      nurtureFiveHourGuardReleaseAt: '',
      nurtureFiveHourGuardWindowResetAt: ''
    }
  }

  async initializeForAccount(accountId, tier, enabled) {
    if (!enabled || !tier) {
      return
    }
    const account = await redis.getClaudeAccount(accountId)
    if (!account) {
      return
    }
    Object.assign(account, this.buildInitialNurtureFields(tier, true))
    await redis.setClaudeAccount(accountId, account)
  }

  async advanceToSteady(accountId) {
    const account = await redis.getClaudeAccount(accountId)
    if (!account) {
      return null
    }
    account.nurturePhase = 'steady'
    account.nurtureGraduatedAt = new Date().toISOString()
    await redis.setClaudeAccount(accountId, account)
    return account
  }

  async resetToDayOne(accountId) {
    const account = await redis.getClaudeAccount(accountId)
    if (!account) {
      return null
    }
    account.nurturePhase = 'nurturing'
    account.nurtureDayIndex = '1'
    account.nurtureStartedAt = new Date().toISOString()
    account.nurtureDailySeed = getUtcDateKey()
    account.nurtureGraduatedAt = ''
    account.nurtureLocalRequestCount = '0'
    account.nurtureLocalCountDate = getUtcDateKey()
    delete account.nurtureLocalWindowResetAt
    delete account.nurtureLocalWindowReleaseAt
    account.nurtureLastBlockReason = ''
    delete account.nurtureFiveHourGuardReleaseAt
    delete account.nurtureFiveHourGuardWindowResetAt
    await redis.setClaudeAccount(accountId, account)
    return account
  }

  async disableNurture(accountId) {
    const account = await redis.getClaudeAccount(accountId)
    if (!account) {
      return null
    }
    account.nurtureEnabled = 'false'
    account.nurturePhase = ''
    account.nurtureLastBlockReason = ''
    delete account.nurtureFiveHourGuardReleaseAt
    delete account.nurtureFiveHourGuardWindowResetAt
    await redis.setClaudeAccount(accountId, account)
    return account
  }

  async rolloverDayIndexes() {
    const config = await accountNurtureConfigService.getConfig()
    if (!config.enabled) {
      return { processed: 0, graduated: 0 }
    }

    const dateKey = getUtcDateKey()
    const lockKey = `nurture:rollover:${dateKey}`
    const lockValue = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
    const lockAcquired = await redis.setAccountLock(lockKey, lockValue, 3600000)
    if (!lockAcquired) {
      return { processed: 0, graduated: 0, skipped: true }
    }

    try {
      const accounts = await claudeAccountService.getAllAccounts()
      let processed = 0
      let graduated = 0

      for (const account of accounts) {
        if (!isTruthyFlag(account.nurtureEnabled)) {
          continue
        }

        const fullAccount = await redis.getClaudeAccount(account.id)
        if (!fullAccount?.nurtureStartedAt) {
          continue
        }

        const lastDate = fullAccount.nurtureLastRolloverDate || ''
        if (lastDate === dateKey) {
          continue
        }

        processed += 1
        let dayIndex = parseInt(fullAccount.nurtureDayIndex || '1', 10)
        if (fullAccount.nurturePhase !== 'steady') {
          dayIndex += 1
          if (dayIndex > 7) {
            fullAccount.nurturePhase = 'steady'
            fullAccount.nurtureGraduatedAt = new Date().toISOString()
            graduated += 1
          } else {
            fullAccount.nurtureDayIndex = String(dayIndex)
          }
        }

        fullAccount.nurtureDailySeed = dateKey
        fullAccount.nurtureLastRolloverDate = dateKey
        await redis.setClaudeAccount(account.id, fullAccount)
      }

      return { processed, graduated }
    } finally {
      await redis.releaseAccountLock(lockKey, lockValue)
    }
  }

  async getStatus(accountId) {
    const account = await redis.getClaudeAccount(accountId)
    if (!account || Object.keys(account).length === 0) {
      return null
    }
    const evaluation = await this.evaluate(accountId, { skipUsageRefresh: false })
    return {
      accountId,
      nurtureEnabled: isTruthyFlag(account?.nurtureEnabled),
      nurturePhase: account?.nurturePhase || null,
      nurtureTier: getNurtureTier(account) || account?.nurtureTier,
      nurtureDayIndex: parseInt(account?.nurtureDayIndex || '0', 10) || null,
      nurtureStartedAt: account?.nurtureStartedAt || null,
      nurtureGraduatedAt: account?.nurtureGraduatedAt || null,
      lastBlockReason: evaluation.blocked ? evaluation.reason : null,
      evaluation
    }
  }
}

const NURTURE_SCHEDULER_ERROR_CODES = {
  DEDICATED_LIMITED: 'CLAUDE_NURTURE_LIMITED',
  ALL_LIMITED: 'CLAUDE_ALL_NURTURE_LIMITED'
}

function calcNurtureRetryAfterSeconds(now = new Date()) {
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0)
  )
  return Math.max(60, Math.ceil((tomorrow.getTime() - now.getTime()) / 1000))
}

function createNurtureSchedulerError(code, { accountId, reason, message } = {}) {
  const error = new Error(message || 'Claude account nurture guard limit reached')
  error.code = code
  error.statusCode = 403
  if (accountId) {
    error.accountId = accountId
  }
  if (reason) {
    error.nurtureReason = reason
  }
  return error
}

function createAllNurtureLimitedError(evaluation = null) {
  return createNurtureSchedulerError(NURTURE_SCHEDULER_ERROR_CODES.ALL_LIMITED, {
    reason: evaluation?.reason || null,
    message: 'All available Claude accounts are currently blocked by nurture guard limits'
  })
}

function createDedicatedNurtureLimitedError(accountId, evaluation = null) {
  return createNurtureSchedulerError(NURTURE_SCHEDULER_ERROR_CODES.DEDICATED_LIMITED, {
    accountId,
    reason: evaluation?.reason || null,
    message: 'Dedicated Claude account reached nurture guard limit'
  })
}

function isNurtureSchedulerError(error) {
  return (
    error?.code === NURTURE_SCHEDULER_ERROR_CODES.DEDICATED_LIMITED ||
    error?.code === NURTURE_SCHEDULER_ERROR_CODES.ALL_LIMITED
  )
}

function buildNurtureLimitBody(reason) {
  return {
    error: {
      type: 'nurture_limit_reached',
      code: 'nurture_limit_reached',
      message: '账号养号护栏已达今日或当前窗口上限，请稍后重试。',
      reason: reason || null
    }
  }
}

function buildNurtureLimitHttpResponse(reason, statusCode = 403) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(calcNurtureRetryAfterSeconds())
    },
    body: JSON.stringify(buildNurtureLimitBody(reason))
  }
}

function buildRetryableNurtureLimitHttpResponse(reason) {
  return {
    statusCode: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': '1'
    },
    body: JSON.stringify({
      error: {
        type: 'rate_limit_error',
        code: 'crs_rate_limited',
        message: 'CRS selected account reached its nurture guard limit; retry another channel.',
        metadata: {
          source: 'claude-relay-service',
          retryable: true,
          disable_channel: false,
          limit_kind: 'nurture',
          nurture_reason: reason || null
        }
      }
    })
  }
}

module.exports = new ClaudeAccountNurtureService()
module.exports.getNurtureTier = getNurtureTier
module.exports.isProAccount = isProAccount
module.exports.isMaxAccount = isMaxAccount
module.exports.calcFiveHourGuardReleaseAt = calcFiveHourGuardReleaseAt
module.exports.NURTURE_SCHEDULER_ERROR_CODES = NURTURE_SCHEDULER_ERROR_CODES
module.exports.calcNurtureRetryAfterSeconds = calcNurtureRetryAfterSeconds
module.exports.createNurtureSchedulerError = createNurtureSchedulerError
module.exports.createAllNurtureLimitedError = createAllNurtureLimitedError
module.exports.createDedicatedNurtureLimitedError = createDedicatedNurtureLimitedError
module.exports.isNurtureSchedulerError = isNurtureSchedulerError
module.exports.buildNurtureLimitBody = buildNurtureLimitBody
module.exports.buildNurtureLimitHttpResponse = buildNurtureLimitHttpResponse
module.exports.buildRetryableNurtureLimitHttpResponse = buildRetryableNurtureLimitHttpResponse
