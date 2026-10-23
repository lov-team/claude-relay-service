const logger = require('./logger')
const { normalizeTempUnavailablePolicyFromAccountData } = require('./tempUnavailablePolicy')

const TEMP_UNAVAILABLE_PREFIX = 'temp_unavailable'
const ERROR_HISTORY_PREFIX = 'error_history'
const ERROR_HISTORY_MAX = 5000
const ERROR_HISTORY_TTL = 3 * 24 * 60 * 60 // 3天

// 上游冷却超过该时长（秒）时，账号不再走 temp_unavailable 短冷却，
// 直接落到「不可调度」状态（复用 fiveHourAutoStopped 路径，与
// 「5小时使用量接近限制，已自动停止调度」一致）。
// sessionWindowEnd 被推进到冷却结束时刻，后台恢复任务据此在冷却结束后
// 自动拉起账号（+1 分钟缓冲），实现按上游承诺时间的精准恢复。
const LONG_COOLDOWN_UNSCHEDULABLE_SECONDS = 3600

// 默认 TTL（秒）
const DEFAULT_TTL = {
  server_error: 300, // 5xx: 5分钟
  service_unavailable: 60, // 503: 1分钟（默认更短，避免短暂抖动导致长时间不可路由）
  overload: 600, // 529: 10分钟
  auth_error: 1800, // 401/403: 30分钟
  timeout: 300, // 504/网络超时: 5分钟
  rate_limit: 300 // 429: 5分钟（优先使用响应头解析值）
}

// 上游 retry-after 派生 TTL 的上限（秒）。
// temp-unavailable 只用于「短暂抖动」的冷却；而周级限额的 retry-after 可达数天，
// 直接采纳会把账号整整下线数天，且账号哈希看起来完全正常（该键是独立的 TTL 键），
// 极难排查。真正的长时限额应由 markAccountRateLimited / 各模型家族限流桶承担。
const DEFAULT_MAX_CUSTOM_TTL = 1800 // 30 分钟

// 延迟加载配置，避免循环依赖
let _configCache = null
const getConfig = () => {
  if (!_configCache) {
    try {
      _configCache = require('../../config/config')
    } catch {
      _configCache = {}
    }
  }
  return _configCache
}

const getTtlConfig = () => {
  const config = getConfig()
  const parseEnvPositiveInt = (name) => {
    const value = parseInt(process.env[name], 10)
    return Number.isFinite(value) && value > 0 ? value : null
  }

  return {
    service_unavailable:
      config.upstreamError?.serviceUnavailableTtlSeconds ??
      parseEnvPositiveInt('UPSTREAM_ERROR_503_TTL_SECONDS') ??
      DEFAULT_TTL.service_unavailable,
    server_error: config.upstreamError?.serverErrorTtlSeconds ?? DEFAULT_TTL.server_error,
    overload: config.upstreamError?.overloadTtlSeconds ?? DEFAULT_TTL.overload,
    auth_error: config.upstreamError?.authErrorTtlSeconds ?? DEFAULT_TTL.auth_error,
    timeout: config.upstreamError?.timeoutTtlSeconds ?? DEFAULT_TTL.timeout,
    rate_limit: DEFAULT_TTL.rate_limit,
    max_custom:
      config.upstreamError?.maxCustomTtlSeconds ??
      parseEnvPositiveInt('UPSTREAM_ERROR_MAX_CUSTOM_TTL_SECONDS') ??
      DEFAULT_MAX_CUSTOM_TTL
  }
}

// 延迟加载 redis，避免循环依赖
let _redis = null
const getRedis = () => {
  if (!_redis) {
    _redis = require('../models/redis')
  }
  return _redis
}

// 可读取账号级临时暂停配置的 Redis key 前缀映射
const ACCOUNT_KEY_PREFIX_BY_TYPE = {
  'claude-official': 'claude:account:',
  claude: 'claude:account:'
}

const EMPTY_TEMP_UNAVAILABLE_POLICY = {
  disableTempUnavailable: false,
  ttl503Seconds: null,
  ttl5xxSeconds: null
}

