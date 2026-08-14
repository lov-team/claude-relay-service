jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(() => ({
    set: jest.fn()
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
})

describe('requestIdentityService.transform', () => {
  it('rewrites empty account_uuid from object extInfo', () => {
    const body = {
      metadata: {
        user_id: JSON.stringify({
          device_id: 'd'.repeat(64),
          account_uuid: '',
          session_id: 'c72554f2-d198-4fd4-99c8-81e46410a1c5'
        })
      }
    }

    const result = requestIdentityService.transform({
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
})
