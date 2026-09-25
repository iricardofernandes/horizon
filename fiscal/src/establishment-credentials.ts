import { spawn } from 'node:child_process'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  randomUUID,
  X509Certificate,
} from 'node:crypto'
import postgres from 'postgres'
import { z } from 'zod'
import type { HomologationCredential } from './nfe55/homologation-credential'
import { certificateLegalEntityCnpj } from './nfe55/icp-brasil-cnpj'

const uuid = z.uuid()
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/)
const maxPfxBytes = 512 * 1024

function keyFor(master: Buffer, tenantId: string): Buffer {
  if (master.length !== 32) throw new Error('Fiscal credential encryption key must be 32 bytes')
  return Buffer.from(
    hkdfSync('sha256', master, Buffer.from(tenantId), 'fiscal-a1-credential-v1', 32),
  )
}

function seal(master: Buffer, tenantId: string, establishmentId: string, id: string, pem: Buffer) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(master, tenantId), nonce)
  cipher.setAAD(Buffer.from(`${tenantId}:${establishmentId}:${id}`))
  return Buffer.concat([
    Buffer.from([1]),
    nonce,
    cipher.update(pem),
    cipher.final(),
    cipher.getAuthTag(),
  ])
}

function open(
  master: Buffer,
  tenantId: string,
  establishmentId: string,
  id: string,
  packed: Buffer,
) {
  if (packed.length < 29 || packed[0] !== 1) throw new Error('Invalid fiscal credential envelope')
  const decipher = createDecipheriv('aes-256-gcm', keyFor(master, tenantId), packed.subarray(1, 13))
  decipher.setAAD(Buffer.from(`${tenantId}:${establishmentId}:${id}`))
  decipher.setAuthTag(packed.subarray(-16))
  return Buffer.concat([decipher.update(packed.subarray(13, -16)), decipher.final()])
}

/** Password stays on a dedicated pipe; neither password nor PFX reaches argv or disk. */
async function extractPem(pfx: Buffer, password: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'openssl',
      ['pkcs12', '-in', '-', '-nodes', '-clcerts', '-passin', 'fd:3'],
      {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      },
    )
    const chunks: Buffer[] = []
    let size = 0
    const timeout = setTimeout(() => child.kill(), 10_000)
    child.stdin.on('error', () => {})
    child.stdout.on('data', (part: Buffer) => {
      size += part.length
      if (size > 2 * 1024 * 1024) child.kill()
      else chunks.push(part)
    })
    child.on('error', () => reject(new Error('Certificate parser unavailable')))
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0 || size > 2 * 1024 * 1024)
        reject(new Error('Invalid certificate file or password'))
      else resolve(Buffer.concat(chunks))
    })
    child.stdin.end(pfx)
    const passPipe = child.stdio[3]
    if (passPipe && 'end' in passPipe) {
      passPipe.on('error', () => {})
      passPipe.end(`${password}\n`)
    }
  })
}

function parsedPem(pem: Buffer): HomologationCredential {
  const value = pem.toString('utf8')
  const certificates =
    value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  const keys =
    value.match(
      /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/g,
    ) ?? []
  if (certificates.length !== 1 || keys.length !== 1)
    throw new Error('Certificate file must contain exactly one issuer certificate and private key')
  const certificate = Buffer.from(certificates[0] as string)
  const privateKey = Buffer.from(keys[0] as string)
  const parsed = new X509Certificate(certificate)
  const key = createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'rsa') throw new Error('NF-e certificate requires an RSA key')
  const derived = createPublicKey(key).export({
    type: 'spki',
    format: 'der',
  })
  const publicKey = parsed.publicKey.export({ type: 'spki', format: 'der' })
  if (!Buffer.from(derived).equals(Buffer.from(publicKey)))
    throw new Error('Certificate and private key do not match')
  const validUntil = Date.parse(parsed.validTo)
  const minimumRemainingMilliseconds = 24 * 60 * 60 * 1000
  if (
    Date.parse(parsed.validFrom) > Date.now() ||
    validUntil <= Date.now() + minimumRemainingMilliseconds
  )
    throw new Error('Certificate is expired, not yet valid or expires within 24 hours')
  return {
    certificate,
    privateKey,
    fingerprint: createHash('sha256').update(parsed.raw).digest('hex'),
    issuerTaxId: certificateLegalEntityCnpj(parsed),
    validUntil,
    minimumRemainingMilliseconds,
  }
}