const getAccountTempUnavailablePolicy = async (accountId, accountType) => {
  try {
    const accountPrefix = ACCOUNT_KEY_PREFIX_BY_TYPE[accountType]
    if (!accountPrefix) {
      return EMPTY_TEMP_UNAVAILABLE_POLICY
    }

    const redis = getRedis()
    const client = redis.getClientSafe()
    const accountData = await client.hgetall(`${accountPrefix}${accountId}`)
    if (!accountData || Object.keys(accountData).length === 0) {
      return EMPTY_TEMP_UNAVAILABLE_POLICY
    }

    return { ...normalizeTempUnavailablePolicyFromAccountData(accountData), accountData }
  } catch (error) {
    logger.warn(
      `⚠️ [UpstreamError] Failed to load account temp-unavailable policy for ${accountType}:${accountId}: ${error.message}`
    )
    return EMPTY_TEMP_UNAVAILABLE_POLICY
  }
}

const resolveAccountTtlOverride = ({ policy, statusCode, errorType }) => {
  if (!policy) {
    return { skip: false, ttlOverrideSeconds: null, reason: '' }
  }

  if (policy.disableTempUnavailable) {
    return {
      skip: true,
      ttlOverrideSeconds: null,
      reason: 'account_temp_unavailable_disabled'
    }
  }

  if (statusCode === 503 && policy.ttl503Seconds !== null) {
    if (policy.ttl503Seconds <= 0) {
      return {
        skip: true,
        ttlOverrideSeconds: null,
        reason: 'account_503_ttl_disabled'
      }
    }
    return {
      skip: false,
      ttlOverrideSeconds: policy.ttl503Seconds,
      reason: 'account_503_ttl_override'
    }
  }

  if (errorType === 'server_error' && policy.ttl5xxSeconds !== null) {
    if (policy.ttl5xxSeconds <= 0) {
      return {
        skip: true,
        ttlOverrideSeconds: null,
        reason: 'account_5xx_ttl_disabled'
      }
    }
    return {
      skip: false,
      ttlOverrideSeconds: policy.ttl5xxSeconds,
      reason: 'account_5xx_ttl_override'
    }
  }

  return { skip: false, ttlOverrideSeconds: null, reason: '' }
}

// 根据 HTTP 状态码分类错误类型
const classifyError = (statusCode) => {
  if (statusCode === 529) {
    return 'overload'
  }
  if (statusCode === 503) {
    return 'service_unavailable'
  }
  if (statusCode === 504) {
    return 'timeout'
  }
  if (statusCode === 401 || statusCode === 403) {
    return 'auth_error'
  }
  if (statusCode === 429) {
    return 'rate_limit'
  }
  if (statusCode >= 500) {
    return 'server_error'
  }
  return null
}

// 解析 429 响应头中的重置时间（返回秒数）
const parseRetryAfter = (headers) => {
  if (!headers) {
    return null
  }

  // 标准 Retry-After 头（秒数或 HTTP 日期）
  const retryAfter = headers['retry-after']
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds) && seconds > 0) {
      return seconds
    }
    const date = new Date(retryAfter)
    if (!isNaN(date.getTime())) {
      const diff = Math.ceil((date.getTime() - Date.now()) / 1000)
      if (diff > 0) {
        return diff
      }
    }
  }

  // Anthropic 限流重置头（ISO 时间）
  const anthropicReset = headers['anthropic-ratelimit-unified-reset']
  if (anthropicReset) {
    const date = new Date(anthropicReset)
    if (!isNaN(date.getTime())) {
      const diff = Math.ceil((date.getTime() - Date.now()) / 1000)
      if (diff > 0) {
        return diff
      }
    }
  }

  // OpenAI/Codex 限流重置头
  const xReset = headers['x-ratelimit-reset-requests'] || headers['x-codex-ratelimit-reset']
  if (xReset) {
    const seconds = parseInt(xReset, 10)
    if (!isNaN(seconds) && seconds > 0) {
      return seconds
    }
  }

  return null
}

