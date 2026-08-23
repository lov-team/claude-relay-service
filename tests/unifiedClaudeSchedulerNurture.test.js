jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/utils/modelHelper', () => ({
  parseVendorPrefixedModel: jest.fn((model) => ({ vendor: null, baseModel: model })),
  isOpus45OrNewer: jest.fn(() => true),
  getRateLimitModelFamily: jest.fn((model) => {
    const normalized = typeof model === 'string' ? model.toLowerCase() : ''
    return (
      ['opus', 'sonnet', 'haiku', 'fable'].find((family) => normalized.includes(family)) || null
    )
  })
}))

jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: (value) => value !== false && value !== 'false',
  sortAccountsByPriority: (accounts) => accounts
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  isTempUnavailable: jest.fn().mockResolvedValue(false)
}))

jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn(),
  getAllClaudeAccounts: jest.fn(),
  getClientSafe: jest.fn()
}))

jest.mock('../src/services/account/claudeAccountService', () => ({
  isAccountRateLimited: jest.fn().mockResolvedValue(false),
  isAccountModelRateLimited: jest.fn().mockResolvedValue(false),
  clearExpiredModelRateLimit: jest.fn().mockResolvedValue(undefined),
  getAccountModelRateLimitInfo: jest.fn().mockResolvedValue(null),
  isAccountOpusRateLimited: jest.fn().mockResolvedValue(false),
  clearExpiredOpusRateLimit: jest.fn().mockResolvedValue(undefined)
}))

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: jest.fn(),
  getAllAccounts: jest.fn().mockResolvedValue([])
}))

jest.mock('../src/services/account/bedrockAccountService', () => ({
  getAccount: jest.fn(),
  getAllAccounts: jest.fn().mockResolvedValue({ success: true, data: [] })
}))

jest.mock('../src/services/account/ccrAccountService', () => ({
  getAccount: jest.fn(),
  getAllAccounts: jest.fn().mockResolvedValue([])
}))

jest.mock('../src/services/accountGroupService', () => ({
  getGroup: jest.fn(),
  getGroupMembers: jest.fn()
}))

jest.mock('../src/services/account/claudeAccountNurtureService', () => ({
  evaluate: jest.fn(),
  recordBlocked: jest.fn().mockResolvedValue(undefined),
  createAllNurtureLimitedError: jest.fn((evaluation, accountId) => {
    const error = new Error('All available Claude accounts are nurture limited')
    error.code = 'CLAUDE_ALL_NURTURE_LIMITED'
    error.statusCode = 403
    error.nurtureReason = evaluation?.reason || null
    error.accountId = accountId || null
    return error
  }),
  isNurtureSchedulerError: jest.fn(
    (error) =>
      error?.code === 'CLAUDE_ALL_NURTURE_LIMITED' || error?.code === 'CLAUDE_NURTURE_LIMITED'
  ),
  createDedicatedNurtureLimitedError: jest.fn((accountId, evaluation) => {
    const error = new Error('Dedicated Claude account is nurture limited')
    error.code = 'CLAUDE_NURTURE_LIMITED'
    error.statusCode = 403
    error.accountId = accountId
    error.nurtureReason = evaluation?.reason || null
    return error
  })
}))

const redis = require('../src/models/redis')
const claudeAccountNurtureService = require('../src/services/account/claudeAccountNurtureService')
const accountGroupService = require('../src/services/accountGroupService')
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')

const buildOfficialAccount = (id, overrides = {}) => ({
  id,
  name: id,
  isActive: 'true',
  status: 'active',
  accountType: 'shared',
  schedulable: 'true',
  nurtureEnabled: 'true',
  nurtureTier: 'pro',
  subscriptionInfo: JSON.stringify({ accountType: 'claude_pro', hasClaudePro: true }),
  ...overrides
})

const blockedEvaluation = { blocked: true, reason: 'five_hour_steady' }
const allowedEvaluation = { blocked: false, reason: null }

