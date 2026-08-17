/**
 * Request Identity Service
 *
 * 处理 Claude 请求的身份信息规范化：
 * 1. Stainless 指纹管理 - 收集、持久化和应用 x-stainless-* 系列请求头
 * 2. User ID 规范化 - 重写 metadata.user_id，使其与真实账户保持一致
 */

const crypto = require('crypto')
const logger = require('../utils/logger')
const redisService = require('../models/redis')
const metadataUserIdHelper = require('../utils/metadataUserIdHelper')
const STAINLESS_HEADER_KEYS = [
  'x-stainless-retry-count',
  'x-stainless-timeout',
  'x-stainless-lang',
  'x-stainless-package-version',
  'x-stainless-os',
  'x-stainless-arch',
  'x-stainless-runtime',
  'x-stainless-runtime-version'
]

// 小写 key 到正确大小写格式的映射（用于返回给上游时）
const STAINLESS_HEADER_CASE_MAP = {
  'x-stainless-retry-count': 'X-Stainless-Retry-Count',
  'x-stainless-timeout': 'X-Stainless-Timeout',
  'x-stainless-lang': 'X-Stainless-Lang',
  'x-stainless-package-version': 'X-Stainless-Package-Version',
  'x-stainless-os': 'X-Stainless-OS',
  'x-stainless-arch': 'X-Stainless-Arch',
  'x-stainless-runtime': 'X-Stainless-Runtime',
  'x-stainless-runtime-version': 'X-Stainless-Runtime-Version'
}
const REDIS_KEY_PREFIX = 'fmt_claude_req:stainless_headers:'

function formatUuidFromSeed(seed) {
  const digest = crypto.createHash('sha256').update(String(seed)).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))

  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function safeParseJson(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }

  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (error) {
    return null
  }
}

function getRedisClient() {
  if (!redisService || typeof redisService.getClientSafe !== 'function') {
    throw new Error('requestIdentityService: Redis 服务未初始化')
  }

  return redisService.getClientSafe()
}

function hasFingerprintValues(fingerprint) {
  return fingerprint && typeof fingerprint === 'object' && Object.keys(fingerprint).length > 0
}

function hasCompleteFingerprint(fingerprint) {
  return (
    fingerprint &&
    typeof fingerprint === 'object' &&
    STAINLESS_HEADER_KEYS.every((key) => String(fingerprint[key] || '').trim())
  )
}

function sanitizeFingerprint(source) {
  if (!source || typeof source !== 'object') {
    return {}
  }

  const normalized = {}
  const lowerCaseSource = {}

  Object.keys(source).forEach((key) => {
    const value = source[key]
    if (value === undefined || value === null || String(value).trim() === '') {
      return
    }
    lowerCaseSource[key.toLowerCase()] = String(value)
  })

  STAINLESS_HEADER_KEYS.forEach((key) => {
    if (lowerCaseSource[key]) {
      normalized[key] = lowerCaseSource[key]
    }
  })

  return normalized
}

function collectFingerprintFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return {}
  }

  const subset = {}

  Object.keys(headers).forEach((key) => {
    const lowerKey = key.toLowerCase()
    if (STAINLESS_HEADER_KEYS.includes(lowerKey)) {
      subset[lowerKey] = headers[key]
    }
  })

  return sanitizeFingerprint(subset)
}

function removeHeaderCaseInsensitive(target, key) {
  if (!target || typeof target !== 'object') {
    return
  }

  const lowerKey = key.toLowerCase()
  Object.keys(target).forEach((candidate) => {
    if (candidate.toLowerCase() === lowerKey) {
      delete target[candidate]
    }
  })
}

function applyFingerprintToHeaders(headers, fingerprint) {
  if (!headers || typeof headers !== 'object') {
    return headers
  }

  if (!hasFingerprintValues(fingerprint)) {
    return { ...headers }
  }

  const nextHeaders = { ...headers }

  STAINLESS_HEADER_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(fingerprint, key)) {
      return
    }
    removeHeaderCaseInsensitive(nextHeaders, key)
    // 使用正确的大小写格式返回给上游
    const properCaseKey = STAINLESS_HEADER_CASE_MAP[key] || key
    nextHeaders[properCaseKey] = fingerprint[key]
  })

  return nextHeaders
}

async function persistFingerprint(accountId, fingerprint) {
  if (!accountId || !hasFingerprintValues(fingerprint)) {
    return false
  }

  const client = getRedisClient()
  const key = `${REDIS_KEY_PREFIX}${accountId}`
  const serialized = JSON.stringify(fingerprint)

  const result = await client.set(key, serialized, 'NX')
  return result === 'OK' || result === 1
}

