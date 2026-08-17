const redis = require('../models/redis')
const logger = require('../utils/logger')
const requestIdentityService = require('./requestIdentityService')

const USER_AGENT_POOL_KEY = 'claude:user_agent_pool'
const USER_AGENT_POOL_METADATA_KEY = 'claude:user_agent_pool:metadata'
const MAX_POOL_SIZE = 200
const MAX_USER_AGENT_LENGTH = 1024
const DEFAULT_CLAUDE_USER_AGENT = 'claude-cli/2.1.228 (external, cli)'
const DEFAULT_CONSOLE_USER_AGENT = 'claude-cli/1.0.69 (external, cli)'

class UserAgentPoolService {
  normalizeUserAgent(userAgent) {
    if (typeof userAgent !== 'string') {
      return ''
    }
    return userAgent.trim().slice(0, MAX_USER_AGENT_LENGTH)
  }

  detectPlatform(userAgent, headersOrFingerprint = null) {
    const fingerprint = requestIdentityService.extractStainlessFingerprint(headersOrFingerprint)
    const stainlessOs = String(fingerprint['x-stainless-os'] || '').toLowerCase()
    if (/windows|win32|win64/.test(stainlessOs)) {
      return 'windows'
    }
    if (/mac|darwin|osx/.test(stainlessOs)) {
      return 'mac'
    }
    if (/linux|ubuntu|debian|fedora|centos/.test(stainlessOs)) {
      return 'linux'
    }

    const normalized = this.normalizeUserAgent(userAgent).toLowerCase()
    if (!normalized) {
      return 'unknown'
    }
    if (/windows|win32|win64|windows nt/.test(normalized)) {
      return 'windows'
    }
    if (/macintosh|mac os x|macos|darwin/.test(normalized)) {
      return 'mac'
    }
    if (/linux|x11|ubuntu|debian|fedora|centos/.test(normalized)) {
      return 'linux'
    }
    return 'unknown'
  }

  isClaudeCodeUserAgent(userAgent) {
    const normalized = this.normalizeUserAgent(userAgent)
    return /^claude-cli\/[\w.-]+\s+\([^\r\n]+\)$/i.test(normalized)
  }

  async recordUserAgent(userAgent, clientHeaders = null) {
    const normalized = this.normalizeUserAgent(userAgent)
    // UA 池只接受真实 Claude Code 格式，避免浏览器、curl 或网关 UA
    // 成为新账号的固定上游身份。
    if (!this.isClaudeCodeUserAgent(normalized)) {
      return null
    }

    const stainlessFingerprint = requestIdentityService.extractStainlessFingerprint(clientHeaders)
    const platform = this.detectPlatform(normalized, stainlessFingerprint)
    const captured = {
      userAgent: normalized,
      platform,
      stainlessFingerprint,
      detectionSource:
        stainlessFingerprint['x-stainless-os'] !== undefined ? 'stainless_headers' : 'user_agent',
      lastSeenAt: Date.now()
    }

    try {
      const client = redis.getClientSafe()
      const pipeline = client.pipeline()
      pipeline.zadd(USER_AGENT_POOL_KEY, captured.lastSeenAt, normalized)
      pipeline.hset(USER_AGENT_POOL_METADATA_KEY, normalized, JSON.stringify(captured))
      pipeline.zremrangebyrank(USER_AGENT_POOL_KEY, 0, -(MAX_POOL_SIZE + 1))
      await pipeline.exec()
      return captured
    } catch (error) {
      logger.warn(`⚠️ Failed to record upstream User-Agent: ${error.message}`)
      return captured
    }
  }

  async getLatestUserAgent() {
    try {
      const client = redis.getClientSafe()
      const entries = await client.zrevrange(USER_AGENT_POOL_KEY, 0, 0, 'WITHSCORES')
      if (!entries || entries.length === 0) {
        return null
      }

      const userAgent = this.normalizeUserAgent(entries[0])
      if (!userAgent) {
        return null
      }

      const metadataRaw = await client.hget(USER_AGENT_POOL_METADATA_KEY, userAgent)
      const metadata = this._parseMetadata(metadataRaw)
      return {
        userAgent,
        platform: metadata?.platform || this.detectPlatform(userAgent),
        stainlessFingerprint: metadata?.stainlessFingerprint || {},
        detectionSource: metadata?.detectionSource || 'user_agent',
        lastSeenAt: Number(entries[1]) || metadata?.lastSeenAt || null
      }
    } catch (error) {
      logger.warn(`⚠️ Failed to read latest User-Agent from pool: ${error.message}`)
      return null
    }
  }

  async listRecentUserAgents(limit = 50) {
    const normalizedLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200)
    try {
      const client = redis.getClientSafe()
      const entries = await client.zrevrange(
        USER_AGENT_POOL_KEY,
        0,
        normalizedLimit - 1,
        'WITHSCORES'
      )
      const items = []
      const observations = []
      for (let index = 0; index < entries.length; index += 2) {
        const userAgent = this.normalizeUserAgent(entries[index])
        if (!userAgent) {
          continue
        }
        observations.push({ userAgent, lastSeenAt: Number(entries[index + 1]) || null })
      }
      const metadataList =
        observations.length > 0
          ? await client.hmget(
              USER_AGENT_POOL_METADATA_KEY,
              ...observations.map((item) => item.userAgent)
            )
          : []
      for (let index = 0; index < observations.length; index += 1) {
        const observation = observations[index]
        const metadata = this._parseMetadata(metadataList[index])
        items.push({
          userAgent: observation.userAgent,
          platform: metadata?.platform || this.detectPlatform(observation.userAgent),
          stainlessFingerprint: metadata?.stainlessFingerprint || {},
          detectionSource: metadata?.detectionSource || 'user_agent',
          lastSeenAt: observation.lastSeenAt || metadata?.lastSeenAt || null
        })
      }
      return items
    } catch (error) {
      logger.warn(`⚠️ Failed to list User-Agent pool: ${error.message}`)
      return []
    }
  }

  async assignLatestUserAgent(fallbackUserAgent) {
    const latest = await this.getLatestUserAgent()
    if (latest) {
      return latest
    }

    const userAgent = this.normalizeUserAgent(fallbackUserAgent)
    return {
      userAgent,
      platform: this.detectPlatform(userAgent),
      stainlessFingerprint: {},
      detectionSource: 'fallback_default',
      lastSeenAt: null
    }
  }

  _parseMetadata(raw) {
    if (typeof raw !== 'string' || !raw) {
      return null
    }
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch (error) {
      return null
    }
  }
}

module.exports = new UserAgentPoolService()
module.exports.USER_AGENT_POOL_KEY = USER_AGENT_POOL_KEY
module.exports.USER_AGENT_POOL_METADATA_KEY = USER_AGENT_POOL_METADATA_KEY
module.exports.DEFAULT_CLAUDE_USER_AGENT = DEFAULT_CLAUDE_USER_AGENT
module.exports.DEFAULT_CONSOLE_USER_AGENT = DEFAULT_CONSOLE_USER_AGENT
