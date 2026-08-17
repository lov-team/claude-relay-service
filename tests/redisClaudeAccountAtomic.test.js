jest.mock('../config/config', () => ({
  redis: {},
  system: { timezoneOffset: 8 },
  security: { encryptionKey: 'test-encryption-key-32-characters' }
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

const redis = require('../src/models/redis')

describe('Claude account atomic Redis transitions', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('permanent error transition records first/last timestamps and detection sources', async () => {
    const evalMock = jest.fn().mockResolvedValue([1, 'active'])
    jest.spyOn(redis, 'getClientSafe').mockReturnValue({ eval: evalMock })

    await expect(
      redis.markClaudeAccountPermanentErrorAtomic('account-1', {
        status: 'unauthorized',
        errorMessage: 'revoked',
        timestampField: 'unauthorizedAt',
        occurredAt: '2026-08-17T01:02:03.000Z',
        detectionSource: 'oauth_refresh',
        force: true,
        errorKind: 'oauth_revoked',
        errorCode: 'CLAUDE_OAUTH_REVOKED',
        statusCode: 401
      })
    ).resolves.toEqual({ status: 1, previousStatus: 'active' })

    const [script, keyCount, key, ...args] = evalMock.mock.calls[0]
    expect(keyCount).toBe(1)
    expect(key).toBe('claude:account:account-1')
    expect(script).toContain("'firstErrorAt'")
    expect(script).toContain("'firstErrorDetectionSource'")
    expect(script).toContain("'lastErrorAt'")
    expect(args).toContain('oauth_refresh')
    expect(args).toContain('CLAUDE_OAUTH_REVOKED')
  })

  test('refresh success transition refuses to reactivate a permanent stop', async () => {
    const evalMock = jest.fn().mockResolvedValue([0, 'blocked'])
    jest.spyOn(redis, 'getClientSafe').mockReturnValue({ eval: evalMock })

    await expect(
      redis.setClaudeAccountRefreshSuccessAtomic('account-1', {
        accessToken: 'encrypted-access',
        refreshToken: 'encrypted-refresh',
        expiresAt: '1770000000000',
        lastRefreshAt: '2026-08-17T01:02:03.000Z'
      })
    ).resolves.toEqual({ status: 0, previousStatus: 'blocked' })

    expect(evalMock.mock.calls[0][0]).toContain("currentStatus == 'blocked'")
    expect(evalMock.mock.calls[0][0]).toContain("currentStatus == 'unauthorized'")
  })

  test('successful identity is pinned with one atomic script', async () => {
    const evalMock = jest.fn().mockResolvedValue([1, 'claude-cli/2.1.228 (external, cli)'])
    jest.spyOn(redis, 'getClientSafe').mockReturnValue({ eval: evalMock })

    await expect(
      redis.pinClaudeAccountIdentityIfAbsent('account-1', {
        userAgent: 'claude-cli/2.1.228 (external, cli)',
        userAgentPlatform: 'mac',
        stainlessFingerprint: '{"x-stainless-os":"MacOS"}',
        detectionSource: 'relay_stream_success',
        firstSeenAt: '2026-08-17T01:02:03.000Z'
      })
    ).resolves.toEqual({
      status: 1,
      userAgent: 'claude-cli/2.1.228 (external, cli)'
    })

    const [script] = evalMock.mock.calls[0]
    expect(script).toContain("'userAgentMode', 'pinned'")
    expect(script).toContain("'stainlessFingerprint'")
    expect(script).toContain("'identityFirstSeenAt'")
  })

  test('generic account writes preserve permanent state and pinned identity by default', async () => {
    const evalMock = jest.fn().mockResolvedValue([1, 1])
    const saddMock = jest.fn().mockResolvedValue(1)
    const delMock = jest.fn().mockResolvedValue(1)
    jest.spyOn(redis, 'getClientSafe').mockReturnValue({ eval: evalMock })
    redis.client = { sadd: saddMock, del: delMock }

    await expect(
      redis.setClaudeAccount('account-1', {
        status: 'active',
        schedulable: 'true',
        userAgentMode: 'legacy',
        userAgent: 'stale-ua',
        name: 'updated-name'
      })
    ).resolves.toEqual({
      permanentStatePreserved: true,
      pinnedIdentityPreserved: true
    })

    const [script, keyCount, key, permanentOverride, identityOverride, ...fieldArgs] =
      evalMock.mock.calls[0]
    expect(keyCount).toBe(1)
    expect(key).toBe('claude:account:account-1')
    expect(permanentOverride).toBe('false')
    expect(identityOverride).toBe('false')
    expect(script).toContain('permanentFields')
    expect(script).toContain('identityFields')
    expect(fieldArgs).toContain('name')
    expect(fieldArgs).toContain('updated-name')
  })

  test('rate-limit recovery script never resumes a permanent stop', async () => {
    const evalMock = jest.fn().mockResolvedValue([2, 'unauthorized'])
    jest.spyOn(redis, 'getClientSafe').mockReturnValue({ eval: evalMock })

    await expect(redis.clearClaudeAccountRateLimitAtomic('account-1')).resolves.toEqual({
      status: 2,
      currentStatus: 'unauthorized'
    })

    const [script] = evalMock.mock.calls[0]
    expect(script).toContain("currentStatus == 'blocked'")
    expect(script).toContain("currentStatus == 'unauthorized'")
    expect(script).toContain("'rateLimitAutoStopped'")
  })

  test('session warning update is atomic and checks permanent state before auto-stop fields', async () => {
    const evalMock = jest.fn().mockResolvedValue([2, 0, 1])
    jest.spyOn(redis, 'getClientSafe').mockReturnValue({ eval: evalMock })

    await expect(
      redis.updateClaudeAccountSessionWindowAtomic('account-1', {
        status: 'allowed_warning',
        updatedAt: '2026-08-17T01:02:03.000Z',
        windowIdentifier: 'window-1',
        maxWarningsPerWindow: 2,
        stoppedReason: 'near limit'
      })
    ).resolves.toEqual({ status: 2, shouldNotify: false, warningCount: 1 })

    const [script] = evalMock.mock.calls[0]
    expect(script).toContain("'sessionWindowStatus'")
    expect(script).toContain("currentStatus == 'unauthorized'")
    expect(script).toContain("'fiveHourWarningCount'")
  })

  test('temp-error recovery requires the current state to still be temporary', async () => {
    const evalMock = jest.fn().mockResolvedValue([0, 'blocked'])
    jest.spyOn(redis, 'getClientSafe').mockReturnValue({ eval: evalMock })

    await expect(redis.recoverClaudeAccountTempErrorAtomic('account-1')).resolves.toEqual({
      status: 0,
      previousStatus: 'blocked'
    })

    expect(evalMock.mock.calls[0][0]).toContain("currentStatus ~= 'temp_error'")
  })
})
