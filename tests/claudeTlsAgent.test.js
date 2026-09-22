const { spawnSync } = require('child_process')
const path = require('path')

const EXPECTED_JA3 = '1a28e69016765d92e3b381168d68922c'
const EXPECTED_JA4 = 't13d5911h1_a33745022dd6_1f22a2ca17c4'
const EXPECTED_EXTENSIONS = [0, 11, 10, 35, 16, 22, 23, 13, 43, 45, 51]
const EXPECTED_GROUPS = [29, 23, 30, 25, 24, 256, 257, 258, 259, 260]

function readCapture() {
  const capture = spawnSync(
    process.execPath,
    [path.join(__dirname, 'helpers/captureClaudeHello.js')],
    { encoding: 'utf8' }
  )
  const line = String(capture.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .pop()
  let hello = { supported: false, reason: 'no capture output' }
  try {
    hello = JSON.parse(line)
  } catch (error) {
    hello = { supported: false, reason: error.message }
  }
  return { capture, hello }
}

describe('Claude TLS client hello', () => {
  const { capture, hello } = readCapture()

  test('loads the captured Claude CLI profile when the runtime supports it', () => {
    if (!hello.supported) {
      expect(capture.status).toBe(0)
      expect(hello.reason).toEqual(expect.any(String))
      return
    }
    expect(capture.status).toBe(0)
    expect(hello.ja4).toBe(EXPECTED_JA4)
    expect(hello.ciphersMatchSpec).toBe(true)
    expect(hello.extensions).toEqual(EXPECTED_EXTENSIONS)
    expect(hello.alpn).toEqual(['http/1.1'])
    expect(hello.groups).toEqual(EXPECTED_GROUPS)
    expect(hello.signatureCount).toBe(20)
    expect(hello.ciphers).toHaveLength(59)
    expect(hello.ciphers.slice(0, 3)).toEqual([0x1302, 0x1303, 0x1301])
    expect(hello.ciphers[hello.ciphers.length - 1]).toBe(0x00ff)
    expect(hello.hasSecureContext).toBe(true)
    expect(hello.proxyInjected).toBe(true)
    if (process.version.startsWith('v24.')) {
      expect(hello.points).toEqual([0, 1, 2])
      expect(hello.ja3).toBe(EXPECTED_JA3)
    }
  })
})
