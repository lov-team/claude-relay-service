export const VITALITY_STATUS_GROUPS = [
  {
    key: 'error',
    label: '错误/认证异常',
    swatchClass: 'bg-red-500',
    textClass: 'text-red-600 dark:text-red-400'
  },
  {
    key: 'quotaExpired',
    label: '配额或过期',
    swatchClass: 'bg-amber-500',
    textClass: 'text-amber-600 dark:text-amber-400'
  },
  {
    key: 'rateLimited',
    label: '限流中',
    swatchClass: 'bg-orange-500',
    textClass: 'text-orange-600 dark:text-orange-400'
  },
  {
    key: 'tempUnavailable',
    label: '临时暂停/过载',
    swatchClass: 'bg-yellow-500',
    textClass: 'text-yellow-600 dark:text-yellow-400'
  },
  {
    key: 'tempError',
    label: '临时异常',
    swatchClass: 'bg-fuchsia-500',
    textClass: 'text-fuchsia-600 dark:text-fuchsia-400'
  },
  {
    key: 'paused',
    label: '已暂停',
    swatchClass: 'bg-slate-500',
    textClass: 'text-slate-600 dark:text-slate-300'
  },
  {
    key: 'normal',
    label: '正常',
    swatchClass: 'bg-emerald-500',
    textClass: 'text-emerald-600 dark:text-emerald-400'
  },
  {
    key: 'unknown',
    label: '未知',
    swatchClass: 'bg-gray-400',
    textClass: 'text-gray-600 dark:text-gray-400'
  }
]

const STATUS_GROUP_MAP = Object.fromEntries(VITALITY_STATUS_GROUPS.map((item) => [item.key, item]))

export const PLATFORM_LABELS = {
  claude: 'Claude 官方/OAuth',
  'claude-console': 'Claude Console',
  bedrock: 'Bedrock',
  gemini: 'Gemini OAuth',
  'gemini-api': 'Gemini API',
  openai: 'OpenAI 官方',
  'openai-responses': 'OpenAI-Responses',
  azure_openai: 'Azure OpenAI',
  'azure-openai': 'Azure OpenAI',
  ccr: 'CCR Relay',
  droid: 'Droid'
}

const TEMP_UNAVAILABLE_ACCOUNT_TYPE_ALIASES = {
  claude: ['claude-official', 'claude'],
  'claude-console': ['claude-console'],
  bedrock: ['bedrock'],
  gemini: ['gemini'],
  'gemini-api': ['gemini-api'],
  openai: ['openai'],
  'openai-responses': ['openai-responses'],
  ccr: ['ccr'],
  droid: ['droid'],
  azure_openai: ['azure-openai'],
  'azure-openai': ['azure-openai']
}

const falseLike = (value) => value === false || value === 'false' || value === 0 || value === '0'
const trueLike = (value) => value === true || value === 'true' || value === 1 || value === '1'

export const getAccountDisplayName = (account) =>
  account?.name ||
  account?.email ||
  account?.accountName ||
  account?.displayName ||
  account?.username ||
  account?.id ||
  '未命名账号'

export const getAccountIdentifier = (account) =>
  account?.email || account?.accountId || account?.id || account?.name || '未知'

export const getPlatformLabel = (platform) => PLATFORM_LABELS[platform] || platform || '未知平台'

const firstString = (...values) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

