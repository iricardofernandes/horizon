import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

const fingerprint = z.string().regex(/^[0-9a-f]{64}$/)

export type HomologationCredential = {
  certificate: Buffer
  privateKey: Buffer
  fingerprint: string
  validUntil: number
  minimumRemainingMilliseconds: number
}

/** Reads a secret-mounted PEM pair; only its public fingerprint may be persisted. */
export async function loadHomologationCredential(input: {
  certificatePath: string
  privateKeyPath: string
  expectedFingerprint: string
  minimumRemainingMilliseconds?: number
}): Promise<HomologationCredential> {
  const expected = fingerprint.parse(input.expectedFingerprint)
  const [certificate, privateKey] = await Promise.all([
    readFile(input.certificatePath),
    readFile(input.privateKeyPath),
  ])
  const parsed = new X509Certificate(certificate)
  const actual = createHash('sha256').update(parsed.raw).digest('hex')
  if (actual !== expected) throw new Error('Homologation certificate fingerprint mismatch')
  const minimum = input.minimumRemainingMilliseconds ?? 24 * 60 * 60 * 1_000
  const now = Date.now()
  const validUntil = Date.parse(parsed.validTo)
  if (Date.parse(parsed.validFrom) > now || validUntil <= now + minimum)
    throw new Error('Homologation certificate is not currently valid')
  const derivedPublicKey = createPublicKey(createPrivateKey(privateKey)).export({
    type: 'spki',
    format: 'der',
  })
  const certificatePublicKey = parsed.publicKey.export({ type: 'spki', format: 'der' })
  if (!Buffer.from(derivedPublicKey).equals(Buffer.from(certificatePublicKey)))
    throw new Error('Homologation certificate and private key do not match')
  return {
    certificate,
    privateKey,
    fingerprint: actual,
    validUntil,
    minimumRemainingMilliseconds: minimum,
  }
}
