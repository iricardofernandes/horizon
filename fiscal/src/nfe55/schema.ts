import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { validateXML } from 'xmllint-wasm'

const ROOT = 'PL_010f_v1.04/'
const MAIN = `${ROOT}nfe_v4.00.xsd`
const REQUIRED = [
  `${ROOT}DFeTiposBasicos_v1.00.xsd`,
  `${ROOT}leiauteNFe_v4.00.xsd`,
  MAIN,
  `${ROOT}tiposBasico_v4.00.xsd`,
  `${ROOT}xmldsig-core-schema_v1.01.xsd`,
] as const

export async function validateNfe55Schema(input: {
  xml: Buffer
  schemaZip: Buffer
  expectedZipDigest: string
}): Promise<void> {
  const digest = createHash('sha256').update(input.schemaZip).digest('hex')
  if (digest !== input.expectedZipDigest) throw new Error('NF-e schema package digest mismatch')
  const entries = unzipSync(input.schemaZip)
  const required = new Map(
    REQUIRED.map((path) => {
      const bytes = entries[path]
      if (!bytes) throw new Error(`NF-e schema package is missing ${path}`)
      return [path, bytes] as const
    }),
  )
  const main = required.get(MAIN)
  if (!main) throw new Error('NF-e main schema is unavailable')
  const result = await validateXML({
    xml: { fileName: 'document.xml', contents: input.xml },
    schema: { fileName: MAIN, contents: main },
    preload: [...required.entries()]
      .filter(([path]) => path !== MAIN)
      .map(([fileName, contents]) => ({ fileName, contents })),
  })
  if (!result.valid) {
    const detail = result.errors
      .slice(0, 3)
      .map((error) => error.message)
      .join('; ')
    throw new Error(`NF-e XML schema validation failed: ${detail}`)
  }
}
