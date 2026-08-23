jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const mockRedisGet = jest.fn(async () => null)
const mockRedisSet = jest.fn(async () => 'OK')

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(() => ({
    get: mockRedisGet,
    set: mockRedisSet
  }))
}))

const requestIdentityService = require('../src/services/requestIdentityService')

const ACCOUNT_ID = '9c2d5b54-ae58-4ffd-9401-a8127e3f34b3'
const ACCOUNT_UUID = '8513b596-1111-2222-3333-444444444444'

describe('requestIdentityService.extractAccountUuid', () => {
  it('reads account_uuid from string extInfo', () => {
    const uuid = requestIdentityService.extractAccountUuid({
      id: ACCOUNT_ID,
      extInfo: JSON.stringify({ account_uuid: ACCOUNT_UUID, org_uuid: 'org-1' })
    })

    expect(uuid).toBe(ACCOUNT_UUID)
  })

  it('reads account_uuid from object extInfo', () => {
    const uuid = requestIdentityService.extractAccountUuid({
      id: ACCOUNT_ID,
      extInfo: { account_uuid: ACCOUNT_UUID, org_uuid: 'org-1' }
    })

    expect(uuid).toBe(ACCOUNT_UUID)
  })

  it('reads top-level account_uuid when extInfo is missing', () => {
    const uuid = requestIdentityService.extractAccountUuid({
      id: ACCOUNT_ID,
      account_uuid: ACCOUNT_UUID
    })

    expect(uuid).toBe(ACCOUNT_UUID)
  })

  it('returns null for empty account_uuid', () => {
    expect(
      requestIdentityService.extractAccountUuid({
        id: ACCOUNT_ID,
        extInfo: { account_uuid: '' }
      })
    ).toBeNull()
  })
})

describe('requestIdentityService.buildRelayGeneratedUserId', () => {
  it('fills real account_uuid and keeps session stable for the same conversation hash', () => {
    const account = {
      id: ACCOUNT_ID,
      extInfo: { account_uuid: ACCOUNT_UUID }
    }

    const first = JSON.parse(
      requestIdentityService.buildRelayGeneratedUserId(account, 'conv-hash-aaa')
    )
    const second = JSON.parse(
      requestIdentityService.buildRelayGeneratedUserId(account, 'conv-hash-aaa')
    )

    expect(first.account_uuid).toBe(ACCOUNT_UUID)
    expect(first.session_id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
    )
    expect(first.device_id).toHaveLength(64)
    expect(second).toEqual(first)
  })

  it('uses different sessions for different conversation hashes on the same account', () => {
    const account = {
      id: ACCOUNT_ID,
      extInfo: { account_uuid: ACCOUNT_UUID }
    }
    const left = JSON.parse(
      requestIdentityService.buildRelayGeneratedUserId(account, 'conv-hash-aaa')
    )
    const right = JSON.parse(
      requestIdentityService.buildRelayGeneratedUserId(account, 'conv-hash-bbb')
    )

    expect(left.account_uuid).toBe(ACCOUNT_UUID)
    expect(right.account_uuid).toBe(ACCOUNT_UUID)
    expect(left.device_id).toBe(right.device_id)
    expect(left.session_id).not.toBe(right.session_id)
  })

  it('uses unifiedClientId as the account-level device_id', () => {
    const account = {
      id: ACCOUNT_ID,
      extInfo: { account_uuid: ACCOUNT_UUID },
      useUnifiedClientId: true,
      unifiedClientId: 'e'.repeat(64)
    }

    const userId = JSON.parse(
      requestIdentityService.buildRelayGeneratedUserId(account, 'conv-hash-aaa')
    )

    expect(userId.device_id).toBe(account.unifiedClientId)
    expect(userId.account_uuid).toBe(ACCOUNT_UUID)
  })
})

