import { createHmac, hkdfSync } from 'node:crypto'

/**
 * Blind index of a party tax id: equal ids in one tenant give equal digests, the same id
 * in two tenants gives unrelated digests, and the digest reveals nothing without the key.
 */
export function partyTaxIdDigest(master: Buffer, tenantId: string, taxId: string): string {
  if (master.length !== 32) throw new Error('Fiscal party index key must be 32 bytes')
  const key = Buffer.from(
    hkdfSync('sha256', master, Buffer.from(tenantId), 'fiscal-party-tax-index-v1', 32),
  )
  return createHmac('sha256', key)
    .update(taxId.toUpperCase().replace(/[.\-/\s]/g, ''))
    .digest('hex')
}