async function readPersistedFingerprint(accountId) {
  if (!accountId) {
    return {}
  }

  const client = getRedisClient()
  const raw = await client.get(`${REDIS_KEY_PREFIX}${accountId}`)
  const parsed = safeParseJson(raw)
  return sanitizeFingerprint(parsed)
}

function extractAccountFingerprint(account) {
  if (!account || typeof account !== 'object') {
    return {}
  }

  const raw = account.stainlessFingerprint || account.stainless_fingerprint
  const parsed = typeof raw === 'string' ? safeParseJson(raw) : raw
  return sanitizeFingerprint(parsed)
}

function getHeaderValueCaseInsensitive(headers, key) {
  if (!headers || typeof headers !== 'object') {
    return undefined
  }

  const lowerKey = key.toLowerCase()
  for (const candidate of Object.keys(headers)) {
    if (candidate.toLowerCase() === lowerKey) {
      return headers[candidate]
    }
  }

  return undefined
}

function headersChanged(original, updated) {
  if (original === updated) {
    return false
  }

  for (const key of STAINLESS_HEADER_KEYS) {
    if (
      getHeaderValueCaseInsensitive(original, key) !== getHeaderValueCaseInsensitive(updated, key)
    ) {
      return true
    }
  }

  return false
}

function resolveAccountId(payload) {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const account = payload.account && typeof payload.account === 'object' ? payload.account : null
  const candidates = [
    payload.accountId,
    payload.account_id,
    payload.accountID,
    account && (account.accountId || account.account_id || account.accountID),
    account && (account.id || account.uuid),
    account && (account.account_uuid || account.accountUuid),
    account && (account.schedulerAccountId || account.scheduler_account_id)
  ]

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) {
      continue
    }

    const stringified = String(candidate).trim()
    if (stringified) {
      return stringified
    }
  }

  return null
}

async function rewriteHeaders(headers, accountId, accountFingerprint = {}) {
  if (!headers || typeof headers !== 'object') {
    return { nextHeaders: headers, changed: false }
  }

  if (!accountId) {
    return { nextHeaders: { ...headers }, changed: false }
  }

  const workingHeaders = { ...headers }
  const pinnedFingerprint = sanitizeFingerprint(accountFingerprint)

  if (hasCompleteFingerprint(pinnedFingerprint)) {
    return {
      nextHeaders: applyFingerprintToHeaders(workingHeaders, pinnedFingerprint),
      changed: true,
      fingerprint: pinnedFingerprint,
      source: 'account_pinned'
    }
  }

  try {
    const persistedFingerprint = await readPersistedFingerprint(accountId)
    if (hasCompleteFingerprint(persistedFingerprint)) {
      return {
        nextHeaders: applyFingerprintToHeaders(workingHeaders, persistedFingerprint),
        changed: true,
        fingerprint: persistedFingerprint,
        source: 'redis_persisted'
      }
    }
  } catch (error) {
    logger.error(`requestIdentityService: 读取指纹失败 (${accountId}): ${error.message}`)
  }

  const fingerprint = collectFingerprintFromHeaders(workingHeaders)

  if (!hasCompleteFingerprint(fingerprint)) {
    logger.warn(`requestIdentityService: 账号 ${accountId} 未提供完整 Stainless 指纹，已保持原样`)
    return { nextHeaders: workingHeaders, changed: false }
  }

  try {
    const persisted = await persistFingerprint(accountId, fingerprint)
    if (!persisted) {
      const winningFingerprint = await readPersistedFingerprint(accountId)
      if (hasCompleteFingerprint(winningFingerprint)) {
        return {
          nextHeaders: applyFingerprintToHeaders(workingHeaders, winningFingerprint),
          changed: true,
          fingerprint: winningFingerprint,
          source: 'redis_persisted_race_winner'
        }
      }
    }
  } catch (error) {
    logger.error(`requestIdentityService: 持久化指纹失败 (${accountId}): ${error.message}`)
    return {
      abortResponse: {
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'fingerprint_persist_failed', message: '指纹信息持久化失败' })
      }
    }
  }

  const appliedHeaders = applyFingerprintToHeaders(workingHeaders, fingerprint)
  const changed = headersChanged(workingHeaders, appliedHeaders)

  return { nextHeaders: appliedHeaders, changed, fingerprint, source: 'request_headers' }
}

function normalizeAccountUuid(candidate) {
  if (typeof candidate !== 'string') {
    return null
  }

  const trimmed = candidate.trim()
  return trimmed || null
}

function extractExtInfo(account) {
  if (!account || typeof account !== 'object') {
    return null
  }

  const extInfoRaw = account.extInfo
  if (!extInfoRaw) {
    return null
  }

  if (typeof extInfoRaw === 'string') {
    return safeParseJson(extInfoRaw)
  }

  if (typeof extInfoRaw === 'object') {
    return extInfoRaw
  }

  return null
}

