const DEFAULT_BLOCKED_PATTERNS = [
  'this organization has been disabled',
  'organization has been disabled',
  'organization is disabled',
  'account has been disabled',
  'account is disabled',
  'organization has been suspended',
  'organization is suspended',
  'account has been suspended',
  'oauth authentication is currently not allowed'
]

const DEFAULT_REVOKED_PATTERNS = [
  'invalid_grant',
  'refresh token not found or invalid',
  'refresh token is invalid',
  'invalid refresh token',
  'refresh token has been revoked',
  'refresh token was revoked'
]

const DEFAULT_ACCESS_TOKEN_PATTERNS = [
  'invalid access token',
  'access token is invalid',
  'access token has expired',
  'expired access token'
]

const parseJsonBody = (body) => {
  if (typeof body !== 'string') {
    return body
  }

  const trimmed = body.trim()
  if (!trimmed) {
    return ''
  }

  try {
    return JSON.parse(trimmed)
  } catch (_) {
    return trimmed
  }
}

const firstString = (...values) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return ''
}

const normalizeCustomPatterns = (patterns) => {
  if (Array.isArray(patterns)) {
    return patterns.map((pattern) => String(pattern).trim().toLowerCase()).filter(Boolean)
  }
  if (typeof patterns === 'string') {
    return patterns
      .split('|')
      .map((pattern) => pattern.trim().toLowerCase())
      .filter(Boolean)
  }
  return []
}

const includesPattern = (haystack, patterns) =>
  patterns.some((pattern) => pattern && haystack.includes(pattern))

const extractClaudeOAuthError = (input, explicitStatusCode = null) => {
  const response = input?.response
  const body = parseJsonBody(response?.data ?? input?.body ?? input)
  const statusCode = Number(explicitStatusCode ?? response?.status ?? input?.statusCode) || null

  if (!body || typeof body !== 'object') {
    const message = firstString(body, input?.message)
    return {
      statusCode,
      code: firstString(input?.code),
      type: '',
      message: message.slice(0, 500),
      searchableText: `${firstString(input?.code)} ${message}`.trim().toLowerCase()
    }
  }

  const nestedError = body.error && typeof body.error === 'object' ? body.error : null
  const code = firstString(
    nestedError?.code,
    nestedError?.type,
    body.code,
    body.type,
    typeof body.error === 'string' ? body.error : '',
    input?.code
  )
  const type = firstString(nestedError?.type, body.type)
  const message = firstString(
    nestedError?.message,
    nestedError?.error_description,
    nestedError?.error,
    body.error_description,
    body.message,
    typeof body.error === 'string' ? body.error : '',
    input?.message
  )

  return {
    statusCode,
    code: code.slice(0, 120),
    type: type.slice(0, 120),
    message: message.slice(0, 500),
    searchableText: `${code} ${type} ${message}`.trim().toLowerCase()
  }
}

const classifyClaudeOAuthError = (input, explicitStatusCode = null, options = {}) => {
  const details = extractClaudeOAuthError(input, explicitStatusCode)
  const blockedPatterns = [
    ...DEFAULT_BLOCKED_PATTERNS,
    ...normalizeCustomPatterns(options.blockedPatterns)
  ]
  const revokedPatterns = [
    ...DEFAULT_REVOKED_PATTERNS,
    ...normalizeCustomPatterns(options.revokedPatterns)
  ]

  let kind = 'unknown'
  let permanent = false
  let accountStatus = null
  let errorCode = 'CLAUDE_OAUTH_UNKNOWN'

  if (includesPattern(details.searchableText, blockedPatterns)) {
    kind = 'account_blocked'
    permanent = true
    accountStatus = 'blocked'
    errorCode = 'CLAUDE_OAUTH_BLOCKED'
  } else if (includesPattern(details.searchableText, revokedPatterns)) {
    kind = 'oauth_revoked'
    permanent = true
    accountStatus = 'unauthorized'
    errorCode = 'CLAUDE_OAUTH_REVOKED'
  } else if (
    details.statusCode === 401 ||
    includesPattern(details.searchableText, DEFAULT_ACCESS_TOKEN_PATTERNS)
  ) {
    kind = 'access_token_invalid'
    errorCode = 'CLAUDE_OAUTH_ACCESS_TOKEN_INVALID'
  } else if (details.statusCode === 403) {
    kind = 'permission_denied'
    errorCode = 'CLAUDE_OAUTH_PERMISSION_DENIED'
  } else if (details.statusCode >= 500 || (!details.statusCode && input?.code)) {
    kind = 'transient_upstream_error'
    errorCode = 'CLAUDE_OAUTH_TRANSIENT'
  }

  return {
    ...details,
    kind,
    permanent,
    accountStatus,
    errorCode
  }
}

module.exports = {
  classifyClaudeOAuthError,
  extractClaudeOAuthError,
  DEFAULT_BLOCKED_PATTERNS,
  DEFAULT_REVOKED_PATTERNS
}
