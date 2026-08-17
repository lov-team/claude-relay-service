const mockPipeline = {
  zadd: jest.fn().mockReturnThis(),
  hset: jest.fn().mockReturnThis(),
  zremrangebyrank: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([])
}

const mockClient = {
  pipeline: jest.fn(() => mockPipeline),
  zrevrange: jest.fn(),
  hget: jest.fn(),
  hmget: jest.fn()
}

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(() => mockClient)
}))

jest.mock('../src/utils/logger', () => ({
  warn: jest.fn()
}))

const userAgentPoolService = require('../src/services/userAgentPoolService')
const {
  USER_AGENT_POOL_KEY,
  USER_AGENT_POOL_METADATA_KEY
} = require('../src/services/userAgentPoolService')

describe('UserAgentPoolService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockClient.pipeline.mockReturnValue(mockPipeline)
    mockPipeline.zadd.mockReturnThis()
    mockPipeline.hset.mockReturnThis()
    mockPipeline.zremrangebyrank.mockReturnThis()
    mockPipeline.exec.mockResolvedValue([])
    mockClient.hget.mockResolvedValue(null)
    mockClient.hmget.mockResolvedValue([])
  })

  test.each([
    ['client/1.0 (Windows NT 10.0; Win64; x64)', 'windows'],
    ['client/1.0 (Macintosh; Intel Mac OS X 14_5)', 'mac'],
    ['client/1.0 (X11; Linux x86_64)', 'linux'],
    ['claude-cli/2.1.0 (external, cli)', 'unknown']
  ])('detects %s as %s', (userAgent, platform) => {
    expect(userAgentPoolService.detectPlatform(userAgent)).toBe(platform)
  })

  test('records the latest observation in a bounded Redis sorted set', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1775577600000)
    const userAgent = 'claude-cli/2.1.0 (external, cli, linux, x64)'

    await expect(userAgentPoolService.recordUserAgent(userAgent)).resolves.toEqual({
      userAgent,
      platform: 'linux',
      stainlessFingerprint: {},
      detectionSource: 'user_agent',
      lastSeenAt: 1775577600000
    })
    expect(mockPipeline.zadd).toHaveBeenCalledWith(USER_AGENT_POOL_KEY, 1775577600000, userAgent)
    expect(mockPipeline.hset).toHaveBeenCalledWith(
      USER_AGENT_POOL_METADATA_KEY,
      userAgent,
      expect.any(String)
    )
    expect(mockPipeline.zremrangebyrank).toHaveBeenCalledWith(USER_AGENT_POOL_KEY, 0, -201)
    expect(mockPipeline.exec).toHaveBeenCalled()

    now.mockRestore()
  })

  test('does not add browser or gateway user agents to the assignable pool', async () => {
    await expect(userAgentPoolService.recordUserAgent('Go-http-client/2.0')).resolves.toBeNull()
    await expect(
      userAgentPoolService.recordUserAgent('Mozilla/5.0 (Macintosh)')
    ).resolves.toBeNull()
    expect(mockClient.pipeline).not.toHaveBeenCalled()
  })

  test('assigns the most recently observed user agent', async () => {
    mockClient.zrevrange.mockResolvedValue([
      'claude-cli/2.2.0 (external, cli, darwin, arm64)',
      '1775577600000'
    ])

    await expect(
      userAgentPoolService.assignLatestUserAgent('claude-cli/fallback')
    ).resolves.toEqual({
      userAgent: 'claude-cli/2.2.0 (external, cli, darwin, arm64)',
      platform: 'mac',
      stainlessFingerprint: {},
      detectionSource: 'user_agent',
      lastSeenAt: 1775577600000
    })
  })

  test('uses the current Claude Code version when the pool is empty', async () => {
    mockClient.zrevrange.mockResolvedValue([])

    await expect(
      userAgentPoolService.assignLatestUserAgent(userAgentPoolService.DEFAULT_CLAUDE_USER_AGENT)
    ).resolves.toEqual({
      userAgent: 'claude-cli/2.1.228 (external, cli)',
      platform: 'unknown',
      stainlessFingerprint: {},
      detectionSource: 'fallback_default',
      lastSeenAt: null
    })
  })

  test('lists recent user agents with platform and last-seen metadata', async () => {
    mockClient.zrevrange.mockResolvedValue([
      'claude-cli/2.2.0 (external, cli, windows, x64)',
      '1775577600000',
      'claude-cli/2.1.0 (external, cli, linux, x64)',
      '1775577500000'
    ])
    mockClient.hmget.mockResolvedValue([null, null])

    await expect(userAgentPoolService.listRecentUserAgents(2)).resolves.toEqual([
      {
        userAgent: 'claude-cli/2.2.0 (external, cli, windows, x64)',
        platform: 'windows',
        stainlessFingerprint: {},
        detectionSource: 'user_agent',
        lastSeenAt: 1775577600000
      },
      {
        userAgent: 'claude-cli/2.1.0 (external, cli, linux, x64)',
        platform: 'linux',
        stainlessFingerprint: {},
        detectionSource: 'user_agent',
        lastSeenAt: 1775577500000
      }
    ])
    expect(mockClient.zrevrange).toHaveBeenCalledWith(USER_AGENT_POOL_KEY, 0, 1, 'WITHSCORES')
  })

  test('uses Stainless OS and stores the complete fingerprint metadata', async () => {
    const userAgent = 'claude-cli/2.1.228 (external, cli)'
    const headers = {
      'user-agent': userAgent,
      'x-stainless-retry-count': '0',
      'x-stainless-timeout': '60',
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '0.68.0',
      'x-stainless-os': 'MacOS',
      'x-stainless-arch': 'arm64',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v22.18.0'
    }

    const captured = await userAgentPoolService.recordUserAgent(userAgent, headers)

    expect(captured).toMatchObject({
      userAgent,
      platform: 'mac',
      detectionSource: 'stainless_headers',
      stainlessFingerprint: {
        'x-stainless-os': 'MacOS',
        'x-stainless-arch': 'arm64'
      }
    })
  })
})
