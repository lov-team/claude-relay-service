const mockAxiosPost = jest.fn()
const mockAxiosGet = jest.fn()

jest.mock('axios', () => ({
  post: mockAxiosPost,
  get: mockAxiosGet
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  authDetail: jest.fn()
}))

const ProxyHelper = require('../src/utils/proxyHelper')
const oauthHelper = require('../src/utils/oauthHelper')
const { DEFAULT_CLAUDE_USER_AGENT } = require('../src/services/userAgentPoolService')

describe('Claude risk-control hardening (relay side)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ProxyHelper._agentCache.clear()
  })

  test('ProxyHelper separates Claude CLI TLS agents from browser-mode proxy agents', () => {
    const proxy = { type: 'http', host: '127.0.0.1', port: 18080 }
    const cliAgent = ProxyHelper.createProxyAgent(proxy)
    const browserAgent = ProxyHelper.createProxyAgent(proxy, { applyClaudeTls: false })

    expect(cliAgent).toBeTruthy()
    expect(browserAgent).toBeTruthy()
    expect(cliAgent).not.toBe(browserAgent)
    expect(cliAgent.__claudeTlsApplied).toBe(true)
    expect(browserAgent.__claudeTlsApplied).toBeUndefined()
  })

  test('ProxyHelper.normalizeProxyEndpoint strips credentials and normalizes case', () => {
    expect(
      ProxyHelper.normalizeProxyEndpoint({
        type: 'SOCKS5',
        host: 'Proxy.Example.COM',
        port: 1080,
        username: 'secret',
        password: 'pw'
      })
    ).toBe('socks5://proxy.example.com:1080')
    expect(ProxyHelper.normalizeProxyEndpoint(null)).toBeNull()
  })

  test('buildCookieHeaders emits modern Chrome headers and consistent first-party device/session IDs', () => {
    const first = oauthHelper.buildCookieHeaders('sk-ant-sid01-test-key')
    const second = oauthHelper.buildCookieHeaders('sk-ant-sid01-test-key')
    const other = oauthHelper.buildCookieHeaders('sk-ant-sid01-different-key')

    expect(first['User-Agent']).toContain('Chrome/136.0.0.0')
    expect(first['sec-ch-ua']).toContain('136')
    expect(first['Sec-Fetch-Site']).toBe('same-origin')
    expect(first['anthropic-device-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(first['x-activity-session-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(first.Cookie).toContain(`anthropic-device-id=${first['anthropic-device-id']}`)
    expect(first.Cookie).toContain(`activitySessionId=${first['x-activity-session-id']}`)
    expect(second['anthropic-device-id']).toBe(first['anthropic-device-id'])
    expect(other['anthropic-device-id']).not.toBe(first['anthropic-device-id'])
  })

  test('getOrganizationInfo uses browser-mode proxy agent without Claude CLI TLS impersonation', async () => {
    mockAxiosGet.mockResolvedValue({
      data: [{ uuid: 'org-1', capabilities: ['chat'] }]
    })

    await oauthHelper.getOrganizationInfo('sk-ant-sid01-abc', {
      type: 'http',
      host: '127.0.0.1',
      port: 18081
    })

    expect(mockAxiosGet).toHaveBeenCalledTimes(1)
    const axiosConfig = mockAxiosGet.mock.calls[0][1]
    expect(axiosConfig.httpsAgent).toBeTruthy()
    expect(axiosConfig.httpsAgent.__claudeTlsApplied).toBeUndefined()
    expect(axiosConfig.headers['anthropic-device-id']).toBeTruthy()
    expect(axiosConfig.headers['x-activity-session-id']).toBeTruthy()
  })

  test('exchangeCodeForTokens uses Claude HTTPS agent even when no proxy is configured', async () => {
    mockAxiosPost.mockResolvedValue({
      data: {
        access_token: 'sk-ant-oat01-token',
        refresh_token: 'sk-ant-ort01-refresh',
        expires_in: 3600,
        scope: 'user:inference'
      }
    })

    await oauthHelper.exchangeCodeForTokens('code-123#state-456', 'verifier-xyz', 'state-456', null)

    expect(mockAxiosPost).toHaveBeenCalledTimes(1)
    const axiosConfig = mockAxiosPost.mock.calls[0][2]
    expect(axiosConfig.httpsAgent).toBeTruthy()
  })

  test('claudeAccountService control plane uses modern default UA and audits proxy sharing', () => {
    const _realSetInterval = global.setInterval
    global.setInterval = (fn, ms, ...args) => {
      const timer = _realSetInterval(fn, ms, ...args)
      timer?.unref?.()
      return timer
    }
    const claudeAccountService = require('../src/services/account/claudeAccountService')
    global.setInterval = _realSetInterval

    expect(claudeAccountService._resolveControlPlaneUserAgent({})).toBe(DEFAULT_CLAUDE_USER_AGENT)
    expect(
      claudeAccountService._resolveControlPlaneUserAgent({
        userAgent: 'claude-cli/2.1.99 (external, cli)'
      })
    ).toBe('claude-cli/2.1.99 (external, cli)')

    const audit = claudeAccountService.auditAccountProxyRisks([
      { id: 'a1', isActive: 'true', proxy: JSON.stringify({ type: 'socks5', host: '1.2.3.4', port: 1080 }) },
      { id: 'a2', isActive: 'true', proxy: JSON.stringify({ type: 'socks5', host: '1.2.3.4', port: 1080 }) },
      { id: 'a3', isActive: 'true', proxy: '' },
      { id: 'a4', isActive: 'false', proxy: '' }
    ])

    expect(audit.directAccountIds).toEqual(['a3'])
    expect(audit.sharedEndpoints).toEqual({
      'socks5://1.2.3.4:1080': ['a1', 'a2']
    })
  })
})