// 记录错误历史到 Redis List
const recordErrorHistory = async (
  accountId,
  accountType,
  statusCode,
  errorType,
  context = null
) => {
  try {
    const redis = getRedis()
    const client = redis.getClientSafe()
    const redisKey = `${ERROR_HISTORY_PREFIX}:${accountType}:${accountId}`

    const entry = JSON.stringify({
      time: new Date().toISOString(),
      status: statusCode,
      errorType,
      context: context
        ? {
            ...context,
            errorBody:
              typeof context.errorBody === 'string'
                ? context.errorBody.slice(0, 2000)
                : context.errorBody
                  ? JSON.stringify(context.errorBody).slice(0, 2000)
                  : undefined
          }
        : null
    })

    const pipeline = client.pipeline()
    pipeline.lpush(redisKey, entry)
    pipeline.ltrim(redisKey, 0, ERROR_HISTORY_MAX - 1)
    pipeline.expire(redisKey, ERROR_HISTORY_TTL)
    await pipeline.exec()
  } catch (err) {
    logger.warn(`⚠️ [ErrorHistory] Failed to record error history for ${accountId}: ${err.message}`)
  }
}

// 查询错误历史（分页）
const getErrorHistory = async (accountType, accountId, offset = 0, limit = 50) => {
  try {
    const redis = getRedis()
    const client = redis.getClientSafe()
    const o = Math.max(0, Math.floor(offset))
    const l = Math.min(500, Math.max(1, Math.floor(limit)))
    const redisKey = `${ERROR_HISTORY_PREFIX}:${accountType}:${accountId}`
    const list = await client.lrange(redisKey, o, o + l - 1)
    return list
      .map((item) => {
        try {
          return JSON.parse(item)
        } catch {
          return null
        }
      })
      .filter((item) => item?.time)
  } catch (error) {
    logger.error(`❌ [ErrorHistory] Failed to get error history for ${accountId}:`, error)
    return []
  }
}

// 清除错误历史
const clearErrorHistory = async (accountType, accountId) => {
  try {
    const redis = getRedis()
    const client = redis.getClientSafe()
    const redisKey = `${ERROR_HISTORY_PREFIX}:${accountType}:${accountId}`
    await client.del(redisKey)
  } catch (error) {
    logger.error(`❌ [ErrorHistory] Failed to clear error history for ${accountId}:`, error)
  }
}

