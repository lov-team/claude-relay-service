/**
 * Claude 上游出站请求调试日志
 *
 * 排查封号/指纹检测时，需要看清实际发给上游的 headers + body。
 * 通过环境变量 CLAUDE_UPSTREAM_LOG=true 开启，默认关闭。
 * 输出到 logs/claude-upstream-YYYY-MM-DD.log（JSON 行）。
 *
 * 安全约束：
 * - authorization / x-api-key / cookie / proxy-authorization 值做脱敏；
 * - 但 x-stainless-*、x-app、x-client-request-id、x-claude-code-session-id、
 *   anthropic-beta、User-Agent 等指纹相关头保持原样，便于指纹比对；
 * - body 按原文记录（这是排查报文的目的），调用方负责只在需要时开启。
 */

const fs = require('fs')
const path = require('path')
const { maskToken } = require('./tokenMask')

const LOG_DIR = path.join(__dirname, '../../logs')
const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'proxy-authorization',
  'x-cr-api-key'
])
const MAX_BODY_BYTES = 512 * 1024 // 512KB，超大 body 截断，避免单条日志爆盘

function isEnabled() {
  const raw = process.env.CLAUDE_UPSTREAM_LOG
  return raw === '1' || raw === 'true' || raw === 'yes'
}

function sanitizeHeaders(headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers || {})) {
    if (SENSITIVE_HEADER_KEYS.has(key.toLowerCase())) {
      out[key] = `[MASKED:${maskToken(String(value), 20)}]`
    } else {
      out[key] = value
    }
  }
  return out
}

function normalizeBody(body) {
  if (body === undefined || body === null) {
    return null
  }
  let text
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    text = body.toString('utf8')
  } else {
    try {
      text = JSON.stringify(body)
    } catch {
      text = '[unserializable]'
    }
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    text = `${text.slice(0, MAX_BODY_BYTES)}...[TRUNCATED]`
  }
  return text
}

/**
 * 记录一条上游出站请求
 * @param {object} entry
 * @param {string} entry.channel - 'claude-official' | 'claude-console' | 'ccr'
 * @param {string} entry.accountId
 * @param {string} entry.accountName
 * @param {string} entry.url - 完整上游 URL
 * @param {string} entry.method
 * @param {object} entry.headers - 出站 headers（脱敏后记录）
 * @param {*} entry.body - 出站 body（字符串或对象）
 * @param {boolean} entry.stream - 是否流式
 * @param {object} [entry.extra] - 其他上下文（model、isRealClaudeCode 等）
 */
function logUpstreamRequest(entry) {
  if (!isEnabled()) {
    return
  }
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      channel: entry.channel,
      accountId: entry.accountId || null,
      accountName: entry.accountName || null,
      method: entry.method || 'POST',
      url: entry.url || null,
      stream: entry.stream === true,
      headers: sanitizeHeaders(entry.headers),
      body: normalizeBody(entry.body),
      extra: entry.extra || null
    })
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true })
    }
    const file = path.join(LOG_DIR, `claude-upstream-${new Date().toISOString().slice(0, 10)}.log`)
    fs.appendFileSync(file, `${line}\n`)
  } catch (error) {
    // 调试日志绝不能影响请求
    try {
      require('./logger').warn(`upstreamRequestLogger failed: ${error.message}`)
    } catch {
      /* ignore */
    }
  }
}

module.exports = { logUpstreamRequest, isEnabled }