describe('UnifiedClaudeScheduler nurture handling for auto-stopped accounts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    redis.getAllClaudeAccounts.mockResolvedValue([])
    claudeAccountNurtureService.evaluate.mockResolvedValue(allowedEvaluation)
  })

  test('returns the all-nurture 403 error when the shared pool was auto-stopped at 5h limit', async () => {
    const account = buildOfficialAccount('auto-stopped', {
      schedulable: 'false',
      fiveHourAutoStopped: 'true'
    })
    redis.getAllClaudeAccounts.mockResolvedValue([account])
    claudeAccountNurtureService.evaluate.mockResolvedValue(blockedEvaluation)

    await expect(
      unifiedClaudeScheduler.selectAccountForApiKey({}, null, 'claude-sonnet-4-6')
    ).rejects.toMatchObject({
      code: 'CLAUDE_ALL_NURTURE_LIMITED',
      statusCode: 403,
      nurtureReason: 'five_hour_steady'
    })
    expect(claudeAccountNurtureService.recordBlocked).toHaveBeenCalledWith(
      'auto-stopped',
      blockedEvaluation
    )
  })

  test('returns the all-nurture 403 error for an auto-stopped group member', async () => {
    const account = buildOfficialAccount('group-auto-stopped', {
      schedulable: 'false',
      fiveHourAutoStopped: true
    })
    accountGroupService.getGroup.mockResolvedValue({
      id: 'group-1',
      name: 'group-1',
      platform: 'claude'
    })
    accountGroupService.getGroupMembers.mockResolvedValue(['group-auto-stopped'])
    redis.getClaudeAccount.mockResolvedValue(account)
    claudeAccountNurtureService.evaluate.mockResolvedValue(blockedEvaluation)

    await expect(
      unifiedClaudeScheduler.selectAccountFromGroup('group-1', null, 'claude-sonnet-4-6')
    ).rejects.toMatchObject({
      code: 'CLAUDE_ALL_NURTURE_LIMITED',
      statusCode: 403,
      nurtureReason: 'five_hour_steady'
    })
  })

  test('does not report a manually disabled account as nurture limited', async () => {
    redis.getAllClaudeAccounts.mockResolvedValue([
      buildOfficialAccount('manual-stop', {
        schedulable: 'false',
        fiveHourAutoStopped: 'false'
      })
    ])

    await expect(
      unifiedClaudeScheduler.selectAccountForApiKey({}, null, 'claude-sonnet-4-6')
    ).rejects.toThrow('No available Claude accounts support the requested model')
    expect(claudeAccountNurtureService.evaluate).not.toHaveBeenCalled()
  })

  test('skips a seven_day_velocity account and uses an available fallback', async () => {
    const velocityBlocked = buildOfficialAccount('velocity-blocked')
    const fallback = buildOfficialAccount('fallback')
    redis.getAllClaudeAccounts.mockResolvedValue([velocityBlocked, fallback])
    claudeAccountNurtureService.evaluate.mockImplementation(async (accountId) =>
      accountId === 'velocity-blocked'
        ? { blocked: true, reason: 'seven_day_velocity' }
        : allowedEvaluation
    )

    await expect(
      unifiedClaudeScheduler.selectAccountForApiKey({}, null, 'claude-sonnet-4-6')
    ).resolves.toEqual({ accountId: 'fallback', accountType: 'claude-official' })
    expect(claudeAccountNurtureService.evaluate).toHaveBeenCalledWith('velocity-blocked')
    expect(claudeAccountNurtureService.evaluate).toHaveBeenCalledWith('fallback')
  })

  test('uses an available fallback instead of returning 403', async () => {
    const stopped = buildOfficialAccount('auto-stopped', {
      schedulable: 'false',
      fiveHourAutoStopped: 'true'
    })
    const fallback = buildOfficialAccount('fallback')
    redis.getAllClaudeAccounts.mockResolvedValue([stopped, fallback])
    claudeAccountNurtureService.evaluate.mockImplementation(async (accountId) =>
      accountId === 'auto-stopped' ? blockedEvaluation : allowedEvaluation
    )

    await expect(
      unifiedClaudeScheduler.selectAccountForApiKey({}, null, 'claude-sonnet-4-6')
    ).resolves.toEqual({ accountId: 'fallback', accountType: 'claude-official' })
  })

  test('keeps the dedicated-account nurture 403 behavior', async () => {
    const account = buildOfficialAccount('dedicated', {
      schedulable: 'false',
      fiveHourAutoStopped: 'true'
    })
    redis.getClaudeAccount.mockResolvedValue(account)
    claudeAccountNurtureService.evaluate.mockResolvedValue(blockedEvaluation)

    await expect(
      unifiedClaudeScheduler.selectAccountForApiKey(
        { claudeAccountId: 'dedicated', name: 'dedicated-key' },
        null,
        'claude-sonnet-4-6'
      )
    ).rejects.toMatchObject({
      code: 'CLAUDE_NURTURE_LIMITED',
      statusCode: 403,
      accountId: 'dedicated'
    })
  })
})
