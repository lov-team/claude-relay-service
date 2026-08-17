jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/account/claudeAccountNurtureService', () => ({
  evaluate: jest.fn().mockResolvedValue({ blocked: false })
}))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({}))
jest.mock('../src/services/account/bedrockAccountService', () => ({}))
jest.mock('../src/services/account/ccrAccountService', () => ({}))
jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))
jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: jest.fn((value) => value !== false && value !== 'false'),
  sortAccountsByPriority: jest.fn((accounts) => accounts)
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))
jest.mock('../src/services/userAgentPoolService', () => ({
  recordUserAgent: jest.fn(),
  detectPlatform: jest.fn((userAgent, headers = {}) => {
    const stainlessOs = headers['x-stainless-os'] || headers['X-Stainless-OS'] || ''
    if (/windows/i.test(stainlessOs)) {
      return 'windows'
    }
    if (/linux/i.test(stainlessOs)) {
      return 'linux'
    }
    if (/mac|darwin/i.test(stainlessOs)) {
      return 'mac'
    }
    if (/windows/i.test(userAgent || '')) {
      return 'windows'
    }
    if (/linux/i.test(userAgent || '')) {
      return 'linux'
    }
    if (/mac|darwin/i.test(userAgent || '')) {
      return 'mac'
    }
    return 'unknown'
  })
}))

const userAgentPoolService = require('../src/services/userAgentPoolService')
const scheduler = require('../src/services/scheduler/unifiedClaudeScheduler')

describe('UnifiedClaudeScheduler User-Agent platform affinity', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    userAgentPoolService.recordUserAgent.mockImplementation(async (userAgent, headers) => ({
      userAgent,
      platform: userAgentPoolService.detectPlatform(userAgent, headers),
      lastSeenAt: Date.now()
    }))
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('prefers an account pinned to the same platform for a new session', async () => {
    jest.spyOn(scheduler, '_getAllAvailableAccounts').mockResolvedValue([
      {
        accountId: 'linux-account',
        accountType: 'claude-official',
        name: 'linux',
        userAgentPlatform: 'linux'
      },
      {
        accountId: 'windows-account',
        accountType: 'claude-official',
        name: 'windows',
        userAgentPlatform: 'windows'
      }
    ])

    await expect(
      scheduler.selectAccountForApiKey(
        { id: 'key-1', name: 'key-1' },
        null,
        'claude-sonnet-4-5',
        null,
        'claude-cli/2.1.0 (external, cli, windows, x64)'
      )
    ).resolves.toEqual({
      accountId: 'windows-account',
      accountType: 'claude-official'
    })
    expect(userAgentPoolService.recordUserAgent).not.toHaveBeenCalled()
  })

  test('keeps an existing sticky mapping even when its platform differs', async () => {
    const mapped = { accountId: 'linux-account', accountType: 'claude-official' }
    jest.spyOn(scheduler, '_getSessionMapping').mockResolvedValue(mapped)
    jest.spyOn(scheduler, '_isAccountAvailable').mockResolvedValue(true)
    jest.spyOn(scheduler, '_extendSessionMappingTTL').mockResolvedValue(undefined)
    const poolLookup = jest.spyOn(scheduler, '_getAllAvailableAccounts')

    await expect(
      scheduler.selectAccountForApiKey(
        { id: 'key-1', name: 'key-1' },
        'session-1',
        'claude-sonnet-4-5',
        null,
        'claude-cli/2.1.0 (external, cli, windows, x64)'
      )
    ).resolves.toEqual(mapped)
    expect(poolLookup).not.toHaveBeenCalled()
  })

  test('uses Stainless OS when the Claude User-Agent has no platform', async () => {
    jest.spyOn(scheduler, '_getAllAvailableAccounts').mockResolvedValue([
      { accountId: 'linux-account', accountType: 'claude-official', userAgentPlatform: 'linux' },
      { accountId: 'mac-account', accountType: 'claude-official', userAgentPlatform: 'mac' }
    ])

    await expect(
      scheduler.selectAccountForApiKey(
        { id: 'key-2', name: 'key-2' },
        null,
        'claude-sonnet-4-5',
        null,
        {
          'user-agent': 'claude-cli/2.1.228 (external, cli)',
          'x-stainless-os': 'MacOS'
        }
      )
    ).resolves.toEqual({ accountId: 'mac-account', accountType: 'claude-official' })
    expect(userAgentPoolService.recordUserAgent).not.toHaveBeenCalled()
  })

  test('falls back to the existing account order when no platform matches', async () => {
    const accounts = [
      { accountId: 'linux-account', userAgentPlatform: 'linux' },
      { accountId: 'mac-account', userAgentPlatform: 'mac' }
    ]

    expect(scheduler._preferSamePlatform(accounts, 'windows')).toBe(accounts)
  })
})
