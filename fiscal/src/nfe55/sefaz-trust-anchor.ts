import { createHash, X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/)

export type SefazTrustAnchor = {
  certificate: Buffer
  fingerprint: string
}

/** Loads one independently reviewed ICP-Brasil TLS root certificate. */
export async function loadSefazTrustAnchor(input: {
  certificatePath: string
  expectedFingerprint: string
}): Promise<SefazTrustAnchor> {
  const expected = fingerprintSchema.parse(input.expectedFingerprint)
  const certificate = await readFile(input.certificatePath)
  const parsed = new X509Certificate(certificate)
  const actual = createHash('sha256').update(parsed.raw).digest('hex')
  if (actual !== expected) throw new Error('SEFAZ TLS trust anchor fingerprint mismatch')
  if (!parsed.ca || !parsed.checkIssued(parsed) || !parsed.verify(parsed.publicKey))
    throw new Error('SEFAZ TLS trust anchor is not a self-signed CA')
  const now = Date.now()
  if (Date.parse(parsed.validFrom) > now || Date.parse(parsed.validTo) <= now)
    throw new Error('SEFAZ TLS trust anchor is not currently valid')
  // Re-encode the one verified certificate so appended PEM blocks cannot add trust roots.
  return { certificate: Buffer.from(parsed.toString()), fingerprint: actual }
}
