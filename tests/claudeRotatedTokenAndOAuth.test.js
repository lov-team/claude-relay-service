const mockGetClaudeAccount = jest.fn()
const mockAxiosPost = jest.fn()
const mockAxiosGet = jest.fn()

jest.mock('../config/config', () => ({
  claude: {
    apiVersion: '2023-06-01',
    betaHeader: '',
    systemPrompt: '',
    overloadHandling: { enabled: 0 }
  },
  system: { timezoneOffset: 8 },
  security: { encryptionKey: 'test-encryption-key-32-characters' },
  requestTimeout: 600000
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  api: jest.fn(),
  database: jest.fn(),
  performance: jest.fn(),
  authDetail: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getClaudeAccount: mockGetClaudeAccount,
  setClaudeAccount: jest.fn(),
  deleteSessionAccountMapping: jest.fn(),
  client: { get: jest.fn(), del: jest.fn(), hdel: jest.fn() },
  getClientSafe: jest.fn(() => ({ set: jest.fn(), del: jest.fn() }))
}))

jest.mock('axios', () => ({
  post: mockAxiosPost,
  get: mockAxiosGet
}))

jest.mock('../src/services/tokenRefreshService', () => ({
  acquireRefreshLock: jest.fn(async () => true),
  releaseRefreshLock: jest.fn(async () => undefined),
  isRefreshLocked: jest.fn(async () => false)
}))

jest.mock('../src/utils/tokenRefreshLogger', () => ({
  logRefreshStart: jest.fn(),
  logRefreshSuccess: jest.fn(),
  logRefreshError: jest.fn(),
  logTokenUsage: jest.fn(),
  sanitizeRefreshError: jest.fn((e) => e),
  logRefreshSkipped: jest.fn()
}))

jest.mock('../src/services/accountNurtureConfigService', () => ({
  getConfig: jest.fn(async () => ({
    oauthErrorPatterns: { blocked: [], revoked: [] }
  }))
}))

jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForStream: jest.fn(),
  getHttpsAgentForNonStream: jest.fn(),
  getPricingData: jest.fn(() => null),
  getCachedConfig: jest.fn(() => null),
  setCachedConfig: jest.fn(),
  deleteCachedConfig: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  maskProxyInfo: jest.fn(() => 'mock-proxy')
}))

jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  markAccountUnauthorized: jest.fn(async () => undefined),
  clearSessionMapping: jest.fn(async () => undefined)
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn(async () => ({ success: true })),
  recordErrorHistory: jest.fn(() => ({ catch: jest.fn() })),
  parseRetryAfter: jest.fn(() => null)
}))

jest.mock('../src/services/userMessageQueueService', () => ({}))

const claudeAccountService = require('../src/services/account/claudeAccountService')
const claudeRelayService = require('../src/services/relay/claudeRelayService')
const oauthHelper = require('../src/utils/oauthHelper')

describe('401 concurrent rotated token recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('recovers using newer rotated token in Redis without calling refreshAccountToken', async () => {
    const refreshSpy = jest
      .spyOn(claudeAccountService, 'refreshAccountToken')
      .mockResolvedValue({ accessToken: 'refreshed-should-not-happen' })

    mockGetClaudeAccount.mockResolvedValue({
      id: 'acct-1',
      status: 'active',
      schedulable: 'true',
      accessToken: claudeAccountService._encryptSensitiveData('sk-ant-oat-new-rotated')
    })

    const recovery = await claudeRelayService._recoverClaudeOAuth401({
      accountId: 'acct-1',
      accountType: 'claude-official',
      sessionHash: 'sess-1',
      rejectedAccessToken: 'sk-ant-oat-old-rejected'
    })

    expect(recovery).toEqual({
      retry: true,
      handled: false,
      accessToken: 'sk-ant-oat-new-rotated',
      rotated: true
    })
    expect(refreshSpy).not.toHaveBeenCalled()
  })

  test('falls back to refreshAccountToken when stored token equals the rejected token', async () => {
    const refreshSpy = jest
      .spyOn(claudeAccountService, 'refreshAccountToken')
      .mockResolvedValue({ accessToken: 'sk-ant-oat-freshly-refreshed' })

    mockGetClaudeAccount.mockResolvedValue({
      id: 'acct-1',
      status: 'active',
      schedulable: 'true',
      accessToken: claudeAccountService._encryptSensitiveData('sk-ant-oat-same-rejected')
    })

    const recovery = await claudeRelayService._recoverClaudeOAuth401({
      accountId: 'acct-1',
      accountType: 'claude-official',
      sessionHash: 'sess-1',
      rejectedAccessToken: 'sk-ant-oat-same-rejected'
    })

    expect(recovery).toEqual({
      retry: true,
      handled: false,
      accessToken: 'sk-ant-oat-freshly-refreshed'
    })
    expect(refreshSpy).toHaveBeenCalledWith('acct-1')
  })

  test('refuses rotated token when account is blocked, unauthorized, or unschedulable', async () => {
    mockGetClaudeAccount.mockResolvedValueOnce({
      id: 'acct-blocked',
      status: 'blocked',
      schedulable: 'false',
      accessToken: claudeAccountService._encryptSensitiveData('sk-ant-oat-newer')
    })
    await expect(
      claudeAccountService.getRotatedAccessToken('acct-blocked', 'sk-ant-oat-older')
    ).resolves.toBeNull()

    mockGetClaudeAccount.mockResolvedValueOnce({
      id: 'acct-paused',
      status: 'active',
      schedulable: 'false',
      accessToken: claudeAccountService._encryptSensitiveData('sk-ant-oat-newer')
    })
    await expect(
      claudeAccountService.getRotatedAccessToken('acct-paused', 'sk-ant-oat-older')
    ).resolves.toBeNull()
  })
})

