const MAX_PLAUSIBLE_RESET_DELAY_MS = (7 * 24 * 60 + 6 * 60) * 60 * 1000

function getHeaderCaseInsensitive(headers, name) {
  if (!headers || typeof headers !== 'object') {
    return undefined
  }
  if (headers[name] !== undefined) {
    return headers[name]
  }
  const lower = name.toLowerCase()
  if (headers[lower] !== undefined) {
    return headers[lower]
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return headers[key]
    }
  }
  return undefined
}

function parseRatio(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return null
  }
  const value = Number.parseFloat(String(raw).trim())
  if (!Number.isFinite(value) || value < 0) {
    return null
  }
  return value
}

function parseEpochSeconds(raw, nowMs) {
  if (raw === undefined || raw === null || raw === '') {
    return null
  }
  const text = String(raw).trim()
  let epochSec = null
  if (/^\d+$/.test(text)) {
    const parsed = Number.parseInt(text, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      epochSec = parsed > 1e11 ? Math.floor(parsed / 1000) : parsed
    }
  } else {
    const ms = Date.parse(text)
    if (Number.isFinite(ms) && ms > 0) {
      epochSec = Math.floor(ms / 1000)
    }
  }

  if (!epochSec || epochSec <= 0) {
    return null
  }

  if (epochSec * 1000 - nowMs > MAX_PLAUSIBLE_RESET_DELAY_MS) {
    return null
  }

  return epochSec
}

function parseWindow(headers, key, nowMs) {
  const rawStatus = getHeaderCaseInsensitive(headers, `anthropic-ratelimit-unified-${key}-status`)
  const status = rawStatus ? String(rawStatus).trim().toLowerCase() || null : null
  const ratio = parseRatio(
    getHeaderCaseInsensitive(headers, `anthropic-ratelimit-unified-${key}-utilization`)
  )
  const utilization = ratio !== null ? Math.round(ratio * 10000) / 100 : null
  const resetEpochSec = parseEpochSeconds(
    getHeaderCaseInsensitive(headers, `anthropic-ratelimit-unified-${key}-reset`),
    nowMs
  )
  const resetsAt = resetEpochSec ? new Date(resetEpochSec * 1000).toISOString() : null

  if (status === null && utilization === null && resetsAt === null) {
    return null
  }

  return {
    status,
    ratio,
    utilization,
    resetEpochSec,
    resetsAt
  }
}

function hasWindowData(window) {
  return Boolean(window && (window.utilization !== null || window.resetsAt !== null))
}

function parseClaudePassiveUsageHeaders(headers, nowMs = Date.now()) {
  if (!headers || typeof headers !== 'object') {
    return {
      hasAny: false,
      fiveHour: null,
      sevenDay: null,
      sevenDayFable: null
    }
  }

  const fiveHour = parseWindow(headers, '5h', nowMs)
  const sevenDay = parseWindow(headers, '7d', nowMs)
  const sevenDayFable = parseWindow(headers, '7d_oi', nowMs)

  return {
    hasAny: hasWindowData(fiveHour) || hasWindowData(sevenDay) || hasWindowData(sevenDayFable),
    fiveHour,
    sevenDay,
    sevenDayFable
  }
}

module.exports = {
  MAX_PLAUSIBLE_RESET_DELAY_MS,
  parseClaudePassiveUsageHeaders
}
