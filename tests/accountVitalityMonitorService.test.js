jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const { AccountVitalityMonitorService } = require('../src/services/accountVitalityMonitorService')

describe('AccountVitalityMonitorService', () => {
  const buildService = ({ getAccounts, getAllTempUnavailable, sendNotification }) =>
    new AccountVitalityMonitorService({
      accountSources: [{ platform: 'claude', getAccounts }],
      upstreamErrorHelper: { getAllTempUnavailable },
      webhookNotifier: { sendAccountAnomalyNotification: sendNotification },
      webhookService: { sendNotification },
      logger: require('../src/utils/logger')
    })

  it('baselines on first scan and sends only when vitality status changes', async () => {
    let accounts = [{ id: 'acct-1', name: 'Main', isActive: true, status: 'active' }]
    const sendNotification = jest.fn().mockResolvedValue(undefined)
    const service = buildService({
      getAccounts: jest.fn(async () => accounts),
      getAllTempUnavailable: jest.fn(async () => ({})),
      sendNotification
    })

    await service.performCheck()
    expect(sendNotification).not.toHaveBeenCalled()

    accounts = [{ id: 'acct-1', name: 'Main', isActive: false, status: 'error' }]
    await service.performCheck()
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(sendNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        accountName: 'Main',
        platform: 'claude',
        previousStatus: '正常',
        status: '错误/认证异常',
        reason: '账号不可用或认证异常'
      })
    )

    await service.performCheck()
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })

  it('notifies when temp-unavailable expires back to normal', async () => {
    let tempStatuses = {
      'claude:acct-1': { statusCode: 503, errorType: 'server_error', remainingSeconds: 30 }
    }
    const sendNotification = jest.fn().mockResolvedValue(undefined)
    const service = buildService({
      getAccounts: jest.fn(async () => [
        { id: 'acct-1', name: 'Main', isActive: true, status: 'active' }
      ]),
      getAllTempUnavailable: jest.fn(async () => tempStatuses),
      sendNotification
    })

    await service.performCheck()
    expect(sendNotification).not.toHaveBeenCalled()

    tempStatuses = {}
    await service.performCheck()
    expect(sendNotification).toHaveBeenCalledTimes(1)
    expect(sendNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        previousStatus: '临时暂停/过载',
        status: '正常'
      })
    )
  })

  it('builds a current vitality summary grouped by status', async () => {
    const service = buildService({
      getAccounts: jest.fn(async () => [
        { id: 'normal', name: 'Normal', isActive: true, status: 'active' },
        { id: 'error', name: 'Error', isActive: false, status: 'error' },
        { id: 'quota', name: 'Quota', status: 'quota_exceeded' },
        { id: 'limited', name: 'Limited', isRateLimited: true },
        { id: 'paused', name: 'Paused', schedulable: false }
      ]),
      getAllTempUnavailable: jest.fn(async () => ({})),
      sendNotification: jest.fn()
    })

    const summary = await service.getCurrentSummary()

    expect(summary.totalAccounts).toBe(5)
    expect(summary.statusCounts).toMatchObject({
      normal: 1,
      error: 1,
      quotaExpired: 1,
      rateLimited: 1,
      paused: 1
    })
    expect(summary.abnormalAccounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: 'error', status: '错误/认证异常' }),
        expect.objectContaining({ accountId: 'quota', status: '配额或过期' })
      ])
    )
  })

  it('sends the current vitality summary through webhook service', async () => {
    const sendNotification = jest.fn(async () => ({ succeeded: 1, failed: 0 }))
    const service = buildService({
      getAccounts: jest.fn(async () => [
        { id: 'normal', name: 'Normal', isActive: true, status: 'active' },
        { id: 'error', name: 'Error', isActive: false, status: 'error' }
      ]),
      getAllTempUnavailable: jest.fn(async () => ({})),
      sendNotification
    })

    const result = await service.sendCurrentSummary()

    expect(sendNotification).toHaveBeenCalledWith(
      'accountVitalitySummary',
      expect.objectContaining({
        totalAccounts: 2,
        statusCounts: expect.objectContaining({ normal: 1, error: 1 })
      })
    )
    expect(result.result).toEqual({ succeeded: 1, failed: 0 })
    expect(result.summary.totalAccounts).toBe(2)
  })
})
