const redis = require('../models/redis')
const logger = require('../utils/logger')
const {
  cloneDefaultConfig,
  normalizeAccountNurtureConfig
} = require('../utils/accountNurtureDefaults')

const CONFIG_KEY = 'account_nurture_config'

let configCache = null
let configCacheTime = 0
const CONFIG_CACHE_TTL = 60000

class AccountNurtureConfigService {
  getFileDefaults() {
    try {
      const config = require('../../config/config')
      if (config.accountNurture) {
        return normalizeAccountNurtureConfig({
          ...cloneDefaultConfig(),
          ...config.accountNurture
        })
      }
    } catch (error) {
      logger.debug(`accountNurture config fallback to built-in defaults: ${error.message}`)
    }
    return cloneDefaultConfig()
  }

  async getConfig() {
    try {
      if (configCache && Date.now() - configCacheTime < CONFIG_CACHE_TTL) {
        return configCache
      }

      const client = redis.getClient()
      if (!client) {
        return this.getFileDefaults()
      }

      const data = await client.get(CONFIG_KEY)
      if (data) {
        configCache = normalizeAccountNurtureConfig({
          ...this.getFileDefaults(),
          ...JSON.parse(data)
        })
      } else {
        configCache = this.getFileDefaults()
      }

      configCacheTime = Date.now()
      return configCache
    } catch (error) {
      logger.error('Failed to get account nurture config:', error)
      return this.getFileDefaults()
    }
  }

  clearCache() {
    configCache = null
    configCacheTime = 0
  }

  async updateConfig(newConfig, updatedBy = 'unknown') {
    const currentConfig = await this.getConfig()
    const normalized = normalizeAccountNurtureConfig({
      ...currentConfig,
      ...newConfig,
      updatedAt: new Date().toISOString(),
      updatedBy
    })

    const client = redis.getClientSafe()
    await client.set(CONFIG_KEY, JSON.stringify(normalized))

    configCache = normalized
    configCacheTime = Date.now()

    logger.info(`Account nurture config updated by ${updatedBy}`)
    return normalized
  }

  async resetToDefaults(updatedBy = 'unknown') {
    const defaults = this.getFileDefaults()
    return this.updateConfig(defaults, updatedBy)
  }
}

module.exports = new AccountNurtureConfigService()
