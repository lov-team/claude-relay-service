const logger = require('../utils/logger')
const webhookService = require('./webhookService')
const webhookNotifier = require('../utils/webhookNotifier')
const upstreamErrorHelper = require('../utils/upstreamErrorHelper')
const { getISOStringWithTimezone } = require('../utils/dateHelper')

const STATUS = {
  error: { key: 'error', label: '错误/认证异常' },
  quotaExpired: { key: 'quotaExpired', label: '配额或过期' },
  rateLimited: { key: 'rateLimited', label: '限流中' },
  tempUnavailable: { key: 'tempUnavailable', label: '临时暂停/过载' },
  tempError: { key: 'tempError', label: '临时异常' },
  paused: { key: 'paused', label: '已暂停' },
  normal: { key: 'normal', label: '正常' },
  unknown: { key: 'unknown', label: '未知' }
}

const STATUS_LIST = Object.values(STATUS)

const TEMP_UNAVAILABLE_ACCOUNT_TYPE_ALIASES = {
  claude: ['claude-official', 'claude'],
  'claude-console': ['claude-console'],
  bedrock: ['bedrock'],
  gemini: ['gemini'],
  'gemini-api': ['gemini-api'],
  openai: ['openai'],
  'openai-responses': ['openai-responses'],
  azure_openai: ['azure-openai'],
  'azure-openai': ['azure-openai'],
  ccr: ['ccr'],
  droid: ['droid']
}

const falseLike = (value) => value === false || value === 'false' || value === 0 || value === '0'
const trueLike = (value) => value === true || value === 'true' || value === 1 || value === '1'

const requireAccountSources = () => [
  {
    platform: 'claude',
    getAccounts: () => require('./account/claudeAccountService').getAllAccounts()
  },
  {
    platform: 'claude-console',
    getAccounts: () => require('./account/claudeConsoleAccountService').getAllAccounts()
  },
  {
    platform: 'bedrock',
    getAccounts: () => require('./account/bedrockAccountService').getAllAccounts()
  },
  {
    platform: 'gemini',
    getAccounts: () => require('./account/geminiAccountService').getAllAccounts()
  },
  {
    platform: 'gemini-api',
    getAccounts: () => require('./account/geminiApiAccountService').getAllAccounts()
  },
  {
    platform: 'openai',
    getAccounts: () => require('./account/openaiAccountService').getAllAccounts()
  },
  {
    platform: 'openai-responses',
    getAccounts: () => require('./account/openaiResponsesAccountService').getAllAccounts()
  },
  {
    platform: 'azure_openai',
    getAccounts: () => require('./account/azureOpenaiAccountService').getAllAccounts()
  },
  { platform: 'ccr', getAccounts: () => require('./account/ccrAccountService').getAllAccounts() },
  {
    platform: 'droid',
    getAccounts: () => require('./account/droidAccountService').getAllAccounts()
  }
]

const normalizeAccounts = (result) => {
  if (Array.isArray(result)) {
    return result
  }
  if (Array.isArray(result?.accounts)) {
    return result.accounts
  }
  return []
}

const getTempUnavailableStatus = (tempStatuses, account) => {
  if (!tempStatuses || !account?.id) {
    return null
  }

  const accountTypes = TEMP_UNAVAILABLE_ACCOUNT_TYPE_ALIASES[account.platform] || [account.platform]
  for (const accountType of accountTypes) {
    const status = tempStatuses[`${accountType}:${account.id}`]
    if (status) {
      return status
    }
  }

  return null
}

const isRateLimited = (account) =>
  account?.isRateLimited ||
  account?.status === 'rate_limited' ||
  account?.status === 'rateLimited' ||
  account?.rateLimitStatus === 'limited' ||
  account?.rateLimitStatus?.isRateLimited === true ||
  account?.opusRateLimitStatus?.isRateLimited === true

const isQuotaOrExpired = (account) => {
  if (!account) {
    return false
  }
  if (account.status === 'quota_exceeded' || account.status === 'quotaExceeded') {
    return true
  }
  if (trueLike(account.quotaAutoStopped) || account.quotaStoppedAt) {
    return true
  }

  if (!account.expiresAt) {
    return false
  }
  if (account.platform !== 'claude-console' && account.platform !== 'bedrock') {
    return false
  }

  const expiresAt = new Date(account.expiresAt).getTime()
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < Date.now()
}

