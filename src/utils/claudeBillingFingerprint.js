/**
 * Claude Code billing attribution block helpers.
 *
 * Ported from sub2api internal/service/gateway_billing_block.go and
 * gateway_billing_header.go. Real Claude Code CLI injects a system
 * text block:
 *
 *   x-anthropic-billing-header: cc_version=X.Y.Z.{fp}; cc_entrypoint=cli;
 *
 * {fp} is a 3-hex fingerprint derived from the first user text and
 * the CLI version. The salt and char indices below are captured from
 * real CLI traffic (via Parrot cc_mimicry.py); changing them makes
 * the fp diverge from real clients and trips third-party detection.
 *
 * The live relay does not apply these helpers. A client-supplied
 * cc_version.{fp} pair is forwarded unchanged. Recomputing the suffix
 * with a salt that does not match Anthropic's check is itself a
 * third-party signal, and so is dropping the suffix while rewriting
 * the version.
 */

const crypto = require('crypto')

const FINGERPRINT_SALT = '59cf53e54c78'
const FINGERPRINT_CHAR_INDICES = [4, 7, 20]

const CC_VERSION_RE = /cc_version=\d+\.\d+\.\d+/
const CC_VERSION_FP_RE = /cc_version=\d+\.\d+\.\d+\.[0-9a-fA-F]{3}\b/
const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header'

/**
 * Extract the first user message's first text block.
 * Accepts string and block-array content shapes.
 */
function extractFirstUserText(body) {
  if (!body || !Array.isArray(body.messages)) {
    return ''
  }
  for (const msg of body.messages) {
    if (!msg || msg.role !== 'user') {
      continue
    }
    const { content } = msg
    if (typeof content === 'string') {
      return content
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          return block.text
        }
      }
      return ''
    }
    return ''
  }
  return ''
}

/**
 * Replicates the real CLI's cc_version fingerprint:
 *   chars  = firstUserText[4], [7], [20]  ('0' when missing)
 *   digest = sha256(SALT + chars + version) -> first 3 hex chars
 */
function computeClaudeCodeFingerprint(body, version) {
  const firstText = extractFirstUserText(body) || ''
  let chars = ''
  for (const i of FINGERPRINT_CHAR_INDICES) {
    chars += i < firstText.length ? firstText[i] : '0'
  }
  return crypto
    .createHash('sha256')
    .update(FINGERPRINT_SALT + chars + version)
    .digest('hex')
    .slice(0, 3)
}

/**
 * Build the billing attribution block text, matching real CLI shape.
 * New CLI versions no longer send a cch= signature field, so we do
 * not emit one either.
 */
function buildBillingAttributionText(body, cliVersion) {
  if (!cliVersion) {
    throw new Error('cliVersion required')
  }
  const fp = computeClaudeCodeFingerprint(body, cliVersion)
  return `x-anthropic-billing-header: cc_version=${cliVersion}.${fp}; cc_entrypoint=cli;`
}

/**
 * Rewrite cc_version inside existing billing attribution system
 * blocks to match cliVersion, recomputing the fingerprint suffix.
 * Only touches system[] blocks whose text starts with the billing
 * header prefix. Returns the (possibly new) body.
 */
function syncBillingHeaderVersion(body, cliVersion) {
  if (!body || !Array.isArray(body.system) || !cliVersion) {
    return body
  }
  const replacement = `cc_version=${cliVersion}`
  const fingerprinted = `${replacement}.${computeClaudeCodeFingerprint(body, cliVersion)}`
  let changed = false
  const system = body.system.map((item) => {
    if (
      item &&
      item.type === 'text' &&
      typeof item.text === 'string' &&
      item.text.startsWith(BILLING_HEADER_PREFIX)
    ) {
      // FP-suffixed and bare forms both get the fingerprinted form --
      // real CLI always carries cc_version=X.Y.Z.{fp}.
      const next = CC_VERSION_FP_RE.test(item.text)
        ? item.text.replace(CC_VERSION_FP_RE, fingerprinted)
        : item.text.replace(CC_VERSION_RE, fingerprinted)
      if (next !== item.text) {
        changed = true
        return { ...item, text: next }
      }
    }
    return item
  })
  return changed ? { ...body, system } : body
}

module.exports = {
  BILLING_HEADER_PREFIX,
  buildBillingAttributionText,
  computeClaudeCodeFingerprint,
  extractFirstUserText,
  syncBillingHeaderVersion
}