describe('Anthropic OAuth flow (claude.com + code#state + team org preference)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('uses claude.com/cai/oauth/authorize for manual OAuth while keeping Cookie OAuth on claude.ai', () => {
    const authUrl = oauthHelper.generateAuthUrl('challenge-abc', 'state-xyz')
    expect(authUrl.startsWith('https://claude.com/cai/oauth/authorize?')).toBe(true)
    expect(oauthHelper.COOKIE_OAUTH_CONFIG.CLAUDE_AI_URL).toBe('https://claude.ai')
  })

  test('parseCallbackUrl preserves code#state from raw input and callback URLs and keeps plain code intact', () => {
    expect(oauthHelper.parseCallbackUrl('authCode123456#serverState999')).toBe(
      'authCode123456#serverState999'
    )
    expect(
      oauthHelper.parseCallbackUrl(
        'https://platform.claude.com/oauth/code/callback?code=authCode123456&state=serverState999'
      )
    ).toBe('authCode123456#serverState999')
    expect(oauthHelper.parseCallbackUrl('plainAuthCode123456')).toBe('plainAuthCode123456')
    expect(() => oauthHelper.parseCallbackUrl('badCode123456#bad!state')).toThrow(
      '授权码包含无效字符'
    )
  })

  test('exchangeCodeForTokens and exchangeSetupTokenCode send state only when #state is embedded and use clean headers', async () => {
    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
        scope: 'user:inference user:profile'
      }
    })

    await oauthHelper.exchangeCodeForTokens(
      'code123456#srvState1',
      'verifier-1',
      'localStateIgnored'
    )
    const [, embeddedBody, embeddedCfg] = mockAxiosPost.mock.calls[0]
    expect(embeddedBody.code).toBe('code123456')
    expect(embeddedBody.state).toBe('srvState1')
    expect(embeddedCfg.headers['User-Agent']).toBe('axios/1.13.6')
    expect(embeddedCfg.headers.Origin).toBeUndefined()
    expect(embeddedCfg.headers.Referer).toBeUndefined()

    await oauthHelper.exchangeSetupTokenCode('plainCode123456', 'verifier-2', 'localStateUnused')
    const [, plainBody, plainCfg] = mockAxiosPost.mock.calls[1]
    expect(plainBody.code).toBe('plainCode123456')
    expect(plainBody).not.toHaveProperty('state')
    expect(plainBody.expires_in).toBe(31536000)
    expect(plainCfg.headers['User-Agent']).toBe('axios/1.13.6')
    expect(plainCfg.headers.Origin).toBeUndefined()
  })

  test('getOrganizationInfo prefers raven_type === team among chat-capable organizations', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: [
        { uuid: 'org-personal', raven_type: null, capabilities: ['chat', 'api', 'extra'] },
        { uuid: 'org-team', raven_type: 'team', capabilities: ['chat'] }
      ]
    })

    await expect(oauthHelper.getOrganizationInfo('sk-ant-sid01-test')).resolves.toEqual({
      organizationUuid: 'org-team',
      capabilities: ['chat']
    })
  })
})
