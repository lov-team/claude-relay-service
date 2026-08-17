const mockGetClaudeAccount = jest.fn()
const mockSetClaudeAccount = jest.fn(async () => true)
const mockMarkPermanentError = jest.fn(async () => ({ status: 1, previousStatus: 'active' }))
const mockRefreshSuccessAtomic = jest.fn(async () => ({ status: 1, previousStatus: 'active' }))
const mockPinIdentity = jest.fn(async () => ({ status: 1, userAgent: '' }))
const mockAxiosPost = jest.fn()
const mockAxiosGet = jest.fn()
const mockAcquireRefreshLock = jest.fn(async () => true)
const mockReleaseRefreshLock = jest.fn(async () => undefined)
const mockIsRefreshLocked = jest.fn(async () => false)
const mockGetNurtureConfig = jest.fn(async () => ({
  oauthErrorPatterns: { blocked: [], revoked: [] }
}))

jest.mock('../config/config', () => ({
  claude: {},
  system: { timezoneOffset: 8 },
  security: { encryptionKey: 'test-encryption-key-32-characters' }
}))
jest.mock('../src/models/redis', () => ({
  getClaudeAccount: mockGetClaudeAccount,
  setClaudeAccount: mockSetClaudeAccount,
  markClaudeAccountPermanentErrorAtomic: mockMarkPermanentError,
  setClaudeAccountRefreshSuccessAtomic: mockRefreshSuccessAtomic,
  pinClaudeAccountIdentityIfAbsent: mockPinIdentity,
  client: { del: jest.fn(), hdel: jest.fn() }
}))
jest.mock('axios', () => ({ post: mockAxiosPost, get: mockAxiosGet }))
jest.mock('../src/services/tokenRefreshService', () => ({
  acquireRefreshLock: mockAcquireRefreshLock,
  releaseRefreshLock: mockReleaseRefreshLock,
  isRefreshLocked: mockIsRefreshLocked
}))
jest.mock('../src/services/accountNurtureConfigService', () => ({
  getConfig: mockGetNurtureConfig
}))
jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null)
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  authDetail: jest.fn()
}))
jest.mock('../src/utils/tokenRefreshLogger', () => ({
  logRefreshStart: jest.fn(),
  logRefreshSuccess: jest.fn(),
  logRefreshError: jest.fn(),
  logTokenUsage: jest.fn(),
  sanitizeRefreshError: jest.fn((error) => ({ message: error.message })),
  logRefreshSkipped: jest.fn()
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  recordErrorHistory: jest.fn(async () => undefined),
  markTempUnavailable: jest.fn(async () => undefined)
}))
jest.mock('../src/utils/webhookNotifier', () => ({
  sendAccountAnomalyNotification: jest.fn(async () => undefined)
}))

const _realSetInterval = global.setInterval
global.setInterval = (fn, ms, ...args) => {
  const timer = _realSetInterval(fn, ms, ...args)
  timer?.unref?.()
  return timer
}
const claudeAccountService = require('../src/services/account/claudeAccountService')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const webhookNotifier = require('../src/utils/webhookNotifier')
global.setInterval = _realSetInterval

const baseAccount = {
  id: 'account-1',
  name: 'oauth-account',
  isActive: 'true',
  status: 'active',
  schedulable: 'true',
  accessToken: 'stored-access-token',
  refreshToken: 'stored-refresh-token',
  expiresAt: '1',
  lastRefreshAt: '2026-08-07T00:00:00.000Z',
  scopes: ''
}

