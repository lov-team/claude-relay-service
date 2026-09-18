/**
 * Node.js TLS fingerprint agent for upstream Anthropic requests.
 *
 * Counterpart of sub2api internal/pkg/tlsfingerprint (utls): we cannot
 * do byte-level JA3/JA4 control without a utls-equivalent (CycleTLS /
 * tls-client sidecar), but we can align the configurable knobs of
 * Node's own TLS ClientHello with the values captured from a real
 * Claude Code CLI (Node.js 24.x):
 *
 *   JA3: 44f88fca027f27bab4bb08d4af15f23e
 *   JA4: t13d1714h1_5b57614c22b0_7baf387fc6ff
 *
 * - ciphers          -> TLS1.2 cipher list, Node 24 order
 * - sigalgs          -> the 9 signature algorithms from Node 24
 * - ecdhCurve        -> X25519:P-256:P-384 supported groups
 * - ALPNProtocols    -> http/1.1 only (real CLI does not offer h2)
 * - min/maxVersion   -> TLS1.2..TLS1.3
 *
 * TLS1.3 suites are offered by OpenSSL in its built-in order and are
 * not configurable from JS; the same applies to extension ordering.
 * This gets the JS-controllable surface to parity; a CycleTLS/tls-client
 * sidecar can replace it later for full extension-order parity.
 */

const https = require('https')

// TLS1.2 cipher list aligned with Node.js 24.x client offer order.
// TLS1.3 suites (0x1301/0x1302/0x1303) are implicit via OpenSSL.
const NODE24_CIPHERS = [
  // ECDHE + AES-GCM
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  // ECDHE + ChaCha20-Poly1305
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  // ECDHE + AES-CBC-SHA (legacy fallback)
  'ECDHE-ECDSA-AES128-SHA',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-ECDSA-AES256-SHA',
  'ECDHE-RSA-AES256-SHA',
  // RSA + AES-GCM (non-PFS)
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  // RSA + AES-CBC-SHA (non-PFS, legacy)
  'AES128-SHA',
  'AES256-SHA'
].join(':')

// The 9 signature algorithms offered by Node.js 24.x.
const NODE24_SIGALGS = [
  'ecdsa_secp256r1_sha256',
  'rsa_pss_rsae_sha256',
  'rsa_pkcs1_sha256',
  'ecdsa_secp384r1_sha384',
  'rsa_pss_rsae_sha384',
  'rsa_pkcs1_sha384',
  'rsa_pss_rsae_sha512',
  'rsa_pkcs1_sha512',
  'rsa_pkcs1_sha1'
].join(':')

// Supported groups offered by Node.js 24.x.
const NODE24_ECDH_CURVE = 'X25519:secp256r1:secp384r1'

/**
 * TLS options aligning Node's ClientHello with the Claude Code
 * (Node 24) fingerprint on every knob configurable from JS.
 */
function getClaudeTlsOptions() {
  return {
    ciphers: NODE24_CIPHERS,
    sigalgs: NODE24_SIGALGS,
    ecdhCurve: NODE24_ECDH_CURVE,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    // Real Claude Code negotiates http/1.1 with api.anthropic.com.
    ALPNProtocols: ['http/1.1']
  }
}

/**
 * Merge Claude-mimicking TLS options into an https.Agent option bag.
 */
function withClaudeTlsOptions(agentOptions = {}) {
  return { ...getClaudeTlsOptions(), ...agentOptions }
}

/**
 * Create an https.Agent with the Claude Code TLS profile.
 */
function createClaudeTlsAgent(agentOptions = {}) {
  return new https.Agent(withClaudeTlsOptions(agentOptions))
}

module.exports = {
  getClaudeTlsOptions,
  withClaudeTlsOptions,
  createClaudeTlsAgent
}
