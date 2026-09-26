import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { validateXML } from 'xmllint-wasm'
import { recordXmlValidationFailure } from '../metrics'
import type { SefazService } from './sefaz-transport'

const packageByService: Record<SefazService, { root: string; schema: string }> = {
  authorization: {
    root: 'PL_009p_NT2024_003_v1.03/',
    schema: 'retEnviNFe_v4.00.xsd',
  },
  status: {
    root: 'PL_009p_NT2024_003_v1.03/',
    schema: 'retConsStatServ_v4.00.xsd',
  },
  receipt: {
    root: 'PL_010d_v1.03/NFe/',
    schema: 'retConsReciNFe_v4.00.xsd',
  },
  protocol: {
    root: 'PL_010d_v1.03/NFe/',
    schema: 'retConsSitNFe_v4.00.xsd',
  },
  event: {
    root: 'PL_010d_v1.03/Evento/',
    schema: 'retEnvEvento_v1.00.xsd',
  },
}

export type SefazResponseSchemaSource = {
  archive: Buffer
  digest: string
}

export class SefazResponseSchemaValidator {
  constructor(
    private readonly documentSource: SefazResponseSchemaSource,
    private readonly consultationSource: SefazResponseSchemaSource,
  ) {
    verifySource(documentSource, ['authorization', 'status'])
    verifySource(consultationSource, ['receipt', 'protocol', 'event'])
  }

  get documentDigest(): string {
    return this.documentSource.digest
  }

  get consultationDigest(): string {
    return this.consultationSource.digest
  }

  async validate(service: SefazService, payload: Buffer): Promise<void> {
    await validateSefazResponseSchema({
      service,
      payload,
      source:
        service === 'authorization' || service === 'status'
          ? this.documentSource
          : this.consultationSource,
    })
  }
}

function verifySource(source: SefazResponseSchemaSource, services: SefazService[]): void {
  if (source.archive.length === 0 || source.archive.length > 2_000_000)
    throw new Error('SEFAZ response schema package size is outside the supported bound')
  if (!/^[0-9a-f]{64}$/.test(source.digest))
    throw new Error('SEFAZ response schema digest is invalid')
  if (createHash('sha256').update(source.archive).digest('hex') !== source.digest)
    throw new Error('SEFAZ response schema package digest mismatch')
  const archive = unzipSync(source.archive)
  for (const service of services) {
    const selected = packageByService[service]
    if (!archive[`${selected.root}${selected.schema}`])
      throw new Error(`SEFAZ response schema package is missing ${selected.root}${selected.schema}`)
  }
}

/** Validates one extracted NF-e result payload against a byte-pinned official XSD archive. */
export async function validateSefazResponseSchema(input: {
  service: SefazService
  payload: Buffer
  source: SefazResponseSchemaSource
}): Promise<void> {
  const selected = packageByService[input.service]
  if (input.payload.length === 0 || input.payload.length > 2_000_000)
    throw new Error('SEFAZ response payload size is outside the supported bound')
  if (!/^[0-9a-f]{64}$/.test(input.source.digest))
    throw new Error('SEFAZ response schema digest is invalid')
  if (createHash('sha256').update(input.source.archive).digest('hex') !== input.source.digest)
    throw new Error('SEFAZ response schema package digest mismatch')
  const archive = unzipSync(input.source.archive)
  const schemaPath = `${selected.root}${selected.schema}`
  const schema = archive[schemaPath]
  if (!schema) throw new Error(`SEFAZ response schema package is missing ${schemaPath}`)
  const preload = Object.entries(archive)
    .filter(
      ([path]) => path.startsWith(selected.root) && path.endsWith('.xsd') && path !== schemaPath,
    )
    .map(([fileName, contents]) => ({ fileName, contents }))
  const result = await validateXML({
    xml: { fileName: 'sefaz-response.xml', contents: input.payload },
    schema: { fileName: schemaPath, contents: schema },
    preload,
  })
  if (!result.valid) {
    recordXmlValidationFailure('sefaz-response')
    throw new Error(
      `SEFAZ response XML schema validation failed: ${result.errors
        .slice(0, 3)
        .map((error) => error.message)
        .join('; ')}`,
    )
  }
}
