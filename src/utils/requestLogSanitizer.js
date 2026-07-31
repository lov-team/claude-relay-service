const { maskTokensDeep } = require('./tokenMask')

const INFERENCE_ROUTE_PATTERN =
  /(?:\/v1\/messages|\/messages|\/responses|\/chat\/completions)(?:\?|$|\/)/i

function textLength(value) {
  if (typeof value === 'string') {
    return value.length
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + textLength(item), 0)
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((total, item) => total + textLength(item), 0)
  }
  return 0
}

function serializedLength(value) {
  try {
    return JSON.stringify(value).length
  } catch {
    return null
  }
}

function summarizeInferencePayload(payload) {
  return {
    _summary: 'inference_payload',
    model: payload?.model || null,
    stream: payload?.stream === true,
    maxTokens: payload?.max_tokens ?? payload?.max_output_tokens ?? null,
    messageCount: Array.isArray(payload?.messages) ? payload.messages.length : 0,
    inputCount: Array.isArray(payload?.input) ? payload.input.length : payload?.input ? 1 : 0,
    toolCount: Array.isArray(payload?.tools) ? payload.tools.length : 0,
    systemChars: textLength(payload?.system),
    contentChars: textLength(payload?.messages) + textLength(payload?.input),
    totalChars: serializedLength(payload)
  }
}

function summarizeLargePayload(payload, kind) {
  return {
    _summary: `${kind}_payload`,
    success: typeof payload?.success === 'boolean' ? payload.success : undefined,
    errorType: payload?.error?.type || payload?.error?.code || payload?.error || undefined,
    itemCount: Array.isArray(payload?.data) ? payload.data.length : undefined,
    totalChars: serializedLength(payload)
  }
}

function sanitizeRequestPayloadForLog(payload, route = '') {
  if (!payload || typeof payload !== 'object') {
    return payload
  }
  if (INFERENCE_ROUTE_PATTERN.test(route)) {
    return summarizeInferencePayload(payload)
  }
  const length = serializedLength(payload)
  return length !== null && length > 10000
    ? summarizeLargePayload(payload, 'request')
    : maskTokensDeep(payload)
}

function sanitizeResponsePayloadForLog(payload) {
  if (!payload || typeof payload !== 'object') {
    return payload
  }
  const length = serializedLength(payload)
  return length !== null && length > 10000
    ? summarizeLargePayload(payload, 'response')
    : maskTokensDeep(payload)
}

module.exports = {
  sanitizeRequestPayloadForLog,
  sanitizeResponsePayloadForLog,
  summarizeInferencePayload
}