const firstFiniteNumber = (...values) => {
  for (const value of values) {
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return 0
}

export const maskAccountValue = (value) => {
  if (!value) return '未知'
  const text = String(value).trim()
  if (text.length <= 18) return text
  const separatorIndex = text.indexOf('_')
  if (separatorIndex > 0 && separatorIndex < 16) {
    return `${text.slice(0, separatorIndex + 1)}...${text.slice(-8)}`
  }
  return `${text.slice(0, 8)}...${text.slice(-8)}`
}

const sanitizeTooltipValue = (value) => {
  if (typeof value !== 'string') return value

  return value
    .replace(/:\/\/([^/\s:@]+):([^/\s@]+)@/g, '://$1:***@')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1***')
    .replace(
      /\b(token|refreshToken|accessToken|apiKey|api_key|secret|password|credentials)\b(\s*[:=]\s*)["']?([^"',\s}]+)/gi,
      (_match, key, separator) => `${key}${separator}***`
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|cr_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|ya29\.[A-Za-z0-9_-]{16,}|refresh_[A-Za-z0-9_-]{16,})\b/g,
      (secret) => maskAccountValue(secret)
    )
}

export const getAccountTooltipTitle = (account) => {
  const title = firstString(account?.name, account?.accountName, account?.displayName)
  return (
    sanitizeTooltipValue(title) ||
    maskAccountValue(account?.id || account?.email || account?.username)
  )
}

export const getAccountTooltipProfile = (account) => {
  const profile = firstString(
    account?.profile,
    account?.profileName,
    account?.accountInfo?.profile,
    account?.accountInfo?.email,
    account?.email,
    account?.username
  )
  return sanitizeTooltipValue(profile) || maskAccountValue(account?.accountId || account?.id)
}

export const getAccountTooltipRemark = (account) =>
  sanitizeTooltipValue(
    firstString(
      account?.remark,
      account?.remarks,
      account?.note,
      account?.adminNote,
      account?.description,
      account?.name,
      account?.email
    )
  ) || '无'

const normalizeTooltipRows = (rows) =>
  rows.map((row) => ({
    ...row,
    value: sanitizeTooltipValue(row.value)
  }))

export const getAccountTodayRequests = (account) =>
  firstFiniteNumber(
    account?.usage?.daily?.requests,
    account?.usage?.today?.requests,
    account?.stats?.today_requests,
    account?.todayRequests,
    account?.dailyRequests
  )

export const getAccountTotalRequests = (account) =>
  firstFiniteNumber(
    account?.usage?.total?.requests,
    account?.stats?.total_requests,
    account?.totalRequests,
    account?.requestCount,
    account?.requests
  )

export const resolveTempUnavailableStatusForAccount = (tempStatuses, account) => {
  if (!tempStatuses || !account?.id) return null

  const accountTypes = TEMP_UNAVAILABLE_ACCOUNT_TYPE_ALIASES[account.platform] || [account.platform]
  for (const accountType of accountTypes) {
    const status = tempStatuses[`${accountType}:${account.id}`]
    if (status) return status
  }

  return null
}

export const attachTempUnavailableStatuses = (accounts, tempStatuses) =>
  accounts.map((account) => ({
    ...account,
    tempUnavailable:
      account.tempUnavailable || resolveTempUnavailableStatusForAccount(tempStatuses, account)
  }))

export const isAccountRateLimited = (account) => {
  if (!account) return false

  return (
    account.isRateLimited ||
    account.status === 'rate_limited' ||
    account.status === 'rateLimited' ||
    account.rateLimitStatus === 'limited' ||
    account.rateLimitStatus?.isRateLimited === true ||
    account.opusRateLimitStatus?.isRateLimited === true
  )
}

export const getRateLimitRemainingMinutes = (account) => {
  if (!account) return 0

  const candidates = [account.rateLimitStatus, account.opusRateLimitStatus].filter(
    (item) => item && typeof item === 'object'
  )

  for (const status of candidates) {
    if (Number.isFinite(status.minutesRemaining))
      return Math.max(0, Math.ceil(status.minutesRemaining))
    if (Number.isFinite(status.remainingMinutes))
      return Math.max(0, Math.ceil(status.remainingMinutes))
    if (Number.isFinite(status.remainingSeconds)) {
      return Math.max(0, Math.ceil(status.remainingSeconds / 60))
    }
    if (status.rateLimitResetAt) {
      const diffMs = new Date(status.rateLimitResetAt).getTime() - Date.now()
      if (diffMs > 0) return Math.ceil(diffMs / 60000)
    }
  }

  if (account.rateLimitUntil) {
    const diffMs = new Date(account.rateLimitUntil).getTime() - Date.now()
    return diffMs > 0 ? Math.ceil(diffMs / 60000) : 0
  }

  return 0
}

const isQuotaOrExpired = (account) => {
  if (!account) return false
  if (account.status === 'quota_exceeded') return true
  if (trueLike(account.quotaAutoStopped) || account.quotaStoppedAt) return true

  if (!account.expiresAt) return false
  if (account.platform !== 'claude-console' && account.platform !== 'bedrock') return false

  const expiresAt = new Date(account.expiresAt).getTime()
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < Date.now()
}

const isOverloaded = (account) =>
  account?.overloadStatus === 'overloaded' || account?.overloadStatus?.isOverloaded === true

const isErrorStatus = (account) =>
  falseLike(account?.isActive) ||
  ['blocked', 'unauthorized', 'error', 'account_blocked'].includes(account?.status)

export const getAccountVitalityStatus = (account) => {
  if (!account) return STATUS_GROUP_MAP.unknown
  if (isErrorStatus(account)) return STATUS_GROUP_MAP.error
  if (isQuotaOrExpired(account)) return STATUS_GROUP_MAP.quotaExpired
  if (isAccountRateLimited(account)) return STATUS_GROUP_MAP.rateLimited
  if (account.tempUnavailable || isOverloaded(account)) return STATUS_GROUP_MAP.tempUnavailable
  if (account.status === 'temp_error') return STATUS_GROUP_MAP.tempError
  if (falseLike(account.schedulable)) return STATUS_GROUP_MAP.paused
  if (falseLike(account.isActive)) return STATUS_GROUP_MAP.error
  if (account.id || trueLike(account.isActive) || account.isActive === undefined)
    return STATUS_GROUP_MAP.normal
  return STATUS_GROUP_MAP.unknown
}

const formatDuration = (seconds) => {
  if (!seconds || seconds <= 0) return ''
  if (seconds < 60) return `${Math.ceil(seconds)}秒`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}分钟`
  return `${Math.ceil(seconds / 3600)}小时`
}

export const getTempUnavailableRecoveryAt = (tempUnavailable) => {
  if (!tempUnavailable) return ''

  if (tempUnavailable.expiresAt) return tempUnavailable.expiresAt
  if (!tempUnavailable.markedAt || !tempUnavailable.cooldownSeconds) return ''

  const markedAt = new Date(tempUnavailable.markedAt).getTime()
  const cooldownSeconds = Number(tempUnavailable.cooldownSeconds)
  if (!Number.isFinite(markedAt) || !Number.isFinite(cooldownSeconds)) return ''

  return new Date(markedAt + cooldownSeconds * 1000).toISOString()
}

export const getTempUnavailableRemainingSeconds = (tempUnavailable) => {
  if (!tempUnavailable) return 0

  const recoveryAt = getTempUnavailableRecoveryAt(tempUnavailable)
  if (!recoveryAt) return Number(tempUnavailable.remainingSeconds || tempUnavailable.ttl || 0) || 0

  const diffMs = new Date(recoveryAt).getTime() - Date.now()
  return diffMs > 0 ? Math.ceil(diffMs / 1000) : 0
}

export const getAccountVitalityReason = (account) => {
  const status = getAccountVitalityStatus(account)

  if (status.key === 'error') {
    return account?.errorMessage || account?.stoppedReason || '账号不可用或认证异常'
  }
  if (status.key === 'quotaExpired') {
    if (account?.expiresAt && isQuotaOrExpired(account)) return '订阅已过期或余额/配额不足'
    return '余额/配额不足'
  }
  if (status.key === 'rateLimited') {
    const minutes = getRateLimitRemainingMinutes(account)
    return minutes > 0 ? `触发限流，约 ${minutes} 分钟后恢复` : '触发限流'
  }
  if (status.key === 'tempUnavailable') {
    if (isOverloaded(account)) return '上游过载保护中'
    const tempUnavailable = account?.tempUnavailable
    const remaining = getTempUnavailableRemainingSeconds(tempUnavailable)
    const type = tempUnavailable?.errorType || 'upstream_error'
    const statusCode = tempUnavailable?.statusCode ? ` / HTTP ${tempUnavailable.statusCode}` : ''
    const remainingText = remaining > 0 ? `，剩余 ${formatDuration(remaining)}` : ''
    return `临时暂停（${type}${statusCode}${remainingText}）`
  }
  if (status.key === 'tempError') {
    return account?.errorMessage || '上游临时异常'
  }
  if (status.key === 'paused') {
    return account?.stoppedReason || account?.errorMessage || '已暂停调度'
  }
  if (status.key === 'normal') return '可调度'
  return '无法识别当前状态'
}

export const getAccountTooltipRows = (account) => {
  const status = getAccountVitalityStatus(account)
  const rows = [
    { label: 'profile/账号', value: getAccountTooltipProfile(account) || '未知' },
    { label: '状态', value: status.label },
    { label: '备注', value: getAccountTooltipRemark(account) },
    { label: '今日请求', value: getAccountTodayRequests(account) },
    { label: '总请求', value: getAccountTotalRequests(account) }
  ]

  if (status.key !== 'normal') {
    rows.push({ label: '原因', value: getAccountVitalityReason(account) })
  }

  return normalizeTooltipRows(rows)
}

export const sortAccountsForVitality = (a, b) => {
  const platformCompare = getPlatformLabel(a.platform).localeCompare(
    getPlatformLabel(b.platform),
    'zh-CN'
  )
  if (platformCompare !== 0) return platformCompare
  return getAccountDisplayName(a).localeCompare(getAccountDisplayName(b), 'zh-CN')
}

export const groupAccountsByVitalityStatus = (accounts) =>
  VITALITY_STATUS_GROUPS.map((status) => ({
    ...status,
    accounts: accounts
      .filter((account) => getAccountVitalityStatus(account).key === status.key)
      .sort(sortAccountsForVitality)
  }))
