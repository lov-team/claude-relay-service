/**
 * tls-impersonate 0.2.0 knows AES-CCM but not the six CCM8 suites Claude CLI
 * advertises. OpenSSL in Node 24.15+ already implements them; only the IANA
 * id → name table is missing, so impersonate() drops them from ClientHello.
 */

const fs = require('fs')
const path = require('path')

const target = path.join(__dirname, '../node_modules/tls-impersonate/dist/index.js')

if (!fs.existsSync(target)) {
  process.exit(0)
}

const source = fs.readFileSync(target, 'utf8')
if (source.includes("0xc0af: 'ECDHE-ECDSA-AES256-CCM8'")) {
  process.exit(0)
}

const ecdheAnchor = "    0xc0ad: 'ECDHE-ECDSA-AES256-CCM',\n"
const dheAnchor = "    0xc09f: 'DHE-RSA-AES256-CCM',\n"

if (!source.includes(ecdheAnchor) || !source.includes(dheAnchor)) {
  throw new Error('tls-impersonate cipher table changed; CCM8 patch no longer applies')
}

const patched = source
  .replace(
    ecdheAnchor,
    `${ecdheAnchor}    0xc0ae: 'ECDHE-ECDSA-AES128-CCM8',\n    0xc0af: 'ECDHE-ECDSA-AES256-CCM8',\n`
  )
  .replace(
    dheAnchor,
    `${dheAnchor}    0xc0a2: 'DHE-RSA-AES128-CCM8',\n    0xc0a3: 'DHE-RSA-AES256-CCM8',\n`
  )
  .replace(
    "    0xc09d: 'AES256-CCM',\n",
    "    0xc09d: 'AES256-CCM',\n    0xc0a0: 'AES128-CCM8',\n    0xc0a1: 'AES256-CCM8',\n"
  )

fs.writeFileSync(target, patched)
