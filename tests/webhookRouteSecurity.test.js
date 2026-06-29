const express = require('express')
const request = require('supertest')

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => next()
}))

jest.mock('../src/services/webhookService', () => ({
  testWebhook: jest.fn(),
  sendNotification: jest.fn()
}))

jest.mock('../src/services/webhookConfigService', () => ({
  getConfig: jest.fn(),
  getSanitizedConfig: jest.fn(),
  saveConfig: jest.fn(),
  sanitizeConfig: jest.fn((config) => config),
  sanitizePlatform: jest.fn((platform) => platform),
  addPlatform: jest.fn(),
  updatePlatform: jest.fn(),
  deletePlatform: jest.fn(),
  togglePlatform: jest.fn(),
  restoreSensitivePlaceholders: jest.fn((value) => value)
}))

jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn()
}))

const webhookConfigService = require('../src/services/webhookConfigService')
const webhookRouter = require('../src/routes/webhook')

describe('webhook admin routes sanitize secrets', () => {
  const buildApp = () => {
    const app = express()
    app.use(express.json())
    app.use('/admin/webhook', webhookRouter)
    return app
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses sanitized config for GET /config', async () => {
    webhookConfigService.getSanitizedConfig.mockResolvedValue({
      platforms: [{ id: 'p1', appSecret: '********' }]
    })

    const response = await request(buildApp()).get('/admin/webhook/config')

    expect(response.status).toBe(200)
    expect(webhookConfigService.getSanitizedConfig).toHaveBeenCalled()
    expect(webhookConfigService.getConfig).not.toHaveBeenCalled()
    expect(response.body.config.platforms[0].appSecret).toBe('********')
  })
})
