const mockStore = new Map()

jest.mock(
  '../config/config',
  () => ({
    claude: {}
  }),
  { virtual: true }
)

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

jest.mock('../src/services/tokenRefreshService', () => ({}))
jest.mock('../src/utils/tokenRefreshLogger', () => ({}))
jest.mock('../src/utils/webhookNotifier', () => ({
  sendAccountAnomalyNotification: jest.fn().mockResolvedValue(undefined)
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  recordErrorHistory: jest.fn(() => ({ catch: jest.fn() })),
  markTempUnavailable: jest.fn(() => ({ catch: jest.fn() })),
  clearTempUnavailable: jest.fn().mockResolvedValue(undefined),
  parseRetryAfter: jest.fn(() => null)
}))
jest.mock('../src/utils/proxyHelper', () => ({}))
jest.mock('axios', () => ({}))

const mockClearRateLimitAtomic = jest.fn(async (id) => {
  const existing = mockStore.get(id)
  if (!existing) {
    return { status: -1, currentStatus: '' }
  }
  const next = { ...existing }
  delete next.rateLimitedAt
  delete next.rateLimitStatus
  delete next.rateLimitEndAt
  delete next.rateLimitAutoStopped
  next.schedulable = 'true'
  mockStore.set(id, next)
  return { status: 1, currentStatus: existing.status || 'active' }
})

const mockUpdatePassiveUsage = jest.fn(async (id, fields, nowMs = Date.now()) => {
  const existing = mockStore.get(id)
  if (!existing) {
    return { updated: false, fableRateLimitEndAt: '' }
  }
  const next = { ...existing }
  const nowIso = new Date(nowMs).toISOString()
  const next5hReset = fields.claudeFiveHourResetsAt ? String(fields.claudeFiveHourResetsAt) : ''
  const prev5hReset = existing.claudeFiveHourResetsAt || ''
  if (next5hReset && prev5hReset && next5hReset !== prev5hReset) {
    const pairs = [
      ['claudeSevenDayUtilization', 'claudeSevenDayResetsAt'],
      ['claudeSevenDayOpusUtilization', 'claudeSevenDayOpusResetsAt'],
      ['claudeSevenDayFableUtilization', 'claudeSevenDayFableResetsAt']
    ]
    for (const [utilField, resetField] of pairs) {
      if (fields[utilField] === undefined && fields[resetField] === undefined) {
        const storedReset = existing[resetField] || ''
        if (storedReset && storedReset <= nowIso) {
          delete next[utilField]
          delete next[resetField]
        }
      }
    }
  }
  for (const [k, v] of Object.entries(fields)) {
    next[k] = String(v)
  }
  mockStore.set(id, next)
  return { updated: true, fableRateLimitEndAt: next.fableRateLimitEndAt || '' }
})

jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn(async (id) => (mockStore.has(id) ? { ...mockStore.get(id) } : {})),
  setClaudeAccount: jest.fn(async (id, data) => {
    mockStore.set(id, { ...data })
  }),
  clearClaudeAccountRateLimitAtomic: mockClearRateLimitAtomic,
  updateClaudeAccountPassiveUsage: mockUpdatePassiveUsage,
  client: {
    hdel: jest.fn(async (key, ...fields) => {
      const id = key.replace('claude:account:', '')
      const existing = mockStore.get(id)
      if (!existing) {
        return 0
      }
      const next = { ...existing }
      fields.forEach((f) => delete next[f])
      mockStore.set(id, next)
      return fields.length
    })
  }
}))

const _realSetInterval = global.setInterval
global.setInterval = (fn, ms, ...args) => {
  const timer = _realSetInterval(fn, ms, ...args)
  if (timer && typeof timer.unref === 'function') {
    timer.unref()
  }
  return timer
}
const { parseClaudePassiveUsageHeaders } = require('../src/utils/claudePassiveUsageHelper')
const claudeAccountService = require('../src/services/account/claudeAccountService')
global.setInterval = _realSetInterval

const NOW_MS = Date.parse('2026-11-20T08:00:00.000Z')
const NOW_SEC = Math.floor(NOW_MS / 1000)

