#!/usr/bin/env node
/**
 * Mint an EdDSA (Ed25519) access token from a development key.
 *
 * Uses node:crypto directly — no dependencies, so it runs from the repository root
 * where there is no package.json (ADR 0001). It exists for the platform smoke test and
 * for poking at the gateway by hand; services mint their own tokens through `jose`.
 *
 *   node infra/scripts/mint-dev-token.mjs [--kid dev-1] [--sub <uuid>] [--ttl 900]
 *   node infra/scripts/mint-dev-token.mjs --bogus     # signed by a throwaway key
 *
 * `--bogus` signs with a freshly generated key that the gateway has never seen, which
 * is how the smoke test proves the gateway actually rejects something.
 */
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const INFRA = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const kid = flag('kid', 'dev-1')
const subject = flag('sub', randomUUID())
const tenant = flag('tenant', randomUUID())
const ttl = Number(flag('ttl', '900'))
const bogus = args.includes('--bogus')

const base64url = (input) =>
  Buffer.from(input).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

let privateKey
if (bogus) {
  privateKey = generateKeyPairSync('ed25519').privateKey
} else {
  const keyPath = join(process.env.HORIZON_KEY_DIR ?? join(INFRA, 'keys'), `ed25519-${kid}-private.pem`)
  if (!existsSync(keyPath)) {
    console.error(`no private key at ${keyPath} — run 'make keys' first`)
    process.exit(1)
  }
  privateKey = createPrivateKey(readFileSync(keyPath))
}

const now = Math.floor(Date.now() / 1000)

const header = { alg: 'EdDSA', typ: 'JWT', kid }
const payload = {
  // Kong matches its consumer credential on the `iss` claim (key_claim_name: iss),
  // because Kong OSS cannot fetch a JWKS document. See gateway/kong.yml.
  iss: `horizon-identity-${kid}`,
  sub: subject,
  tenant_id: tenant,
  roles: [],
  jti: randomUUID(),
  iat: now,
  exp: now + ttl,
}

const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
const signature = sign(null, Buffer.from(signingInput), privateKey)

process.stdout.write(
  `${signingInput}.${signature.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}\n`,
)