const isOverloaded = (account) =>
  account?.overloadStatus === 'overloaded' || account?.overloadStatus?.isOverloaded === true

const isErrorStatus = (account) =>
  falseLike(account?.isActive) ||
  ['blocked', 'unauthorized', 'error', 'account_blocked'].includes(account?.status)

const getVitalityStatus = (account) => {
  if (!account) {
    return STATUS.unknown
  }
  if (isErrorStatus(account)) {
    return STATUS.error
  }
  if (isQuotaOrExpired(account)) {
    return STATUS.quotaExpired
  }
  if (isRateLimited(account)) {
    return STATUS.rateLimited
  }
  if (account.tempUnavailable || isOverloaded(account)) {
    return STATUS.tempUnavailable
  }
  if (account.status === 'temp_error') {
    return STATUS.tempError
  }
  if (falseLike(account.schedulable)) {
    return STATUS.paused
  }
  if (account.id || trueLike(account.isActive) || account.isActive === undefined) {
    return STATUS.normal
  }
  return STATUS.unknown
}

const getAccountName = (account) =>
  account?.name ||
  account?.email ||
  account?.accountName ||
  account?.displayName ||
  account?.username ||
  account?.id ||
  '未知账号'

const sanitize = (value) => {
  if (typeof value !== 'string') {
    return value
  }
  return value
    .replace(/:\/\/([^/\s:@]+):([^/\s@]+)@/g, '://$1:***@')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1***')
    .replace(
      /\b(token|refreshToken|accessToken|apiKey|api_key|secret|password|credentials)\b(\s*[:=]\s*)["']?([^"',\s}]+)/gi,
      (_match, key, separator) => `${key}${separator}***`
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|cr_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|ya29\.[A-Za-z0-9_-]{16,}|refresh_[A-Za-z0-9_-]{16,})\b/g,
      '***'
    )
}

const getReason = (account, status) => {
  if (status.key === 'error') {
    return sanitize(account?.errorMessage || account?.stoppedReason || '账号不可用或认证异常')
  }
  if (status.key === 'quotaExpired') {
    return sanitize(account?.errorMessage || '余额/配额不足')
  }
  if (status.key === 'rateLimited') {
    return sanitize(account?.errorMessage || '触发限流')
  }
  if (status.key === 'tempUnavailable') {
    const temp = account?.tempUnavailable
    const code = temp?.statusCode ? `HTTP ${temp.statusCode}` : ''
    const type = temp?.errorType || 'upstream_error'
    return sanitize(
      account?.errorMessage || `临时暂停（${[type, code].filter(Boolean).join(' / ')}）`
    )
  }
  if (status.key === 'tempError') {
    return sanitize(account?.errorMessage || '上游临时异常')
  }
  if (status.key === 'paused') {
    return sanitize(account?.stoppedReason || account?.errorMessage || '已暂停调度')
  }
  return '可调度'
}

class AccountVitalityMonitorService {
  constructor(options = {}) {
    this.accountSources = options.accountSources || requireAccountSources()
    this.upstreamErrorHelper = options.upstreamErrorHelper || upstreamErrorHelper
    this.webhookNotifier = options.webhookNotifier || webhookNotifier
    this.webhookService = options.webhookService || webhookService
    this.logger = options.logger || logger
    this.interval = null
    this.intervalMs = 5 * 60 * 1000
    this.isRunning = false
    // ponytail: process-local baseline is enough for one service instance; move to Redis if multi-instance dedupe matters.
    this.lastStatuses = new Map()
  }

  start(intervalMinutes = 5) {
    if (this.interval) {
      this.logger.warn('⚠️ Account vitality monitor is already running')
      return
    }

    this.intervalMs = intervalMinutes * 60 * 1000
    this.performCheck().catch((error) =>
      this.logger.error('❌ Account vitality baseline failed:', error)
    )
    this.interval = setInterval(() => {
      this.performCheck().catch((error) =>
        this.logger.error('❌ Account vitality monitor failed:', error)
      )
    }, this.intervalMs)
    this.interval.unref?.()
    this.logger.info(`💓 Account vitality monitor started (interval: ${intervalMinutes} minutes)`)
  }

  stop() {
    if (!this.interval) {
      return
    }
    clearInterval(this.interval)
    this.interval = null
    this.logger.info('🛑 Account vitality monitor stopped')
  }

