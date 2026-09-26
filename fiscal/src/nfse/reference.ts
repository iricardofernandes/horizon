import { createHash } from 'node:crypto'
import reference from '../../fixtures/official/nfse-reference-v1.01.json'

/**
 * The national NFS-e reference tables Phase 47 checks against, extracted from the pinned
 * annexes (see `fiscal/fixtures/official/phase47-source-manifest.json`): the national service list
 * (Anexo B), NBS 2.0 (Anexo B), IBGE municipalities (Anexo A) and the IBS/CBS operation
 * indicators (Anexo C).
 */
const tables = reference as {
  nationalServiceCodes: Record<string, string>
  nbsCodes: Record<string, string>
  municipalities: Record<string, { uf: string; name: string }>
  operationIndicators: string[]
  sources: Record<string, { file: string; sha256: string; sheet: string }>
}

const operationIndicators = new Set(tables.operationIndicators)

export function nationalServiceDescription(code: string): string | null {
  return tables.nationalServiceCodes[code] ?? null
}

export function nbsDescription(code: string): string | null {
  return tables.nbsCodes[code] ?? null
}

export function ibgeMunicipality(code: string): { uf: string; name: string } | null {
  return tables.municipalities[code] ?? null
}

export function isOperationIndicator(code: string): boolean {
  return operationIndicators.has(code)
}

/** The source digests the extract was made from, for explanations and evidence. */
export function referenceSources(): Record<string, { file: string; sha256: string }> {
  return Object.fromEntries(
    Object.entries(tables.sources).map(([key, source]) => [
      key,
      { file: source.file, sha256: source.sha256 },
    ]),
  )
}

export function referenceDigest(): string {
  return createHash('sha256').update(JSON.stringify(reference)).digest('hex')
}