export class FiscalEstablishmentCredentials {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly master: Buffer,
  ) {
    keyFor(master, 'startup')
    this.#db = postgres(databaseUrl, { max: 5, connection: { statement_timeout: 5000 } })
  }

  async close() {
    await this.#db.end()
  }

  async list(tenantId: string) {
    uuid.parse(tenantId)
    const rows = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select establishment_id, issuer_tax_id, fingerprint, valid_until, uploaded_at
        from fiscal_establishment_credentials where tenant_id = ${tenantId} and active
        order by uploaded_at desc`
    })
    return rows.map((row) => ({
      establishment_id: String(row.establishment_id),
      issuer_tax_id: String(row.issuer_tax_id),
      fingerprint: String(row.fingerprint),
      valid_until: (row.valid_until as Date).toISOString(),
      uploaded_at: (row.uploaded_at as Date).toISOString(),
    }))
  }

  async upload(input: {
    tenantId: string
    establishmentId: string
    pfx: Buffer
    password: string
    actorId: string
  }) {
    const tenantId = uuid.parse(input.tenantId)
    const establishmentId = uuid.parse(input.establishmentId)
    z.string().min(1).max(200).parse(input.actorId)
    if (input.pfx.length === 0 || input.pfx.length > maxPfxBytes)
      throw new Error('Certificate file is empty or exceeds 512 KiB')
    const credential = parsedPem(await extractPem(input.pfx, input.password))
    const id = randomUUID()
    const pem = Buffer.concat([credential.certificate, Buffer.from('\n'), credential.privateKey])
    const ciphertext = seal(this.master, tenantId, establishmentId, id, pem)
    await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${establishmentId}`}, 0))`
      await tx`update fiscal_establishment_credentials set active = false
        where tenant_id = ${tenantId} and establishment_id = ${establishmentId} and active`
      await tx`insert into fiscal_establishment_credentials
        (id, tenant_id, establishment_id, issuer_tax_id, fingerprint, valid_until, encrypted_pem, uploaded_by)
        values (${id}, ${tenantId}, ${establishmentId}, ${credential.issuerTaxId},
          ${credential.fingerprint}, ${new Date(credential.validUntil)}, ${ciphertext}, ${input.actorId})
        on conflict (tenant_id, establishment_id, fingerprint) do update
          set active = true`
    })
    return {
      establishmentId,
      issuerTaxId: credential.issuerTaxId,
      fingerprint: credential.fingerprint,
      validUntil: new Date(credential.validUntil).toISOString(),
    }
  }

  async active(tenantId: string, establishmentId: string): Promise<HomologationCredential> {
    return this.load(tenantId, establishmentId, null)
  }

  async forExchange(tenantId: string, exchangeId: string): Promise<HomologationCredential> {
    uuid.parse(tenantId)
    uuid.parse(exchangeId)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select document.establishment_id, exchange.certificate_fingerprint
        from fiscal_homologation_exchanges exchange
        join fiscal_documents document on document.tenant_id = exchange.tenant_id and document.id = exchange.document_id
        where exchange.tenant_id = ${tenantId} and exchange.id = ${exchangeId}`
    })
    if (!row) throw new Error('SEFAZ exchange not found')
    return this.load(tenantId, String(row.establishment_id), String(row.certificate_fingerprint))
  }

  async forDocument(
    tenantId: string,
    documentId: string,
    fingerprint: string | null = null,
  ): Promise<HomologationCredential> {
    uuid.parse(tenantId)
    uuid.parse(documentId)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select establishment_id from fiscal_documents
        where tenant_id = ${tenantId} and id = ${documentId}`
    })
    if (!row) throw new Error('Fiscal document not found')
    return this.load(tenantId, String(row.establishment_id), fingerprint)
  }

  private async load(
    tenantId: string,
    establishmentId: string,
    fingerprint: string | null,
  ): Promise<HomologationCredential> {
    uuid.parse(tenantId)
    uuid.parse(establishmentId)
    if (fingerprint) fingerprintSchema.parse(fingerprint)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select id, issuer_tax_id, fingerprint, encrypted_pem
        from fiscal_establishment_credentials
        where tenant_id = ${tenantId} and establishment_id = ${establishmentId}
          and ((${fingerprint}::text is null and active) or fingerprint = ${fingerprint})
        limit 1`
    })
    if (!row) throw new Error('No certificate configured for this establishment and exchange')
    const pem = open(
      this.master,
      tenantId,
      establishmentId,
      String(row.id),
      row.encrypted_pem as Buffer,
    )
    const credential = parsedPem(pem)
    if (credential.fingerprint !== row.fingerprint || credential.issuerTaxId !== row.issuer_tax_id)
      throw new Error('Stored certificate metadata differs from encrypted material')
    return credential
  }
}