// 标记账户为临时不可用
const markTempUnavailable = async (
  accountId,
  accountType,
  statusCode,
  customTtl = null,
  context = null
) => {
  try {
    const errorType = classifyError(statusCode)
    if (!errorType) {
      return { success: false, reason: 'not_a_pausable_error' }
    }

    const policy = await getAccountTempUnavailablePolicy(accountId, accountType)
    const policyDecision = resolveAccountTtlOverride({
      policy,
      statusCode,
      errorType
    })

    const key = `${TEMP_UNAVAILABLE_PREFIX}:${accountType}:${accountId}`
    if (policyDecision.skip) {
      const redis = getRedis()
      const client = redis.getClientSafe()
      await client.del(key).catch(() => {})
      logger.info(
        `⏭️ [UpstreamError] Skip temp-unavailable for account ${accountId} (${accountType}), reason: ${policyDecision.reason}`
      )
      return { success: true, skipped: true, reason: policyDecision.reason }
    }

    const ttlConfig = getTtlConfig()
    const parsedCustomTtl = Number(customTtl)
    const requestedTtl =
      Number.isFinite(parsedCustomTtl) && parsedCustomTtl > 0 ? Math.ceil(parsedCustomTtl) : 0
    let ttlSeconds
    if (requestedTtl > 0) {
      // 上游 retry-after 可能是周级限额（数天），必须钳制，否则账号会被长时间下线
      ttlSeconds = Math.min(requestedTtl, ttlConfig.max_custom)
      if (ttlSeconds < requestedTtl) {
        logger.warn(
          `⚠️ [UpstreamError] Upstream retry-after ${requestedTtl}s for account ${accountId} (${accountType}) exceeds temp-unavailable cap, clamping to ${ttlSeconds}s`
        )
      }
    } else {
      ttlSeconds = ttlConfig[errorType]
    }

    // 上游要求的长冷却（>1小时）不适合 temp_unavailable：key 钳到 30 分钟后
    // 账号会提前回到流量池继续打满额账号。直接把账号打为不可调度，复用
    // fiveHourAutoStopped 的既有展示/恢复路径（5小时使用量接近限制，已自动停止调度）。
    if (requestedTtl > LONG_COOLDOWN_UNSCHEDULABLE_SECONDS) {
      const stopped = await markAccountUnschedulableForLongCooldown(
        accountId,
        accountType,
        statusCode,
        requestedTtl,
        policy.accountData
      )
      if (stopped) {
        return {
          success: true,
          skipped: true,
          reason: 'long_cooldown_unschedulable',
          requestedTtl
        }
      }
    }
    if (
      Number.isFinite(policyDecision.ttlOverrideSeconds) &&
      policyDecision.ttlOverrideSeconds > 0
    ) {
      ttlSeconds = policyDecision.ttlOverrideSeconds
    }
    if (statusCode === 429 && policy.accountData) {
      try {
        const { getNurtureRateLimitCooldownSeconds } = require('./accountNurtureDefaults')
        const nurtureConfig = await require('../services/accountNurtureConfigService').getConfig()
        const nurtureCooldown = getNurtureRateLimitCooldownSeconds(
          nurtureConfig,
          policy.accountData
        )
        if (nurtureCooldown !== null) {
          // 普通 429 使用养号冷却；上游明确的 Retry-After 作为下限。
          ttlSeconds = Math.max(
            nurtureCooldown,
            Number.isFinite(parsedCustomTtl) && parsedCustomTtl > 0 ? ttlSeconds : 0
          )
        }
      } catch (error) {
        logger.warn(`Failed to resolve nurture 429 cooldown for ${accountId}: ${error.message}`)
      }
    }
    const markedAtIso = new Date().toISOString()
    const expiresAtIso = new Date(Date.now() + ttlSeconds * 1000).toISOString()

    const redis = getRedis()
    const client = redis.getClientSafe()
    await client.setex(
      key,
      ttlSeconds,
      JSON.stringify({
        statusCode,
        errorType,
        markedAt: markedAtIso,
        ttlSeconds,
        cooldownSeconds: ttlSeconds,
        expiresAt: expiresAtIso
      })
    )

    logger.warn(
      `⏱️ [UpstreamError] Account ${accountId} (${accountType}) marked temporarily unavailable for ${ttlSeconds}s (${statusCode} ${errorType}), recovers at ${expiresAtIso}`
    )

    // 异步记录错误历史，不阻塞主流程
    recordErrorHistory(accountId, accountType, statusCode, errorType, context).catch(() => {})

    return { success: true, ttlSeconds, errorType, expiresAt: expiresAtIso }
  } catch (error) {
    logger.error(
      `❌ [UpstreamError] Failed to mark account ${accountId} temporarily unavailable:`,
      error
    )
    return { success: false }
  }
}

