import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { validateXML } from 'xmllint-wasm'

/** The pinned national NFS-e schema package (layout 1.01). */
export const NFSE_SCHEMA_DIGEST = 'e7935cbd9470527c6cc32984c1b2263e614183bf0139ce2733eaaed2de9a8072'
const ROOT = 'Schemas/1.01/'
const MAIN = {
  DPS: `${ROOT}DPS_v1.01.xsd`,
  NFSe: `${ROOT}NFSe_v1.01.xsd`,
  pedRegEvento: `${ROOT}pedRegEvento_v1.01.xsd`,
  evento: `${ROOT}evento_v1.01.xsd`,
} as const
const SHARED = [
  `${ROOT}tiposSimples_v1.01.xsd`,
  `${ROOT}tiposComplexos_v1.01.xsd`,
  `${ROOT}tiposEventos_v1.01.xsd`,
  `${ROOT}xmldsig-core-schema.xsd`,
] as const

export type NfseSchemaRoot = keyof typeof MAIN

/**
 * `TSSerieDPS` in the pinned 1.01 package is `^0{0,4}\d{1,5}$`. XSD regular expressions
 * have no anchors, so `^` and `$` are literal characters and no real series matches under
 * a conformant validator. The only change Horizon makes to the pinned bytes is dropping
 * those two characters, and only after the package digest matched.
 */
export const SERIES_PATTERN_DEFECT = {
  file: `${ROOT}tiposSimples_v1.01.xsd`,
  published: '<xs:pattern value="^0{0,4}\\d{1,5}$"/>',
  effective: '<xs:pattern value="0{0,4}\\d{1,5}"/>',
} as const

export async function validateNfseSchema(input: {
  xml: Buffer
  root: NfseSchemaRoot
  schemaZip: Buffer
}): Promise<void> {
  const digest = createHash('sha256').update(input.schemaZip).digest('hex')
  if (digest !== NFSE_SCHEMA_DIGEST) throw new Error('NFS-e schema package digest mismatch')
  const entries = unzipSync(input.schemaZip)
  const read = (path: string) => {
    const bytes = entries[path]
    if (!bytes) throw new Error(`NFS-e schema package is missing ${path}`)
    if (path !== SERIES_PATTERN_DEFECT.file) return bytes
    const published = Buffer.from(bytes).toString('utf8')
    if (published.split(SERIES_PATTERN_DEFECT.published).length !== 2)
      throw new Error('NFS-e series pattern differs from the pinned defect')
    return Buffer.from(
      published.replace(SERIES_PATTERN_DEFECT.published, SERIES_PATTERN_DEFECT.effective),
    )
  }
  const main = MAIN[input.root]
  const result = await validateXML({
    xml: { fileName: 'document.xml', contents: input.xml },
    schema: { fileName: main, contents: read(main) },
    preload: SHARED.map((fileName) => ({ fileName, contents: read(fileName) })),
  })
  if (!result.valid) {
    const detail = result.errors
      .slice(0, 3)
      .map((error) => error.message)
      .join('; ')
    throw new Error(`NFS-e ${input.root} schema validation failed: ${detail}`)
  }
}
