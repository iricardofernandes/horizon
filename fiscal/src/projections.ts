import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { z } from 'zod'

const uuid = z.uuid()
const date = z.iso.date()
const address = z.strictObject({
  street: z.string().min(1),
  number: z.string().min(1),
  complement: z.string().nullable(),
  district: z.string().min(1),
  city: z.string().min(1),
  municipalityCode: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string(),
  country: z.string().length(2),
})

export const partyFiscalExportSchema = z.strictObject({
  tenantId: uuid,
  partyId: uuid,
  kind: z.enum(['person', 'organization']),
  legalName: z.string().min(1),
  tradeName: z.string().nullable(),
  taxId: z.string().min(11).max(14),
  revision: z.number().int().positive(),
  profile: z.strictObject({
    effectiveFrom: date,
    stateRegistration: z.string().nullable(),
    municipalRegistration: z.string().nullable(),
    taxpayerIndicator: z.enum(['contributor', 'exempt', 'non-contributor']),
    finalConsumer: z.boolean(),
    address,
  }),
})

export const issuerFiscalExportSchema = z.strictObject({
  tenantId: uuid,
  revision: z.number().int().positive(),
  effectiveFrom: date,
  timezone: z.string().min(1),
  company: z.strictObject({
    legalName: z.string().min(1),
    tradeName: z.string().nullable(),
    taxId: z.string().nullable(),
    stateRegistration: z.string().nullable(),
    municipalRegistration: z.string().nullable(),
    address: z.strictObject({
      line: z.string().nullable(),
      city: z.string().nullable(),
      municipalityCode: z.string().nullable(),
      state: z.string().nullable(),
      postalCode: z.string().nullable(),
      country: z.string().length(2),
    }),
    baseCurrency: z.string().length(3),
    fiscalRegime: z.enum([
      'simples-nacional',
      'lucro-presumido',
      'lucro-real',
      'mei',
      'not-declared',
    ]),
  }),
})

export type PartyFiscalExport = z.infer<typeof partyFiscalExportSchema>
export type IssuerFiscalExport = z.infer<typeof issuerFiscalExportSchema>
type Source = 'parties' | 'identity'
type FiscalExport = PartyFiscalExport | IssuerFiscalExport
type Sql = ReturnType<typeof postgres>

/** Encrypted historical copies; an erased subject's key cannot be re-created. */
export class FiscalProjections {
  readonly #db: Sql

  constructor(url: string) {
    this.#db = postgres(url, { max: 10, connection: { statement_timeout: 5000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async storeParty(
    tenantId: string,
    expectedPartyId: string,
    expectedRevision: number,
    raw: unknown,
  ): Promise<'inserted' | 'existing'> {
    const record = partyFiscalExportSchema.parse(raw)
    if (
      record.tenantId !== tenantId ||
      record.partyId !== expectedPartyId ||
      record.revision !== expectedRevision
    )
      throw new Error('Party fiscal export does not match the requested subject and revision')
    return this.store(
      tenantId,
      'parties',
      record.partyId,
      record.revision,
      record.profile.effectiveFrom,
      record,
    )
  }

  async storeIssuer(
    tenantId: string,
    expectedRevision: number,
    raw: unknown,
  ): Promise<'inserted' | 'existing'> {
    const record = issuerFiscalExportSchema.parse(raw)
    if (record.tenantId !== tenantId || record.revision !== expectedRevision)
      throw new Error('Issuer fiscal export does not match the requested tenant and revision')
    return this.store(tenantId, 'identity', tenantId, record.revision, record.effectiveFrom, record)
  }

  async readParty(
    tenantId: string,
    partyId: string,
    revision: number,
  ): Promise<PartyFiscalExport | null> {
    return (await this.read(tenantId, 'parties', partyId, revision)) as PartyFiscalExport | null
  }

  async readIssuer(tenantId: string, revision: number): Promise<IssuerFiscalExport | null> {
    return (await this.read(tenantId, 'identity', tenantId, revision)) as IssuerFiscalExport | null
  }