// 将长冷却账号标记为不可调度（复用 fiveHourAutoStopped 路径）。
// 仅支持 claude 账户哈希；其他账号类型没有该字段约定，跳过并走钳制冷却。
const markAccountUnschedulableForLongCooldown = async (
  accountId,
  accountType,
  statusCode,
  requestedTtl,
  accountData
) => {
  if (accountType !== 'claude-official' && accountType !== 'claude') {
    return false
  }
  if (!accountData || Object.keys(accountData).length === 0) {
    return false
  }
  if (accountData.disableAutoProtection === true || accountData.disableAutoProtection === 'true') {
    logger.info(
      `🛡️ [UpstreamError] Account ${accountData.name || accountId} (${accountId}) has auto-protection disabled, skipping long-cooldown unschedulable`
    )
    return false
  }
  if (accountData.schedulable === 'false' && accountData.fiveHourAutoStopped === 'true') {
    logger.debug(
      `⏭️ [UpstreamError] Account ${accountId} already auto-stopped, skipping long-cooldown unschedulable`
    )
    return true
  }
  try {
    const redis = getRedis()
    const until = new Date(Date.now() + requestedTtl * 1000)
    const untilIso = until.toISOString()
    const update = {
      schedulable: 'false',
      fiveHourAutoStopped: 'true',
      fiveHourStoppedAt: new Date().toISOString(),
      stoppedReason: '5小时使用量接近限制，已自动停止调度'
    }
    // 精准恢复：把会话窗口结束时间推进到上游冷却结束时刻。
    // checkAndRecoverFiveHourStoppedAccounts 只认 sessionWindowEnd（+60s 缓冲）
    // 作为到期信号；旧窗口结束时间若晚于冷却结束，保留旧值不动。
    const oldEndMs = Date.parse(accountData.sessionWindowEnd || '')
    if (!Number.isFinite(oldEndMs) || oldEndMs < until.getTime()) {
      update.sessionWindowEnd = untilIso
      if (!accountData.sessionWindowStart) {
        update.sessionWindowStart = new Date(until.getTime() - 5 * 60 * 60 * 1000).toISOString()
      }
    }
    const stoppedReason = update.stoppedReason
    await redis.setClaudeAccount(accountId, update)
    logger.warn(
      `🚫 [UpstreamError] Account ${accountData.name || accountId} (${accountId}) unschedulable: upstream cooldown ${requestedTtl}s (${statusCode}) exceeds ${LONG_COOLDOWN_UNSCHEDULABLE_SECONDS}s, recovers at ${untilIso}`
    )
    try {
      const webhookNotifier = require('./webhookNotifier')
      await webhookNotifier.sendAccountAnomalyNotification({
        accountId,
        accountName: accountData.name || 'Claude Account',
        platform: 'claude',
        status: 'warning',
        errorCode: 'CLAUDE_LONG_COOLDOWN_STOPPED',
        reason: stoppedReason,
        timestamp: new Date().toISOString()
      })
    } catch (webhookError) {
      logger.error('Failed to send long-cooldown webhook notification:', webhookError)
    }
    return true
  } catch (error) {
    logger.error(
      `❌ [UpstreamError] Failed to mark account ${accountId} unschedulable for long cooldown:`,
      error
    )
    return false
  }
}

// 检查账户是否临时不可用
const isTempUnavailable = async (accountId, accountType) => {
  try {
    const redis = getRedis()
    const client = redis.getClientSafe()
    const key = `${TEMP_UNAVAILABLE_PREFIX}:${accountType}:${accountId}`
    const ttl = await client.ttl(key)

    if (ttl === -2) {
      return false
    }

    if (ttl === -1) {
      // 理论上该 key 必须带 TTL；如果无 TTL，自动清理以避免“永久不可用”
      logger.warn(
        `⚠️ [UpstreamError] Found temp_unavailable key without TTL for account ${accountId} (${accountType}), auto-clearing`
      )
      await client.del(key)
      return false
    }

    return ttl > 0
  } catch (error) {
    logger.error(
      `❌ [UpstreamError] Failed to check temp unavailable status for ${accountId}:`,
      error
    )
    return false
  }
}

const getTempUnavailableInfo = async (accountId, accountType) => {
  try {
    const redis = getRedis()
    const client = redis.getClientSafe()
    const key = `${TEMP_UNAVAILABLE_PREFIX}:${accountType}:${accountId}`
    const ttl = await client.ttl(key)

    if (!Number.isFinite(ttl) || ttl <= 0) {
      return null
    }

    let expiresAt = null
    const value = await client.get(key)
    if (value) {
      try {
        const data = JSON.parse(value)
        expiresAt = data.expiresAt || null
      } catch {
        expiresAt = null
      }
    }

    return {
      remainingSeconds: ttl,
      expiresAt
    }
  } catch (error) {
    logger.warn(
      `⚠️ [UpstreamError] Failed to read temp unavailable TTL for ${accountId} (${accountType}): ${error.message}`
    )
    return null
  }
}

const isTempUnavailableSchedulerError = (error) =>
  error?.code === 'CLAUDE_ALL_TEMPORARILY_UNAVAILABLE'

const buildTempUnavailableHttpResponse = (error) => {
  const retryAfterSeconds = Math.max(1, Math.ceil(Number(error?.retryAfterSeconds) || 1))
  const retryAt = error?.temporaryUnavailableUntil || null
  // 账号只是临时冷却，不是渠道失效。new-api 按状态码自动禁用时，503 会把渠道关掉；
  // 回 429 + disable_channel:false，让它换渠道重试，而不是自动禁用。
  return {
    statusCode: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSeconds),
      'retry-after': String(retryAfterSeconds)
    },
    body: JSON.stringify({
      error: {
        type: 'rate_limit_error',
        code: 'accounts_temporarily_unavailable',
        message: 'All available Claude accounts are temporarily unavailable.',
        metadata: {
          source: 'claude-relay-service',
          retryable: true,
          disable_channel: false,
          retry_after_seconds: retryAfterSeconds,
          retry_at: retryAt
        }
      }
    })
  }
}

