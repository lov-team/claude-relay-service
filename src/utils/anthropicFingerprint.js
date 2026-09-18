/**
 * Anthropic client fingerprint normalization.
 *
 * Ported from sub2api internal/pkg/anthropicfp/dateline.go:
 * some clients (Claude Code) embed steganographic bits inside the
 *   "Today's date is YYYY-MM-DD." / "Today's date is YYYY/MM/DD."
 * sentence when they detect a non-official base URL, using four
 * apostrophe code points and a "/" separator variant. Upstream
 * Anthropic can use this to detect third-party gateways. We rewrite
 * the sentence back to canonical ASCII form, erasing the signal.
 *
 * Scope mirrors where genuine clients place the sentence:
 *   - system string, or .text of each text-typed block in system[]
 *   - text bodies inside messages[].content[] but ONLY the substrings
 *     inside <system-reminder>...</system-reminder> tags. User prose,
 *     tool_use.input, tool_result.content are never scanned.
 */

// apostrophe code points: ASCII ' / U+2019 / U+02BC / U+02B9
// \3 backrefs the separator group so '-' and '/' cannot mix
// (e.g. "2026-07/01" never matches), mirroring the two-regex
// separator-agreement rule in the Go implementation.
const DATELINE_RE = /Today(['\u2019\u02bc\u02b9])s date is (\d{4})([-/])(\d{2})\3(\d{2})\./g
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function canonicalize(_match, _apo, year, _sep, month, day) {
  return `Today's date is ${year}-${month}-${day}.`
}

/**
 * Normalize every fingerprinted dateline sentence in a text.
 * @returns {{ text: string, hits: number }}
 */
function normalizeText(text) {
  if (typeof text !== 'string' || !text.includes('date is ')) {
    return { text, hits: 0 }
  }
  let hits = 0
  const next = text.replace(DATELINE_RE, (...args) => {
    const canonical = canonicalize(...args)
    if (canonical !== args[0]) {
      hits += 1
    }
    return canonical
  })
  return { text: next, hits }
}

/**
 * Normalize datelines inside <system-reminder> blocks only.
 * Text outside the blocks is preserved byte-for-byte.
 */
function normalizeSystemReminderScopedText(text) {
  if (typeof text !== 'string' || !text.includes('<system-reminder>')) {
    return { text, hits: 0 }
  }
  let hits = 0
  const next = text.replace(SYSTEM_REMINDER_RE, (block) => {
    const r = normalizeText(block)
    hits += r.hits
    return r.text
  })
  return { text: next, hits }
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') {
    const r = normalizeSystemReminderScopedText(content)
    return { content: r.text, hits: r.hits }
  }
  if (!Array.isArray(content)) {
    return { content, hits: 0 }
  }
  let hits = 0
  const next = content.map((block) => {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      const r = normalizeSystemReminderScopedText(block.text)
      hits += r.hits
      return r.hits > 0 ? { ...block, text: r.text } : block
    }
    return block
  })
  return { content: next, hits }
}

/**
 * Normalize dateline fingerprints in an Anthropic /v1/messages body.
 * Pure transform: never mutates the input; returns the original
 * reference when no rewrite is needed.
 * @returns {{ body: object, hits: number }}
 */
function normalizeDateline(body) {
  if (!body || typeof body !== 'object') {
    return { body, hits: 0 }
  }
  let hits = 0
  const out = { ...body }

  if (typeof out.system === 'string') {
    const r = normalizeText(out.system)
    hits += r.hits
    if (r.hits > 0) {
      out.system = r.text
    }
  } else if (Array.isArray(out.system)) {
    out.system = out.system.map((item) => {
      if (item && item.type === 'text' && typeof item.text === 'string') {
        const r = normalizeText(item.text)
        hits += r.hits
        return r.hits > 0 ? { ...item, text: r.text } : item
      }
      return item
    })
  }

  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((msg) => {
      if (!msg || typeof msg !== 'object' || msg.content === undefined) {
        return msg
      }
      const r = normalizeMessageContent(msg.content)
      hits += r.hits
      return r.hits > 0 ? { ...msg, content: r.content } : msg
    })
  }

  return { body: hits > 0 ? out : body, hits }
}

module.exports = { normalizeDateline, normalizeText }
