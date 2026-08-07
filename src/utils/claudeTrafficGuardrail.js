const DEFAULT_CLAUDE_TRAFFIC_GUARDRAILS = Object.freeze({
  enabled: false,
  maxBodyBytes: 1024 * 1024,
  maxMessages: 200,
  maxTools: 64,
  maxOutputTokens: 32768,
  retryAfterSeconds: 60
})

const normalizePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const normalizeClaudeTrafficGuardrails = (configuration = {}) => ({
  enabled: configuration.enabled === true || configuration.enabled === 'true',
  maxBodyBytes: normalizePositiveInteger(
    configuration.maxBodyBytes,
    DEFAULT_CLAUDE_TRAFFIC_GUARDRAILS.maxBodyBytes
  ),
  maxMessages: normalizePositiveInteger(
    configuration.maxMessages,
    DEFAULT_CLAUDE_TRAFFIC_GUARDRAILS.maxMessages
  ),
  maxTools: normalizePositiveInteger(
    configuration.maxTools,
    DEFAULT_CLAUDE_TRAFFIC_GUARDRAILS.maxTools
  ),
  maxOutputTokens: normalizePositiveInteger(
    configuration.maxOutputTokens,
    DEFAULT_CLAUDE_TRAFFIC_GUARDRAILS.maxOutputTokens
  ),
  retryAfterSeconds: normalizePositiveInteger(
    configuration.retryAfterSeconds,
    DEFAULT_CLAUDE_TRAFFIC_GUARDRAILS.retryAfterSeconds
  )
})

const evaluateClaudeTrafficGuardrail = (body, configuration = {}) => {
  const limits = normalizeClaudeTrafficGuardrails(configuration)
  const bodyString = JSON.stringify(body || {})
  const metrics = {
    bodyBytes: Buffer.byteLength(bodyString, 'utf8'),
    messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
    toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
    maxOutputTokens: Number.parseInt(body?.max_tokens, 10) || 0
  }
  const violations = []

  if (!limits.enabled) {
    return { allowed: true, limits, metrics, violations }
  }

  const checks = [
    ['request_body_bytes', metrics.bodyBytes, limits.maxBodyBytes],
    ['message_count', metrics.messageCount, limits.maxMessages],
    ['tool_count', metrics.toolCount, limits.maxTools],
    ['max_output_tokens', metrics.maxOutputTokens, limits.maxOutputTokens]
  ]

  for (const [code, actual, limit] of checks) {
    if (actual > limit) {
      violations.push({ code, actual, limit })
    }
  }

  return {
    allowed: violations.length === 0,
    limits,
    metrics,
    violations
  }
}

module.exports = {
  DEFAULT_CLAUDE_TRAFFIC_GUARDRAILS,
  normalizeClaudeTrafficGuardrails,
  evaluateClaudeTrafficGuardrail
}