  async performCheck() {
    if (this.isRunning) {
      return
    }
    this.isRunning = true

    try {
      const snapshots = await this.getSnapshots()
      const currentKeys = new Set()

      for (const snapshot of snapshots) {
        currentKeys.add(snapshot.key)
        const previous = this.lastStatuses.get(snapshot.key)
        if (previous && previous.status.key !== snapshot.status.key) {
          await this.sendStatusChange(previous, snapshot)
        }
        this.lastStatuses.set(snapshot.key, snapshot)
      }

      for (const key of this.lastStatuses.keys()) {
        if (!currentKeys.has(key)) {
          this.lastStatuses.delete(key)
        }
      }
    } finally {
      this.isRunning = false
    }
  }

  async getSnapshots() {
    const tempStatuses = await this.upstreamErrorHelper.getAllTempUnavailable()
    const results = await Promise.allSettled(
      this.accountSources.map(async ({ platform, getAccounts }) => ({
        platform,
        accounts: normalizeAccounts(await getAccounts())
      }))
    )

    const snapshots = []
    for (const result of results) {
      if (result.status !== 'fulfilled') {
        this.logger.warn(`⚠️ Failed to load accounts for vitality monitor: ${result.reason}`)
        continue
      }

      const { platform, accounts } = result.value
      for (const rawAccount of accounts) {
        const account = { ...rawAccount, platform }
        if (!account.id) {
          continue
        }
        account.tempUnavailable = getTempUnavailableStatus(tempStatuses, account)
        const status = getVitalityStatus(account)
        snapshots.push({
          key: `${platform}:${account.id}`,
          account,
          status
        })
      }
    }

    return snapshots
  }

  async getCurrentSummary() {
    return this.buildSummary(await this.getSnapshots())
  }

  buildSummary(snapshots) {
    const statusCounts = STATUS_LIST.reduce((counts, status) => {
      counts[status.key] = 0
      return counts
    }, {})
    const statusLabels = STATUS_LIST.reduce((labels, status) => {
      labels[status.key] = status.label
      return labels
    }, {})
    const abnormalAccounts = []

    for (const snapshot of snapshots) {
      statusCounts[snapshot.status.key] = (statusCounts[snapshot.status.key] || 0) + 1
      if (snapshot.status.key !== 'normal') {
        abnormalAccounts.push({
          accountId: snapshot.account.id,
          accountName: getAccountName(snapshot.account),
          platform: snapshot.account.platform,
          status: snapshot.status.label,
          statusKey: snapshot.status.key,
          reason: getReason(snapshot.account, snapshot.status)
        })
      }
    }

    abnormalAccounts.sort(
      (a, b) =>
        a.statusKey.localeCompare(b.statusKey) ||
        a.platform.localeCompare(b.platform) ||
        a.accountName.localeCompare(b.accountName)
    )

    return {
      generatedAt: getISOStringWithTimezone(new Date()),
      totalAccounts: snapshots.length,
      statusCounts,
      statusLabels,
      abnormalAccounts
    }
  }

  async sendCurrentSummary() {
    const summary = await this.getCurrentSummary()
    const result = await this.webhookService.sendNotification('accountVitalitySummary', summary)

    if (!result) {
      throw new Error('Webhook未发送，请检查通知开关和账号活力通知类型')
    }
    if (result.succeeded === 0 || result.failed > 0) {
      throw new Error(`Webhook发送失败: ${result.succeeded}成功, ${result.failed}失败`)
    }

    return { summary, result }
  }

  async sendStatusChange(previous, current) {
    const { account, status } = current
    const reason = getReason(account, status)

    await this.webhookNotifier.sendAccountAnomalyNotification({
      accountId: account.id,
      accountName: getAccountName(account),
      platform: account.platform,
      previousStatus: previous.status.label,
      status: status.label,
      errorCode: `ACCOUNT_VITALITY_${previous.status.key}_TO_${status.key}`,
      reason,
      message: `活力状态变化: ${previous.status.label} -> ${status.label}`,
      timestamp: getISOStringWithTimezone(new Date())
    })
  }
}

module.exports = new AccountVitalityMonitorService()
module.exports.AccountVitalityMonitorService = AccountVitalityMonitorService
module.exports.getVitalityStatus = getVitalityStatus
