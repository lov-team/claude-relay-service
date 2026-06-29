const express = require('express')
const request = require('supertest')

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => next()
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/services/accountVitalityMonitorService', () => ({
  sendCurrentSummary: jest.fn()
}))

const accountVitalityMonitorService = require('../src/services/accountVitalityMonitorService')
const accountVitalityRouter = require('../src/routes/admin/accountVitality')

describe('POST /admin/account-vitality/notify', () => {
  const buildApp = () => {
    const app = express()
    app.use(express.json())
    app.use('/admin', accountVitalityRouter)
    return app
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns the summary when webhook sending succeeds', async () => {
    accountVitalityMonitorService.sendCurrentSummary.mockResolvedValue({
      summary: { totalAccounts: 2, statusCounts: { normal: 1, error: 1 } },
      result: { succeeded: 1, failed: 0 }
    })

    const response = await request(buildApp()).post('/admin/account-vitality/notify').send({})

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      success: true,
      message: '账号活力状态已发送到飞书',
      summary: { totalAccounts: 2, statusCounts: { normal: 1, error: 1 } },
      result: { succeeded: 1, failed: 0 }
    })
  })

  it('returns a clear error when webhook sending fails', async () => {
    accountVitalityMonitorService.sendCurrentSummary.mockRejectedValue(new Error('feishu failed'))

    const response = await request(buildApp()).post('/admin/account-vitality/notify').send({})

    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      success: false,
      error: 'Internal server error',
      message: '发送账号活力状态失败: feishu failed'
    })
  })
})
