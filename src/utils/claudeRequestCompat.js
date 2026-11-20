const CLAUDE_CODE_COMPACT_PREAMBLE = 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n'
const OPENCODE_SYSTEM_SENTENCE = 'You are OpenCode, the best coding agent on the planet.'
const CLAUDE_CODE_SYSTEM_SENTENCE = "You are Claude Code, Anthropic's official CLI for Claude."

const REGION_PREFIXES = ['us.', 'eu.', 'apac.', 'jp.', 'au.', 'us-gov.', 'global.']

const TEMPERATURE_REJECTING_FAMILIES = [
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5-5',
  'claude-fable-5-2',
  'claude-mythos-5-2'
]

const SIGNED_THINKING_55_FAMILIES = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-2',
  'claude-mythos-5-2'
]

function normalizeClaudeModelId(model) {
  if (typeof model !== 'string') {
    return ''
  }
  let id = model.trim().toLowerCase()
  if (id.startsWith('models/')) {
    id = id.slice('models/'.length)
  }
  const slashIdx = id.indexOf('/')
  if (slashIdx >= 0) {
    id = id.slice(slashIdx + 1).trim()
    if (id.startsWith('models/')) {
      id = id.slice('models/'.length)
    }
  }
  for (const prefix of REGION_PREFIXES) {
    if (id.startsWith(prefix)) {
      id = id.slice(prefix.length)
      break
    }
  }
  if (id.startsWith('anthropic.')) {
    id = id.slice('anthropic.'.length)
  }
  if (id.endsWith('-thinking')) {
    id = id.slice(0, -'-thinking'.length)
  }
  if (id === 'claude-opus-5.5') {
    return 'claude-opus-5-5'
  }
  if (id === 'claude-sonnet-5.5') {
    return 'claude-sonnet-5-5'
  }
  if (id === 'claude-haiku-5.5') {
    return 'claude-haiku-5-5'
  }
  return id
}

function matchesModelFamily(normalizedId, family) {
  return normalizedId === family || normalizedId.startsWith(`${family}-`)
}

function rejectsTemperature(model) {
  const id = normalizeClaudeModelId(model)
  if (!id) {
    return false
  }
  return TEMPERATURE_REJECTING_FAMILIES.some((family) => matchesModelFamily(id, family))
}

function isClaude55SignedThinkingModel(model) {
  const id = normalizeClaudeModelId(model)
  if (!id) {
    return false
  }
  return SIGNED_THINKING_55_FAMILIES.some((family) => matchesModelFamily(id, family))
}

function isSonnet55Model(model) {
  const id = normalizeClaudeModelId(model)
  return Boolean(id && matchesModelFamily(id, 'claude-sonnet-5-5'))
}

function adaptClaude55Thinking(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    !isClaude55SignedThinkingModel(body.model) ||
    !body.thinking ||
    typeof body.thinking !== 'object'
  ) {
    return body
  }

  if (body.thinking.type === 'enabled') {
    const nextThinking = { ...body.thinking, type: 'adaptive' }
    delete nextThinking.budget_tokens
    body.thinking = nextThinking
  } else if (body.thinking.type === 'disabled' && isSonnet55Model(body.model)) {
    body.thinking = { ...body.thinking, type: 'between_tools' }
  }

  return body
}

function sanitizeOpenCodeSystemPrompt(body) {
  if (!body || typeof body !== 'object' || body.system === undefined) {
    return body
  }

  if (typeof body.system === 'string') {
    if (body.system.includes(OPENCODE_SYSTEM_SENTENCE)) {
      body.system = body.system.split(OPENCODE_SYSTEM_SENTENCE).join(CLAUDE_CODE_SYSTEM_SENTENCE)
    }
    return body
  }

  if (Array.isArray(body.system)) {
    body.system.forEach((item) => {
      if (
        item &&
        item.type === 'text' &&
        typeof item.text === 'string' &&
        item.text.includes(OPENCODE_SYSTEM_SENTENCE)
      ) {
        item.text = item.text.split(OPENCODE_SYSTEM_SENTENCE).join(CLAUDE_CODE_SYSTEM_SENTENCE)
      }
    })
  }

  return body
}

function isClaudeCodeCompactionRequest(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return false
  }

  let lastUserMsg = null
  for (let i = body.messages.length - 1; i >= 0; i -= 1) {
    const msg = body.messages[i]
    if (msg && msg.role === 'user') {
      lastUserMsg = msg
      break
    }
  }

  if (!lastUserMsg) {
    return false
  }

  if (typeof lastUserMsg.content === 'string') {
    return lastUserMsg.content.startsWith(CLAUDE_CODE_COMPACT_PREAMBLE)
  }

  if (Array.isArray(lastUserMsg.content)) {
    return lastUserMsg.content.some(
      (block) =>
        block &&
        block.type === 'text' &&
        typeof block.text === 'string' &&
        block.text.startsWith(CLAUDE_CODE_COMPACT_PREAMBLE)
    )
  }

  return false
}

module.exports = {
  CLAUDE_CODE_COMPACT_PREAMBLE,
  OPENCODE_SYSTEM_SENTENCE,
  CLAUDE_CODE_SYSTEM_SENTENCE,
  normalizeClaudeModelId,
  rejectsTemperature,
  isClaude55SignedThinkingModel,
  isSonnet55Model,
  adaptClaude55Thinking,
  sanitizeOpenCodeSystemPrompt,
  isClaudeCodeCompactionRequest
}
