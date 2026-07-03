jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

describe('WebhookConfigService sensitive fields', () => {
  let storedConfig
  let webhookConfigService

  beforeEach(() => {
    jest.resetModules()
    storedConfig = null

    jest.doMock('../src/models/redis', () => ({
      client: {
        get: jest.fn(async () => storedConfig),
        set: jest.fn(async (_key, value) => {
          storedConfig = value
        })
      }
    }))

    webhookConfigService = require('../src/services/webhookConfigService')
  })

  afterEach(() => {
    jest.clearAllMocks()
    jest.dontMock('../src/models/redis')
  })

  const buildConfig = (appSecret = 'feishu-secret') => ({
    enabled: true,
    platforms: [
      {
        id: 'feishu-crs-cc',
        name: 'CRS-CC',
        type: 'feishu_app',
        enabled: true,
        appId: 'cli_test',
        appSecret,
        receiveId: 'oc_test',
        receiveIdType: 'chat_id'
      }
    ],
    notificationTypes: {
      accountAnomaly: true,
      accountVitalitySummary: true,
      test: true
    }
  })

  it('encrypts sensitive platform fields at rest and decrypts them for internal use', async () => {
    await webhookConfigService.saveConfig(buildConfig())

    const raw = JSON.parse(storedConfig)
    expect(raw.platforms[0].appSecret).not.toBe('feishu-secret')
    expect(raw.platforms[0].appSecret).toMatch(/^enc:v1:/)

    const internalConfig = await webhookConfigService.getConfig()
    expect(internalConfig.platforms[0].appSecret).toBe('feishu-secret')
  })

  it('returns sanitized config for admin API responses', async () => {
    await webhookConfigService.saveConfig(buildConfig())

    const publicConfig = await webhookConfigService.getSanitizedConfig()
    expect(publicConfig.platforms[0].appSecret).toBe(webhookConfigService.SECRET_PLACEHOLDER)
    expect(publicConfig.platforms[0].appSecretConfigured).toBe(true)
  })

  it('keeps legacy plaintext readable and encrypts it on the next save', async () => {
    storedConfig = JSON.stringify(buildConfig('legacy-secret'))

    const internalConfig = await webhookConfigService.getConfig()
    expect(internalConfig.platforms[0].appSecret).toBe('legacy-secret')

    await webhookConfigService.saveConfig(internalConfig)
    const raw = JSON.parse(storedConfig)
    expect(raw.platforms[0].appSecret).not.toBe('legacy-secret')
    expect(raw.platforms[0].appSecret).toMatch(/^enc:v1:/)
  })

  it('preserves existing secrets when sanitized placeholders are saved back', async () => {
    await webhookConfigService.saveConfig(buildConfig('original-secret'))
    const publicConfig = await webhookConfigService.getSanitizedConfig()

    publicConfig.platforms[0].name = 'Renamed'
    await webhookConfigService.saveConfig(publicConfig)

    const internalConfig = await webhookConfigService.getConfig()
    expect(internalConfig.platforms[0].name).toBe('Renamed')
    expect(internalConfig.platforms[0].appSecret).toBe('original-secret')
  })
})