describe('requestIdentityService.transform', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRedisGet.mockResolvedValue(null)
    mockRedisSet.mockResolvedValue('OK')
  })

  it('rewrites empty account_uuid from object extInfo', async () => {
    const body = {
      metadata: {
        user_id: JSON.stringify({
          device_id: 'd'.repeat(64),
          account_uuid: '',
          session_id: 'c72554f2-d198-4fd4-99c8-81e46410a1c5'
        })
      }
    }

    const result = await requestIdentityService.transform({
      body,
      headers: {},
      accountId: ACCOUNT_ID,
      account: {
        id: ACCOUNT_ID,
        extInfo: { account_uuid: ACCOUNT_UUID }
      }
    })

    const userId = JSON.parse(result.body.metadata.user_id)
    expect(userId.account_uuid).toBe(ACCOUNT_UUID)
    expect(userId.session_id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
    )
  })

  it('reuses a complete persisted Stainless fingerprint', async () => {
    const fingerprint = {
      'x-stainless-retry-count': '0',
      'x-stainless-timeout': '60',
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '0.68.0',
      'x-stainless-os': 'MacOS',
      'x-stainless-arch': 'arm64',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v22.18.0'
    }
    mockRedisGet.mockResolvedValue(JSON.stringify(fingerprint))

    const result = await requestIdentityService.transform({
      body: {},
      headers: { 'X-Stainless-OS': 'Windows' },
      accountId: ACCOUNT_ID,
      account: { id: ACCOUNT_ID }
    })

    expect(result.headers).toMatchObject({
      'X-Stainless-OS': 'MacOS',
      'X-Stainless-Arch': 'arm64',
      'X-Stainless-Runtime-Version': 'v22.18.0'
    })
  })

  it('prefers the account-pinned Stainless fingerprint over Redis', async () => {
    const pinnedFingerprint = {
      'x-stainless-retry-count': '0',
      'x-stainless-timeout': '60',
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '0.68.0',
      'x-stainless-os': 'Linux',
      'x-stainless-arch': 'x64',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v22.18.0'
    }

    const result = await requestIdentityService.transform({
      body: {},
      headers: {},
      accountId: ACCOUNT_ID,
      account: { id: ACCOUNT_ID, stainlessFingerprint: JSON.stringify(pinnedFingerprint) }
    })

    expect(result.headers['X-Stainless-OS']).toBe('Linux')
    expect(mockRedisGet).not.toHaveBeenCalled()
  })

  it('forges a complete account-level fingerprint and ignores incomplete inbound Stainless fields', async () => {
    const result = await requestIdentityService.transform({
      body: {},
      headers: {
        'X-Stainless-OS': 'Windows',
        'X-Stainless-Runtime': 'deno'
      },
      accountId: ACCOUNT_ID,
      account: {
        id: ACCOUNT_ID,
        userAgentPlatform: 'macos',
        stainlessFingerprint: JSON.stringify({
          'x-stainless-os': 'MacOS',
          'x-stainless-arch': 'arm64'
        })
      }
    })

    expect(result.headers['X-Stainless-OS']).toBe('MacOS')
    expect(result.headers['X-Stainless-Arch']).toBe('arm64')
    expect(result.headers['X-Stainless-Lang']).toBe('js')
    expect(result.headers['X-Stainless-Package-Version']).toBe('0.68.0')
    expect(result.headers['X-Stainless-Runtime']).toBe('node')
    expect(result.headers['X-Stainless-Runtime-Version']).toBe('v22.18.0')
    expect(result.headers['X-Stainless-Retry-Count']).toBe('0')
    expect(result.headers['X-Stainless-Timeout']).toBe('60')
    expect(mockRedisSet).toHaveBeenCalled()
  })

  it('locks session_id to the conversation hash and keeps account-level device and uuid', async () => {
    const account = {
      id: ACCOUNT_ID,
      extInfo: { account_uuid: ACCOUNT_UUID },
      useUnifiedClientId: true,
      unifiedClientId: 'e'.repeat(64)
    }
    const body = {
      metadata: {
        user_id: JSON.stringify({
          device_id: 'd'.repeat(64),
          account_uuid: '',
          session_id: 'c72554f2-d198-4fd4-99c8-81e46410a1c5'
        })
      }
    }

    const first = await requestIdentityService.transform({
      body,
      headers: {},
      accountId: ACCOUNT_ID,
      account,
      sessionHash: 'conv-hash-aaa'
    })
    const second = await requestIdentityService.transform({
      body,
      headers: {},
      accountId: ACCOUNT_ID,
      account,
      sessionHash: 'conv-hash-aaa'
    })
    const other = await requestIdentityService.transform({
      body,
      headers: {},
      accountId: ACCOUNT_ID,
      account,
      sessionHash: 'conv-hash-bbb'
    })

    const firstId = JSON.parse(first.body.metadata.user_id)
    const secondId = JSON.parse(second.body.metadata.user_id)
    const otherId = JSON.parse(other.body.metadata.user_id)
    const expectedSession = requestIdentityService._internal.formatUuidFromSeed(
      'conv-hash-aaa::relay-session'
    )

    expect(firstId.account_uuid).toBe(ACCOUNT_UUID)
    expect(firstId.device_id).toBe(account.unifiedClientId)
    expect(firstId.session_id).toBe(expectedSession)
    expect(secondId).toEqual(firstId)
    expect(otherId.device_id).toBe(firstId.device_id)
    expect(otherId.account_uuid).toBe(ACCOUNT_UUID)
    expect(otherId.session_id).not.toBe(firstId.session_id)
  })

  it('keeps a real Claude Code session derived from the inbound session, not the scheduler hash', async () => {
    const inboundSession = 'c72554f2-d198-4fd4-99c8-81e46410a1c5'
    const result = await requestIdentityService.transform({
      body: {
        metadata: {
          user_id: JSON.stringify({
            device_id: 'd'.repeat(64),
            account_uuid: '',
            session_id: inboundSession
          })
        }
      },
      headers: {},
      accountId: ACCOUNT_ID,
      account: {
        id: ACCOUNT_ID,
        extInfo: { account_uuid: ACCOUNT_UUID }
      },
      sessionHash: 'conv-hash-aaa',
      isRealClaudeCode: true
    })

    const userId = JSON.parse(result.body.metadata.user_id)
    expect(userId.account_uuid).toBe(ACCOUNT_UUID)
    expect(userId.device_id).toBe('d'.repeat(64))
    expect(userId.session_id).toBe(
      requestIdentityService._internal.formatUuidFromSeed(`${ACCOUNT_ID}::${inboundSession}`)
    )
    expect(userId.session_id).not.toBe(
      requestIdentityService._internal.formatUuidFromSeed('conv-hash-aaa::relay-session')
    )
  })
})
