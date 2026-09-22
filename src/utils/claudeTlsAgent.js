/**
 * Claude CLI TLS ClientHello.
 *
 * Captured from Claude CLI 2.x (Node.js + OpenSSL 3) and mirrored with
 * tls-impersonate so cipher order, extension order, groups, signature
 * algorithms and ALPN match. Node's ciphers/sigalgs/ecdhCurve knobs cannot
 * do that: they leave OpenSSL's own extension order in place.
 *
 * The six AES-CCM8 suites in the capture are implemented by Node's OpenSSL.
 * tls-impersonate 0.2.0 omits their names; scripts/patch-tls-impersonate-ccm8.js
 * adds them so they are advertised in order. Node 24.15 advertises
 * ec_point_formats [0, 1, 2]; newer OpenSSL builds only advertise [0].
 * The production image is pinned to Node 24.15 so the point-format list
 * matches the capture.
 */

const https = require('https')
const tls = require('tls')
const logger = require('./logger')

let impersonate = null
let isSupported = () => false
try {
  ;({ impersonate, isSupported } = require('tls-impersonate'))
} catch (error) {
  impersonate = null
  isSupported = () => false
}

// TLS 1.3 suites first, then the TLS 1.2 suites from the capture, then SCSV.
const CLAUDE_CIPHER_SUITES = [
  0x1302, 0x1303, 0x1301, 0xc02f, 0xc02b, 0xc030, 0xc02c, 0x009e, 0xc027, 0x0067, 0xc028, 0x006b,
  0x00a3, 0x009f, 0xcca9, 0xcca8, 0xccaa, 0xc0af, 0xc0ad, 0xc0a3, 0xc09f, 0xc05d, 0xc061, 0xc057,
  0xc053, 0x00a2, 0xc0ae, 0xc0ac, 0xc0a2, 0xc09e, 0xc05c, 0xc060, 0xc056, 0xc052, 0xc024, 0x006a,
  0xc023, 0x0040, 0xc00a, 0xc014, 0x0039, 0x0038, 0xc009, 0xc013, 0x0033, 0x0032, 0x009d, 0xc0a1,
  0xc09d, 0xc051, 0x009c, 0xc0a0, 0xc09c, 0xc050, 0x003d, 0x003c, 0x0035, 0x002f, 0x00ff
]

const CLAUDE_GROUPS = [
  0x001d, 0x0017, 0x001e, 0x0019, 0x0018, 0x0100, 0x0101, 0x0102, 0x0103, 0x0104
]

const CLAUDE_SIGNATURE_ALGORITHMS = [
  0x0403, 0x0503, 0x0603, 0x0807, 0x0808, 0x0809, 0x080a, 0x080b, 0x0804, 0x0805, 0x0806, 0x0401,
  0x0501, 0x0601, 0x0303, 0x0301, 0x0302, 0x0402, 0x0502, 0x0602
]

// Wire order from the capture. OpenSSL fills the bodies; the order is the fingerprint.
const CLAUDE_EXTENSIONS = [
  { type: 0x0000 },
  { type: 0x000b },
  { type: 0x000a },
  { type: 0x0023 },
  { type: 0x0010 },
  { type: 0x0016, data: Buffer.alloc(0) },
  { type: 0x0017 },
  { type: 0x000d },
  { type: 0x002b },
  { type: 0x002d },
  { type: 0x0033 }
]

const CLAUDE_CLIENT_HELLO = {
  cipherSuites: CLAUDE_CIPHER_SUITES,
  extensions: CLAUDE_EXTENSIONS,
  supportedGroups: CLAUDE_GROUPS,
  signatureAlgorithms: CLAUDE_SIGNATURE_ALGORITHMS,
  supportedVersions: [0x0304, 0x0303],
  ecPointFormats: [0, 1, 2],
  alpnProtocols: ['http/1.1'],
  legacyVersion: 0x0303
}

let cachedTlsOptions = null
let loggedProfile = false

function logProfileOnce(unsupported) {
  if (loggedProfile) {
    return
  }
  loggedProfile = true
  if (!unsupported.length) {
    logger.info('Claude TLS ClientHello profile applied')
    return
  }
  logger.warn(
    `Claude TLS ClientHello profile applied with gaps: ${unsupported
      .map((item) => `${item.kind}:${item.id}`)
      .join(', ')}`
  )
}

function getClaudeTlsOptions() {
  if (cachedTlsOptions) {
    return cachedTlsOptions
  }

  if (!impersonate || !isSupported()) {
    cachedTlsOptions = { ALPNProtocols: ['http/1.1'] }
    logger.warn('Claude TLS impersonation unavailable on this Node runtime')
    return cachedTlsOptions
  }

  // insecure is required to advertise the legacy suites and SCSV from the
  // capture. tls-impersonate still disables TLS 1.0/1.1 negotiation.
  const { tlsOptions, unsupported } = impersonate(CLAUDE_CLIENT_HELLO, { security: 'insecure' })
  cachedTlsOptions = tlsOptions
  logProfileOnce(unsupported)
  return cachedTlsOptions
}

function createClaudeHttpsAgent(agentOptions = {}) {
  const tlsOptions = getClaudeTlsOptions()

  class ClaudeHttpsAgent extends https.Agent {
    createConnection(options, callback) {
      return tls.connect({ ...options, ...tlsOptions }, callback)
    }
  }

  return new ClaudeHttpsAgent(agentOptions)
}

function applyClaudeTlsToAgent(agent) {
  if (!agent || typeof agent.connect !== 'function' || agent.__claudeTlsApplied) {
    return agent
  }
  const { connect } = agent
  agent.connect = function connectWithClaudeTls(req, opts) {
    return connect.call(this, req, { ...opts, ...getClaudeTlsOptions() })
  }
  agent.__claudeTlsApplied = true
  return agent
}

module.exports = {
  CLAUDE_CLIENT_HELLO,
  applyClaudeTlsToAgent,
  createClaudeHttpsAgent,
  getClaudeTlsOptions
}
