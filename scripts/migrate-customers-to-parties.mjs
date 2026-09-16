#!/usr/bin/env node
/**
 * One-shot migration: Sales customers → the party registry (ADR 0040).
 *
 * Before `parties/` existed, Sales registered its own customers. Their identifiers are
 * already referenced by quotes and orders, so each one is registered as a party that
 * *adopts* the same id, with the `customer` role. Registration goes through the
 * registry's own use case, inside its tenant transaction and under RLS, so the party gets
 * a fresh data key, a blind-indexed tax identifier, and a `parties.party.registered`
 * event in the outbox — which the running Sales consumer turns back into a refreshed
 * projection of the very row it came from.
 *
 * Reading the source needs the Sales database as its administrator: decrypting a
 * customer requires its data key, and this is the only process that is allowed both keys.
 * Erased customers are skipped; there is nothing left to migrate. Re-running is safe: a
 * customer whose id or tax identifier is already a party is reported and left alone.
 *
 *   node scripts/migrate-customers-to-parties.mjs [--dry-run]
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const salesRequire = createRequire(join(root, 'sales/package.json'))
const partiesRequire = createRequire(join(root, 'parties/package.json'))
const postgres = salesRequire('postgres')
const { AesGcmSecretBox: SalesSecretBox } = salesRequire(
  join(root, 'sales/dist/infrastructure/cryptography/aes-gcm-secret-box.js'),
)
const { PartiesDatabase } = partiesRequire(
  join(root, 'parties/dist/infrastructure/database/drizzle/parties-database.js'),
)
const { AesGcmSecretBox: PartiesSecretBox } = partiesRequire(
  join(root, 'parties/dist/infrastructure/cryptography/aes-gcm-secret-box.js'),
)
const { RegisterPartyUseCase } = partiesRequire(
  join(root, 'parties/dist/application/use-cases/manage-parties.js'),
)

const dryRun = process.argv.includes('--dry-run')
const localEnv = readLocalEnv(join(root, 'infra/.env'))
const port = process.env.HORIZON_POSTGRES_PORT ?? localEnv.HORIZON_POSTGRES_PORT ?? '5432'
const salesAdminUrl =
  process.env.SALES_ADMIN_DATABASE_URL ??
  `postgres://postgres:postgres@localhost:${port}/horizon_sales`
const partiesUrl =
  process.env.PARTIES_DATABASE_URL ??
  `postgres://horizon_app:horizon@localhost:${port}/horizon_parties`
const partyIndexKey = process.env.PARTY_BLIND_INDEX_KEY ?? '0'.repeat(64)

const sales = postgres(salesAdminUrl, { max: 1 })
const parties = new PartiesDatabase({
  url: partiesUrl,
  privacy: { secretBox: new PartiesSecretBox(), blindIndexKey: Buffer.from(partyIndexKey, 'hex') },
})
const register = new RegisterPartyUseCase(parties, { now: () => new Date() })
const salesBox = new SalesSecretBox()
const tally = { migrated: 0, alreadyParties: 0, erased: 0, failed: 0 }

try {
  const customers = await sales`
    select c.id, c.tenant_id, c.status, c.name_ciphertext, c.tax_id_ciphertext,
           c.email_ciphertext, c.phone_ciphertext, c.address_ciphertext, k.material
    from customers c
    join customer_data_keys k on k.tenant_id = c.tenant_id and k.id = c.id
    order by c.tenant_id, c.created_at`

  for (const row of customers) {
    if (row.status === 'erased' || row.material === null || row.tax_id_ciphertext === null) {
      tally.erased += row.status === 'erased' ? 1 : 0
      continue
    }
    const open = (field, ciphertext) => {
      const plaintext = salesBox.open(`${row.tenant_id}:${row.id}:${field}:${row.material}`, ciphertext)
      if (plaintext === null) throw new Error(`customer ${row.id}: ${field} failed authentication`)
      return plaintext
    }
    const taxId = open('taxId', row.tax_id_ciphertext)
    const request = {
      tenantId: row.tenant_id,
      partyId: row.id,
      kind: taxId.length === 14 ? 'organization' : 'person',
      legalName: open('name', row.name_ciphertext),
      taxId,
      email: open('email', row.email_ciphertext),
      phone: open('phone', row.phone_ciphertext),
      address: open('address', row.address_ciphertext),
      roles: ['customer'],
    }
    if (dryRun) {
      console.log(`would migrate customer ${row.id} (tenant ${row.tenant_id})`)
      continue
    }
    const result = await register.execute(request)
    if (result.isRight()) {
      tally.migrated += 1
      console.log(`migrated customer ${row.id}`)
    } else if (result.value.title === 'Conflict') {
      tally.alreadyParties += 1
      console.log(`customer ${row.id} is already a party: ${result.value.message}`)
    } else {
      tally.failed += 1
      console.error(`customer ${row.id} was not migrated: ${result.value.message}`)
    }
  }
  console.log(JSON.stringify({ dryRun, ...tally }))
  if (tally.failed > 0) process.exitCode = 1
} finally {
  await Promise.allSettled([sales.end({ timeout: 5 }), parties.close()])
}

/** The local platform's port overrides, when the script runs against `make up-apps`. */
function readLocalEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    )
  } catch {
    return {}
  }
}