describe('Claude passive usage helper and snapshot lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockStore.clear()
    jest.useFakeTimers()
    jest.setSystemTime(NOW_MS)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('converts 0..1 header ratios to 0..100 percentages and rejects calendar resets', () => {
    const parsed = parseClaudePassiveUsageHeaders(
      {
        'Anthropic-Ratelimit-Unified-5h-Status': 'allowed',
        'Anthropic-Ratelimit-Unified-5h-Utilization': '0.425',
        'Anthropic-Ratelimit-Unified-5h-Reset': String(NOW_SEC + 3600),
        'anthropic-ratelimit-unified-7d-utilization': '0.18',
        'anthropic-ratelimit-unified-7d-reset': String((NOW_SEC + 12 * 86400) * 1000),
        'anthropic-ratelimit-unified-7d_oi-status': 'allowed_warning',
        'anthropic-ratelimit-unified-7d_oi-utilization': '0.8725',
        'anthropic-ratelimit-unified-7d_oi-reset': String(NOW_SEC + 4 * 86400)
      },
      NOW_MS
    )

    expect(parsed.hasAny).toBe(true)
    expect(parsed.fiveHour).toEqual({
      status: 'allowed',
      ratio: 0.425,
      utilization: 42.5,
      resetEpochSec: NOW_SEC + 3600,
      resetsAt: new Date((NOW_SEC + 3600) * 1000).toISOString()
    })
    expect(parsed.sevenDay).toEqual({
      status: null,
      ratio: 0.18,
      utilization: 18,
      resetEpochSec: null,
      resetsAt: null
    })
    expect(parsed.sevenDayFable).toEqual({
      status: 'allowed_warning',
      ratio: 0.8725,
      utilization: 87.25,
      resetEpochSec: NOW_SEC + 4 * 86400,
      resetsAt: new Date((NOW_SEC + 4 * 86400) * 1000).toISOString()
    })
  })

  test('records passive usage for setup-token accounts and builds snapshot including Fable', async () => {
    mockStore.set('setup-1', {
      id: 'setup-1',
      name: 'setup-acct',
      status: 'active',
      schedulable: 'true',
      scopes: 'user:inference'
    })

    const res = await claudeAccountService.recordPassiveUsageFromHeaders('setup-1', {
      'anthropic-ratelimit-unified-5h-utilization': '0.25',
      'anthropic-ratelimit-unified-5h-reset': String(NOW_SEC + 7200),
      'anthropic-ratelimit-unified-7d-utilization': '0.5',
      'anthropic-ratelimit-unified-7d-reset': String(NOW_SEC + 5 * 86400),
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.6',
      'anthropic-ratelimit-unified-7d_oi-reset': String(NOW_SEC + 3 * 86400)
    })

    expect(res).toEqual({ updated: true })

    const snapshot = claudeAccountService.buildClaudeUsageSnapshot(mockStore.get('setup-1'))
    expect(snapshot.fiveHour.utilization).toBe(25)
    expect(snapshot.sevenDay.utilization).toBe(50)
    expect(snapshot.sevenDayScopedModels).toEqual([
      {
        modelName: 'Fable',
        utilization: 60,
        resetsAt: new Date((NOW_SEC + 3 * 86400) * 1000).toISOString(),
        severity: null,
        isActive: true,
        source: 'passive',
        remainingSeconds: 3 * 86400
      }
    ])
  })

  test('preserves unexpired weekly readings across 5h rollover while dropping expired ones', async () => {
    const old5hReset = new Date(NOW_MS - 60 * 1000).toISOString()
    const new5hReset = new Date(NOW_MS + 5 * 3600 * 1000).toISOString()
    const expiredOpusReset = new Date(NOW_MS - 3600 * 1000).toISOString()
    const future7dReset = new Date(NOW_MS + 3 * 86400 * 1000).toISOString()
    const futureFableReset = new Date(NOW_MS + 4 * 86400 * 1000).toISOString()

    mockStore.set('acct-rollover', {
      id: 'acct-rollover',
      claudeFiveHourUtilization: '98',
      claudeFiveHourResetsAt: old5hReset,
      claudeSevenDayUtilization: '40',
      claudeSevenDayResetsAt: future7dReset,
      claudeSevenDayOpusUtilization: '88',
      claudeSevenDayOpusResetsAt: expiredOpusReset,
      claudeSevenDayFableUtilization: '99',
      claudeSevenDayFableResetsAt: futureFableReset
    })

    await claudeAccountService.recordPassiveUsageFromHeaders('acct-rollover', {
      'anthropic-ratelimit-unified-5h-utilization': '0.02',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.parse(new5hReset) / 1000))
    })

    const stored = mockStore.get('acct-rollover')
    expect(stored.claudeFiveHourUtilization).toBe('2')
    expect(stored.claudeSevenDayUtilization).toBe('40')
    expect(stored.claudeSevenDayFableUtilization).toBe('99')
    expect(stored.claudeSevenDayOpusUtilization).toBeUndefined()
  })

  test('auto-recovers Fable limit only when 7d_oi drops below 95% and is not rejected', async () => {
    const futureReset = new Date(NOW_MS + 3 * 86400 * 1000).toISOString()
    mockStore.set('acct-fable', {
      id: 'acct-fable',
      fableRateLimitedAt: new Date(NOW_MS - 3600 * 1000).toISOString(),
      fableRateLimitEndAt: futureReset
    })

    // Rejected header should NOT clear the limit
    await claudeAccountService.recordPassiveUsageFromHeaders('acct-fable', {
      'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.90'
    })
    expect(mockStore.get('acct-fable').fableRateLimitEndAt).toBe(futureReset)

    // Missing 7d_oi should NOT clear the limit
    await claudeAccountService.recordPassiveUsageFromHeaders('acct-fable', {
      'anthropic-ratelimit-unified-5h-utilization': '0.10'
    })
    expect(mockStore.get('acct-fable').fableRateLimitEndAt).toBe(futureReset)

    // Recovered 7d_oi (< 95% and allowed) DOES clear the limit
    await claudeAccountService.recordPassiveUsageFromHeaders('acct-fable', {
      'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.20',
      'anthropic-ratelimit-unified-7d_oi-reset': String(NOW_SEC + 6 * 86400)
    })
    expect(mockStore.get('acct-fable').fableRateLimitEndAt).toBeUndefined()
  })

  test('updateClaudeUsageSnapshot auto-recovers opus, fable, and auto-stopped account limits under 95%', async () => {
    const futureIso = new Date(NOW_MS + 3 * 86400 * 1000).toISOString()
    mockStore.set('acct-oauth', {
      id: 'acct-oauth',
      name: 'oauth-acct',
      status: 'active',
      schedulable: 'false',
      rateLimitStatus: 'limited',
      rateLimitAutoStopped: 'true',
      rateLimitEndAt: futureIso,
      opusRateLimitedAt: new Date(NOW_MS - 1000).toISOString(),
      opusRateLimitEndAt: futureIso,
      fableRateLimitedAt: new Date(NOW_MS - 1000).toISOString(),
      fableRateLimitEndAt: futureIso
    })

    await claudeAccountService.updateClaudeUsageSnapshot('acct-oauth', {
      five_hour: { utilization: 10, resets_at: futureIso },
      seven_day: { utilization: 25, resets_at: futureIso },
      seven_day_sonnet: { utilization: 30, resets_at: futureIso },
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 12,
          resets_at: futureIso,
          is_active: true,
          scope: { model: { display_name: 'Fable' } }
        }
      ]
    })

    const stored = mockStore.get('acct-oauth')
    expect(stored.opusRateLimitEndAt).toBeUndefined()
    expect(stored.fableRateLimitEndAt).toBeUndefined()
    expect(stored.rateLimitStatus).toBeUndefined()
    expect(stored.schedulable).toBe('true')
    expect(mockClearRateLimitAtomic).toHaveBeenCalledWith('acct-oauth')
  })

  test('real Redis updateClaudeAccountPassiveUsage Lua script executes cleanly and preserves unexpired weekly fields', async () => {
    const realRedis = jest.requireActual('../src/models/redis')
    const evalMock = jest.fn().mockResolvedValue([1, ''])
    jest.spyOn(realRedis, 'getClientSafe').mockReturnValue({ eval: evalMock })

    const res = await realRedis.updateClaudeAccountPassiveUsage(
      'acct-lua',
      {
        claudeFiveHourUtilization: '15',
        claudeFiveHourResetsAt: '2026-11-20T13:00:00.000Z'
      },
      NOW_MS
    )

    expect(res).toEqual({ updated: true, fableRateLimitEndAt: '' })
    const [script, keyCount, key, nowIso, next5hReset] = evalMock.mock.calls[0]
    expect(keyCount).toBe(1)
    expect(key).toBe('claude:account:acct-lua')
    expect(nowIso).toBe('2026-11-20T08:00:00.000Z')
    expect(next5hReset).toBe('2026-11-20T13:00:00.000Z')
    expect(script).toContain('claudeSevenDayFableResetsAt')
    expect(script).toContain("redis.call('HDEL'")
  })
})