// 清除临时不可用状态
const clearTempUnavailable = async (accountId, accountType) => {
  try {
    const redis = getRedis()
    const client = redis.getClientSafe()
    const key = `${TEMP_UNAVAILABLE_PREFIX}:${accountType}:${accountId}`
    await client.del(key)
  } catch (error) {
    logger.error(`❌ [UpstreamError] Failed to clear temp unavailable for ${accountId}:`, error)
  }
}

// 批量查询所有临时不可用状态（用于前端展示）
const getAllTempUnavailable = async () => {
  try {
    const redis = getRedis()
    const client = redis.getClientSafe()
    const pattern = `${TEMP_UNAVAILABLE_PREFIX}:*`
    const keys = await client.keys(pattern)
    if (!keys.length) {
      return {}
    }

    const pipeline = client.pipeline()
    for (const key of keys) {
      pipeline.get(key)
      pipeline.ttl(key)
    }
    const results = await pipeline.exec()
    const cleanupPipeline = client.pipeline()

    const statuses = {}
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      // key format: temp_unavailable:{accountType}:{accountId}
      const parts = key.split(':')
      const accountType = parts[1]
      const accountId = parts.slice(2).join(':')
      const [getErr, value] = results[i * 2]
      const [ttlErr, ttl] = results[i * 2 + 1]
      if (getErr || ttlErr || !value) {
        continue
      }

      if (ttl === -1) {
        // 自愈：清理无 TTL 的异常键，避免账户被永久阻塞
        cleanupPipeline.del(key)
        continue
      }

      try {
        const data = JSON.parse(value)
        const compositeKey = `${accountType}:${accountId}`
        const cooldownSecondsRaw = Number(data.cooldownSeconds)
        const ttlSecondsRaw = Number(data.ttlSeconds)
        const configuredCooldownSeconds = Number.isFinite(cooldownSecondsRaw)
          ? Math.max(0, Math.floor(cooldownSecondsRaw))
          : Number.isFinite(ttlSecondsRaw)
            ? Math.max(0, Math.floor(ttlSecondsRaw))
            : null

        statuses[compositeKey] = {
          accountId,
          accountType,
          statusCode: data.statusCode,
          errorType: data.errorType,
          markedAt: data.markedAt,
          ttl: ttl > 0 ? ttl : 0,
          remainingSeconds: ttl > 0 ? ttl : 0,
          cooldownSeconds: configuredCooldownSeconds,
          expiresAt: data.expiresAt || null
        }
      } catch {
        // ignore parse errors
      }
    }

    await cleanupPipeline.exec().catch(() => {})
    return statuses
  } catch (error) {
    logger.error('❌ [UpstreamError] Failed to get all temp unavailable statuses:', error)
    return {}
  }
}

// 清洗上游错误数据，去除内部路由标识（如 [codex/codex]）
const sanitizeErrorForClient = (errorData) => {
  if (!errorData || typeof errorData !== 'object') {
    return errorData
  }
  try {
    const str = JSON.stringify(errorData)
    const cleaned = str.replace(/ \[[^\]/]+\/[^\]]+\]/g, '')
    return JSON.parse(cleaned)
  } catch {
    return errorData
  }
}

module.exports = {
  markTempUnavailable,
  isTempUnavailable,
  getTempUnavailableInfo,
  isTempUnavailableSchedulerError,
  buildTempUnavailableHttpResponse,
  clearTempUnavailable,
  getAllTempUnavailable,
  classifyError,
  parseRetryAfter,
  sanitizeErrorForClient,
  recordErrorHistory,
  getErrorHistory,
  clearErrorHistory,
  TEMP_UNAVAILABLE_PREFIX,
  ERROR_HISTORY_PREFIX
}