  async storeClassification(
    tenantId: string,
    expectedItemId: string,
    expectedRevision: number,
    raw: unknown,
  ): Promise<'inserted' | 'existing'> {
    const record = z
      .strictObject({
        tenantId: uuid,
        itemId: uuid,
        revision: z.number().int().positive(),
        effectiveFrom: date,
        ncm: z
          .string()
          .regex(/^\d{8}$/)
          .nullable(),
      })
      .parse(raw)
    if (
      record.tenantId !== tenantId ||
      record.itemId !== expectedItemId ||
      record.revision !== expectedRevision
    )
      throw new Error('Classification export does not match the requested item and revision')
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await tx`insert into tenants (id) values (${tenantId}) on conflict do nothing`
      const inserted = await tx`
        insert into catalog_classifications (tenant_id, item_id, revision, effective_from, ncm)
        values (${tenantId}, ${record.itemId}, ${record.revision}, ${record.effectiveFrom}, ${record.ncm})
        on conflict on constraint catalog_classifications_key do nothing returning revision`
      if (inserted.length > 0) return 'inserted'
      const [existing] = await tx`
        select effective_from, ncm from catalog_classifications where tenant_id = ${tenantId}
          and item_id = ${record.itemId} and revision = ${record.revision}`
      if (
        calendarDate(existing?.effective_from) !== record.effectiveFrom ||
        existing?.ncm !== record.ncm
      )
        throw new Error('Classification export conflicts with an existing revision')
      return 'existing'
    })
  }

  private async store(
    tenantId: string,
    source: Source,
    subjectId: string,
    revision: number,
    effectiveFrom: string,
    record: FiscalExport,
  ): Promise<'inserted' | 'existing'> {
    const plaintext = JSON.stringify(record)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await tx`insert into tenants (id) values (${tenantId}) on conflict do nothing`
      const [notice] = await tx`
        select effective_from from profile_requests where tenant_id = ${tenantId}
          and source_module = ${source} and subject_id = ${subjectId} and revision = ${revision}`
      if (notice && calendarDate(notice.effective_from) !== effectiveFrom)
        throw new Error('Fiscal export effective date conflicts with owner notice')
      await tx`insert into profile_requests
        (tenant_id, source_module, subject_id, revision, effective_from)
        values (${tenantId}, ${source}, ${subjectId}, ${revision}, ${effectiveFrom})
        on conflict on constraint profile_requests_key do nothing`

      await tx`insert into profile_keys (tenant_id, source_module, subject_id, material)
        values (${tenantId}, ${source}, ${subjectId}, ${randomBytes(32).toString('base64')})
        on conflict do nothing`
      const [key] = await tx`
        select material, erased_at from profile_keys where tenant_id = ${tenantId}
          and source_module = ${source} and subject_id = ${subjectId} for update`
      if (!key?.material || key.erased_at) throw new Error('Fiscal profile subject has been erased')
      const digest = createHmac('sha256', Buffer.from(key.material, 'base64'))
        .update(plaintext)
        .digest('hex')
      const inserted = await tx`
        insert into profile_revisions
          (tenant_id, source_module, subject_id, revision, effective_from, ciphertext, digest)
        values (
          ${tenantId}, ${source}, ${subjectId}, ${revision}, ${effectiveFrom},
          ${seal(key.material, aad(tenantId, source, subjectId, revision), plaintext)}, ${digest}
        ) on conflict on constraint profile_revisions_key do nothing returning revision`
      if (inserted.length > 0) return 'inserted'
      const [existing] = await tx`
        select digest from profile_revisions where tenant_id = ${tenantId}
          and source_module = ${source} and subject_id = ${subjectId} and revision = ${revision}`
      if (existing?.digest !== digest)
        throw new Error('Fiscal profile revision conflicts with its existing projection')
      return 'existing'
    })
  }

  private async read(
    tenantId: string,
    source: Source,
    subjectId: string,
    revision: number,
  ): Promise<FiscalExport | null> {
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      const [row] = await tx`
        select r.ciphertext, k.material from profile_revisions r
        join profile_keys k on k.tenant_id = r.tenant_id
          and k.source_module = r.source_module and k.subject_id = r.subject_id
        where r.tenant_id = ${tenantId} and r.source_module = ${source}
          and r.subject_id = ${subjectId} and r.revision = ${revision}`
      if (!row?.material) return null
      const value: unknown = JSON.parse(
        open(row.material, aad(tenantId, source, subjectId, revision), row.ciphertext),
      )
      return source === 'parties'
        ? partyFiscalExportSchema.parse(value)
        : issuerFiscalExportSchema.parse(value)
    })
  }
}

function aad(tenantId: string, source: Source, subjectId: string, revision: number): Buffer {
  return Buffer.from(`${tenantId}:${source}:${subjectId}:${revision}`)
}

function seal(material: string, additionalData: Buffer, plaintext: string): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(material, 'base64'), nonce)
  cipher.setAAD(additionalData)
  const bytes = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64')
}

function open(material: string, additionalData: Buffer, ciphertext: string): string {
  const packed = Buffer.from(ciphertext, 'base64')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(material, 'base64'),
    packed.subarray(0, 12),
  )
  decipher.setAAD(additionalData)
  decipher.setAuthTag(packed.subarray(12, 28))
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8')
}

function calendarDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return typeof value === 'string' ? value.slice(0, 10) : null
}