function extractAccountUuid(account) {
  if (!account || typeof account !== 'object') {
    return null
  }

  const directUuid =
    normalizeAccountUuid(account.account_uuid) || normalizeAccountUuid(account.accountUuid)
  if (directUuid) {
    return directUuid
  }

  const extInfoObject = extractExtInfo(account)
  if (!extInfoObject || typeof extInfoObject !== 'object') {
    return null
  }

  return (
    normalizeAccountUuid(extInfoObject.account_uuid) ||
    normalizeAccountUuid(extInfoObject.accountUuid) ||
    null
  )
}

function normalizeSessionSeed(sessionSeed) {
  if (typeof sessionSeed !== 'string') {
    return ''
  }

  const trimmed = sessionSeed.trim()
  return trimmed
}

function buildRelayGeneratedUserId(account, sessionSeed = null) {
  const accountId = resolveAccountId({ account }) || 'unknown-account'
  const accountUuid = extractAccountUuid(account) || ''
  const deviceId = crypto
    .createHash('sha256')
    .update(`relay-generated-device:${accountId}`)
    .digest('hex')
  const conversationSeed = normalizeSessionSeed(sessionSeed) || 'missing-session'
  const sessionId = formatUuidFromSeed(`${conversationSeed}::relay-session`)

  return JSON.stringify({
    device_id: deviceId,
    account_uuid: accountUuid,
    session_id: sessionId
  })
}

function rewriteUserId(body, accountId, accountUuid) {
  if (!body || typeof body !== 'object') {
    return { nextBody: body, changed: false }
  }

  const { metadata } = body
  if (!metadata || typeof metadata !== 'object') {
    return { nextBody: body, changed: false }
  }

  const userId = metadata.user_id
  if (typeof userId !== 'string') {
    return { nextBody: body, changed: false }
  }

  const parsed = metadataUserIdHelper.parse(userId)
  if (!parsed) {
    return { nextBody: body, changed: false }
  }

  // 哈希 session（与原逻辑一致）
  const seedTail = parsed.sessionId || 'default'
  const effectiveScheduler = accountId ? String(accountId) : 'unknown-scheduler'
  const hashedSession = formatUuidFromSeed(`${effectiveScheduler}::${seedTail}`)

  // 注入真实 accountUuid
  const effectiveUuid = normalizeAccountUuid(accountUuid) || parsed.accountUuid || ''

  // 以原格式重建
  const nextUserId = metadataUserIdHelper.build({
    deviceId: parsed.deviceId,
    accountUuid: effectiveUuid,
    sessionId: hashedSession,
    isJsonFormat: parsed.isJsonFormat
  })

  if (nextUserId === userId) {
    return { nextBody: body, changed: false }
  }

  return {
    nextBody: { ...body, metadata: { ...metadata, user_id: nextUserId } },
    changed: true
  }
}

/**
 * 转换请求身份信息
 * @param {Object} payload - 请求载荷
 * @param {Object} payload.body - 请求体
 * @param {Object} payload.headers - 请求头
 * @param {string} payload.accountId - 账户ID
 * @param {Object} payload.account - 账户对象
 * @returns {Object} 转换后的 { body, headers, abortResponse? }
 */
async function transform(payload = {}) {
  const currentBody = payload.body
  const currentHeaders = payload.headers

  if (!payload.accountId) {
    return {
      body: currentBody,
      headers: currentHeaders
    }
  }

  const accountUuid = extractAccountUuid(payload.account)
  const accountIdForHeaders = resolveAccountId(payload)
  const accountFingerprint = extractAccountFingerprint(payload.account)

  const { nextBody } = rewriteUserId(currentBody, payload.accountId, accountUuid)
  const headerResult = await rewriteHeaders(currentHeaders, accountIdForHeaders, accountFingerprint)

  const nextHeaders = headerResult ? headerResult.nextHeaders : currentHeaders
  const abortResponse =
    headerResult && headerResult.abortResponse ? headerResult.abortResponse : null

  return {
    body: nextBody,
    headers: nextHeaders,
    abortResponse
  }
}

module.exports = {
  transform,
  buildRelayGeneratedUserId,
  extractAccountUuid,
  extractStainlessFingerprint: collectFingerprintFromHeaders,
  hasCompleteStainlessFingerprint: hasCompleteFingerprint,
  applyStainlessFingerprint: applyFingerprintToHeaders,
  // 导出内部函数供测试使用
  _internal: {
    formatUuidFromSeed,
    collectFingerprintFromHeaders,
    hasCompleteFingerprint,
    readPersistedFingerprint,
    extractAccountFingerprint,
    rewriteHeaders,
    rewriteUserId,
    extractAccountUuid,
    resolveAccountId,
    buildRelayGeneratedUserId
  }
}
