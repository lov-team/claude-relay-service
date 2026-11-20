const axios = require('axios')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const config = require('../../config/config')
const userAgentPoolService = require('./userAgentPoolService')

const SYNC_REDIS_KEY = 'claude:code_version:synced'
const GITHUB_RELEASES_URL =
  'https://api.github.com/repos/anthropics/claude-code/releases?per_page=30'
const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10000

class ClaudeCodeVersionSyncService {
  constructor() {
    this.timer = null
    this.intervalMs = DEFAULT_SYNC_INTERVAL_MS
    this.running = false
  }

  _extractStableReleaseVersion(tagName) {
    if (typeof tagName !== 'string') {
      return null
    }
    const trimmed = tagName.trim()
    const match = trimmed.match(/^v?(\d+\.\d+\.\d+)$/)
    return match ? match[1] : null
  }

  _pickHighestStableVersion(releases) {
    if (!Array.isArray(releases)) {
      return null
    }
    let best = null
    for (const release of releases) {
      if (!release || release.draft || release.prerelease) {
        continue
      }
      const version = this._extractStableReleaseVersion(release.tag_name)
      if (!version) {
        continue
      }
      if (!best || userAgentPoolService.compareClaudeCodeVersions(version, best) > 0) {
        best = version
      }
    }
    return best
  }

  async _readStoredSyncState() {
    try {
      const client = redis.getClientSafe()
      const raw = await client.get(SYNC_REDIS_KEY)
      if (!raw) {
        return null
      }
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch (error) {
      logger.debug(`Failed to read synced Claude Code version state: ${error.message}`)
      return null
    }
  }

  async _writeStoredSyncState(version, nowMs = Date.now()) {
    try {
      const client = redis.getClientSafe()
      await client.set(
        SYNC_REDIS_KEY,
        JSON.stringify({ version, updatedAt: new Date(nowMs).toISOString() })
      )
    } catch (error) {
      logger.warn(`Failed to persist synced Claude Code version ${version}: ${error.message}`)
    }
  }

  async start(intervalMs = DEFAULT_SYNC_INTERVAL_MS) {
    if (config.claude?.autoSyncCodeVersion === false) {
      return
    }
    this.stop()
    this.intervalMs =
      Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_SYNC_INTERVAL_MS

    const stored = await this._readStoredSyncState()
    if (stored?.version) {
      userAgentPoolService.setSyncedClaudeCodeVersion(stored.version)
    }

    const updatedAtMs = stored?.updatedAt ? Date.parse(stored.updatedAt) : NaN
    const syncedRecently =
      stored?.version && Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs < this.intervalMs

    if (!syncedRecently) {
      this.runOnce().catch((error) => {
        logger.debug(`Initial Claude Code version sync failed: ${error.message}`)
      })
    }

    this.timer = setInterval(() => {
      this.runOnce().catch((error) => {
        logger.debug(`Scheduled Claude Code version sync failed: ${error.message}`)
      })
    }, this.intervalMs)
    if (typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async runOnce() {
    if (config.claude?.autoSyncCodeVersion === false || this.running) {
      return null
    }

    this.running = true
    try {
      const response = await axios.get(GITHUB_RELEASES_URL, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'claude-relay-service'
        }
      })

      const bestVersion = this._pickHighestStableVersion(response?.data)
      if (!bestVersion) {
        return null
      }

      const stored = await this._readStoredSyncState()
      const storedVersion =
        stored?.version && userAgentPoolService.isStrictThreePartSemver(stored.version)
          ? stored.version
          : null

      const baseline = userAgentPoolService.MIN_CLAUDE_CODE_VERSION
      if (userAgentPoolService.compareClaudeCodeVersions(bestVersion, baseline) < 0) {
        return null
      }

      if (
        storedVersion &&
        userAgentPoolService.compareClaudeCodeVersions(bestVersion, storedVersion) < 0
      ) {
        userAgentPoolService.setSyncedClaudeCodeVersion(storedVersion)
        return storedVersion
      }

      const accepted = userAgentPoolService.setSyncedClaudeCodeVersion(bestVersion)
      const effectiveVersion = accepted || bestVersion
      await this._writeStoredSyncState(effectiveVersion)
      logger.info(`🔄 Synced latest Claude Code CLI version: ${effectiveVersion}`)
      return effectiveVersion
    } catch (error) {
      logger.debug(`Failed to fetch Claude Code releases: ${error.message}`)
      return null
    } finally {
      this.running = false
    }
  }
}

module.exports = new ClaudeCodeVersionSyncService()
module.exports.SYNC_REDIS_KEY = SYNC_REDIS_KEY
module.exports.GITHUB_RELEASES_URL = GITHUB_RELEASES_URL
module.exports.DEFAULT_SYNC_INTERVAL_MS = DEFAULT_SYNC_INTERVAL_MS