describe('claudeAccountService token refresh hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockAcquireRefreshLock.mockResolvedValue(true)
    mockReleaseRefreshLock.mockResolvedValue(undefined)
    mockIsRefreshLocked.mockResolvedValue(false)
    mockSetClaudeAccount.mockResolvedValue(true)
    mockMarkPermanentError.mockResolvedValue({ status: 1, previousStatus: 'active' })
    mockRefreshSuccessAtomic.mockResolvedValue({ status: 1, previousStatus: 'active' })
    mockPinIdentity.mockResolvedValue({ status: 1, userAgent: '' })
    mockAxiosGet.mockReset()
    mockGetNurtureConfig.mockResolvedValue({
      oauthErrorPatterns: { blocked: [], revoked: [] }
    })
    jest
      .spyOn(claudeAccountService, '_decryptSensitiveData')
      .mockImplementation((value) => `decrypted:${value}`)
    jest
      .spyOn(claudeAccountService, '_encryptSensitiveData')
      .mockImplementation((value) => `encrypted:${value}`)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('re-reads the refresh token after acquiring the lock and preserves it when omitted', async () => {
    mockGetClaudeAccount
      .mockResolvedValueOnce({ ...baseAccount, refreshToken: 'stale-refresh-token' })
      .mockResolvedValueOnce({ ...baseAccount, refreshToken: 'latest-refresh-token' })
    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: { access_token: 'new-access-token', expires_in: 3600 }
    })

    await expect(claudeAccountService.refreshAccountToken(baseAccount.id)).resolves.toMatchObject({
      success: true,
      accessToken: 'new-access-token'
    })

    expect(mockAxiosPost.mock.calls[0][1].refresh_token).toBe('decrypted:latest-refresh-token')
    expect(mockRefreshSuccessAtomic).toHaveBeenCalledWith(
      baseAccount.id,
      expect.objectContaining({
        accessToken: 'encrypted:new-access-token',
        refreshToken: 'encrypted:decrypted:latest-refresh-token'
      })
    )
  })

  test('does not reactivate an account atomically stopped during token refresh', async () => {
    mockGetClaudeAccount
      .mockResolvedValueOnce({ ...baseAccount })
      .mockResolvedValueOnce({ ...baseAccount })
    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: { access_token: 'new-access-token', expires_in: 3600 }
    })
    mockRefreshSuccessAtomic.mockResolvedValue({ status: 0, previousStatus: 'unauthorized' })

    await expect(claudeAccountService.refreshAccountToken(baseAccount.id)).rejects.toMatchObject({
      code: 'ACCOUNT_PERMANENTLY_DISABLED_DURING_REFRESH'
    })
    expect(mockSetClaudeAccount).not.toHaveBeenCalled()
  })

  test('marks invalid_grant as unauthorized and never treats it as retryable', async () => {
    mockGetClaudeAccount.mockResolvedValue({ ...baseAccount, disableAutoProtection: 'true' })
    mockAxiosPost.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        response: {
          status: 400,
          data: {
            error: 'invalid_grant',
            error_description: 'Refresh token not found or invalid'
          }
        }
      })
    )

    await expect(claudeAccountService.refreshAccountToken(baseAccount.id)).rejects.toMatchObject({
      isPermanentOAuthError: true,
      claudeOAuthErrorKind: 'oauth_revoked'
    })

    expect(mockMarkPermanentError).toHaveBeenCalledWith(
      baseAccount.id,
      expect.objectContaining({
        status: 'unauthorized',
        errorMessage: 'Refresh token not found or invalid',
        detectionSource: 'oauth_refresh',
        force: true
      })
    )
    expect(upstreamErrorHelper.recordErrorHistory).toHaveBeenCalledWith(
      baseAccount.id,
      'claude-official',
      400,
      'oauth_revoked',
      expect.any(Object)
    )
  })

  test('marks invalid authentication credentials from refresh as unauthorized', async () => {
    mockGetClaudeAccount.mockResolvedValue({ ...baseAccount })
    mockAxiosPost.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 401'), {
        response: {
          status: 401,
          data: {
            error: {
              type: 'authentication_error',
              message: 'Invalid authentication credentials'
            }
          }
        }
      })
    )

    await expect(claudeAccountService.refreshAccountToken(baseAccount.id)).rejects.toMatchObject({
      isPermanentOAuthError: true,
      claudeOAuthErrorKind: 'oauth_revoked'
    })

    expect(mockMarkPermanentError).toHaveBeenCalledWith(
      baseAccount.id,
      expect.objectContaining({ status: 'unauthorized', detectionSource: 'oauth_refresh' })
    )
    expect(webhookNotifier.sendAccountAnomalyNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: baseAccount.id,
        status: 'unauthorized',
        errorCode: 'CLAUDE_OAUTH_REVOKED'
      })
    )
  })

  test('refreshes once and retries OAuth usage after a 401', async () => {
    mockGetClaudeAccount.mockResolvedValue({ ...baseAccount })
    mockAxiosGet
      .mockRejectedValueOnce(
        Object.assign(new Error('Unauthorized'), {
          response: { status: 401, data: { error: { message: 'Unauthorized' } } }
        })
      )
      .mockResolvedValueOnce({ status: 200, data: { five_hour: { utilization: 12 } } })
    jest.spyOn(claudeAccountService, 'getValidAccessToken').mockResolvedValue('old-access-token')
    jest.spyOn(claudeAccountService, 'refreshAccountToken').mockResolvedValue({
      success: true,
      accessToken: 'new-access-token'
    })

    await expect(claudeAccountService.fetchOAuthUsage(baseAccount.id)).resolves.toEqual({
      five_hour: { utilization: 12 }
    })

    expect(claudeAccountService.refreshAccountToken).toHaveBeenCalledTimes(1)
    expect(mockAxiosGet).toHaveBeenCalledTimes(2)
    expect(mockAxiosGet.mock.calls[1][1].headers.Authorization).toBe('Bearer new-access-token')
  })

  test('stops and notifies when OAuth usage stays 401 after refresh', async () => {
    mockGetClaudeAccount.mockResolvedValue({ ...baseAccount })
    mockAxiosGet.mockRejectedValue(
      Object.assign(new Error('Unauthorized'), {
        response: {
          status: 401,
          data: { error: { message: 'Invalid authentication credentials' } }
        }
      })
    )
    jest.spyOn(claudeAccountService, 'getValidAccessToken').mockResolvedValue('old-access-token')
    jest.spyOn(claudeAccountService, 'refreshAccountToken').mockResolvedValue({
      success: true,
      accessToken: 'new-access-token'
    })

    await expect(claudeAccountService.fetchOAuthUsage(baseAccount.id)).resolves.toBeNull()

    expect(mockMarkPermanentError).toHaveBeenCalledWith(
      baseAccount.id,
      expect.objectContaining({
        status: 'unauthorized',
        detectionSource: 'oauth_usage_repeated_401'
      })
    )
    expect(webhookNotifier.sendAccountAnomalyNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: baseAccount.id,
        status: 'unauthorized',
        errorCode: 'CLAUDE_OAUTH_REPEATED_401'
      })
    )
  })

  test('does not send a duplicate notification for an already unauthorized account', async () => {
    mockMarkPermanentError.mockResolvedValue({ status: 0, previousStatus: 'unauthorized' })
    mockGetClaudeAccount.mockResolvedValue({
      ...baseAccount,
      status: 'unauthorized',
      schedulable: 'false'
    })

    await claudeAccountService.markAccountUnauthorized(baseAccount.id, null, {
      errorCode: 'CLAUDE_OAUTH_REPEATED_401',
      force: true
    })

    expect(webhookNotifier.sendAccountAnomalyNotification).not.toHaveBeenCalled()
  })

  test('pins the complete successful outbound identity atomically', async () => {
    const headers = {
      'User-Agent': 'claude-cli/2.1.228 (external, cli)',
      'X-Stainless-Retry-Count': '0',
      'X-Stainless-Timeout': '60',
      'X-Stainless-Lang': 'js',
      'X-Stainless-Package-Version': '0.68.0',
      'X-Stainless-OS': 'MacOS',
      'X-Stainless-Arch': 'arm64',
      'X-Stainless-Runtime': 'node',
      'X-Stainless-Runtime-Version': 'v22.18.0'
    }
    mockPinIdentity.mockResolvedValue({
      status: 1,
      userAgent: 'claude-cli/2.1.228 (external, cli)'
    })

    await expect(
      claudeAccountService.pinSuccessfulRequestIdentity(
        baseAccount.id,
        headers,
        'relay_stream_success'
      )
    ).resolves.toMatchObject({ pinned: true, userAgentPlatform: 'mac' })

    expect(mockPinIdentity).toHaveBeenCalledWith(
      baseAccount.id,
      expect.objectContaining({
        userAgent: 'claude-cli/2.1.228 (external, cli)',
        userAgentPlatform: 'mac',
        detectionSource: 'relay_stream_success',
        stainlessFingerprint: expect.stringContaining('x-stainless-runtime-version')
      })
    )
  })

  test('uses custom blocked phrases from nurture config during refresh classification', async () => {
    mockGetClaudeAccount.mockResolvedValue({ ...baseAccount })
    mockGetNurtureConfig.mockResolvedValue({
      oauthErrorPatterns: { blocked: ['tenant access frozen'], revoked: [] }
    })
    mockAxiosPost.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 403'), {
        response: {
          status: 403,
          data: { message: 'Tenant access frozen by policy' }
        }
      })
    )

    await expect(claudeAccountService.refreshAccountToken(baseAccount.id)).rejects.toMatchObject({
      isPermanentOAuthError: true,
      claudeOAuthErrorKind: 'account_blocked'
    })

    expect(mockMarkPermanentError).toHaveBeenCalledWith(
      baseAccount.id,
      expect.objectContaining({ status: 'blocked', detectionSource: 'oauth_refresh' })
    )
  })

  test('accepts a concurrent refresh only after observing a fresh stored token', async () => {
    mockAcquireRefreshLock.mockResolvedValue(false)
    mockGetClaudeAccount.mockResolvedValueOnce({ ...baseAccount }).mockResolvedValueOnce({
      ...baseAccount,
      accessToken: 'new-stored-access-token',
      expiresAt: String(Date.now() + 3600000),
      lastRefreshAt: '2026-08-07T00:01:00.000Z'
    })

    await expect(claudeAccountService.refreshAccountToken(baseAccount.id)).resolves.toMatchObject({
      success: true,
      accessToken: 'decrypted:new-stored-access-token'
    })

    expect(mockAxiosPost).not.toHaveBeenCalled()
    expect(mockReleaseRefreshLock).not.toHaveBeenCalled()
  })

  test('propagates a permanent failure observed from the concurrent refresher', async () => {
    mockAcquireRefreshLock.mockResolvedValue(false)
    mockIsRefreshLocked.mockResolvedValue(true)
    mockGetClaudeAccount.mockResolvedValueOnce({ ...baseAccount }).mockResolvedValue({
      ...baseAccount,
      status: 'unauthorized',
      schedulable: 'false',
      errorMessage: 'Refresh token not found or invalid'
    })

    await expect(claudeAccountService.refreshAccountToken(baseAccount.id)).rejects.toMatchObject({
      isPermanentOAuthError: true,
      claudeOAuthErrorKind: 'oauth_revoked'
    })
  })

  test('does not fall back to the old access token after a permanent refresh error', async () => {
    mockGetClaudeAccount.mockResolvedValue({ ...baseAccount })
    const permanentError = Object.assign(new Error('OAuth token revoked'), {
      isPermanentOAuthError: true
    })
    jest.spyOn(claudeAccountService, 'refreshAccountToken').mockRejectedValue(permanentError)

    await expect(claudeAccountService.getValidAccessToken(baseAccount.id)).rejects.toBe(
      permanentError
    )
  })
})
