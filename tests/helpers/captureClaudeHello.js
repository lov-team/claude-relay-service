const https = require('https')
const net = require('net')

function unsupported(reason) {
  process.stdout.write(`${JSON.stringify({ supported: false, reason })}\n`)
  process.exit(0)
}

let isSupported
let readTlsClientHello
let calculateJa3
let calculateJa4
let createClaudeHttpsAgent
let applyClaudeTlsToAgent
let getClaudeTlsOptions
let CLAUDE_CLIENT_HELLO

try {
  ;({ isSupported } = require('tls-impersonate'))
  ;({ readTlsClientHello, calculateJa3, calculateJa4 } = require('read-tls-client-hello'))
  ;({
    createClaudeHttpsAgent,
    applyClaudeTlsToAgent,
    getClaudeTlsOptions,
    CLAUDE_CLIENT_HELLO
  } = require('../../src/utils/claudeTlsAgent'))
} catch (error) {
  unsupported(error.message)
}

if (!isSupported()) {
  unsupported('runtime cannot load the glibc TLS impersonation prebuild')
}

const tlsOptions = getClaudeTlsOptions()
const proxyAgent = applyClaudeTlsToAgent({
  connect(_req, opts) {
    return opts
  }
})
const injected = proxyAgent.connect({}, { servername: 'api.anthropic.com' })

const server = net.createServer(async (socket) => {
  try {
    const hello = await readTlsClientHello(socket)
    const alpn = hello.extensions.find((item) => item.id === 16)
    const points = hello.extensions.find((item) => item.id === 11)
    const groups = hello.extensions.find((item) => item.id === 10)
    const signatures = hello.extensions.find((item) => item.id === 13)
    process.stdout.write(
      `${JSON.stringify({
        supported: true,
        ja3: calculateJa3(hello),
        ja4: calculateJa4(hello),
        ciphersMatchSpec:
          JSON.stringify(hello.cipherSuites) === JSON.stringify(CLAUDE_CLIENT_HELLO.cipherSuites),
        extensions: hello.extensions.map((item) => item.id),
        ciphers: hello.cipherSuites,
        alpn: alpn && alpn.data ? alpn.data.protocols : null,
        points: points && points.data ? points.data.formats : null,
        groups: groups && groups.data ? groups.data.groups : null,
        signatureCount:
          signatures && signatures.data && signatures.data.algorithms
            ? signatures.data.algorithms.length
            : null,
        proxyInjected: Boolean(injected.secureContext),
        hasSecureContext: Boolean(tlsOptions.secureContext)
      })}\n`
    )
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exitCode = 1
  } finally {
    socket.end()
    server.close()
  }
})

server.listen(0, '127.0.0.1', () => {
  const req = https.request(
    {
      hostname: '127.0.0.1',
      port: server.address().port,
      path: '/',
      method: 'POST',
      rejectUnauthorized: false,
      servername: 'api.anthropic.com',
      agent: createClaudeHttpsAgent({ keepAlive: false })
    },
    () => {}
  )
  req.on('error', () => {})
  req.end('{}')
})
