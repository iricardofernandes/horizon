import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DECLARED_NCM, goodsPackage, issPackage, type SourceManifest } from './legacy-packages'
import { blendPackage, pisCofinsNormalPackage, simplesMeiPackage } from './regime-packages'

/**
 * The packages of Phases 85 and 86, built from the pinned sources in the repository and the
 * law store, as `tax:scenarios` publishes them and the Phase 89 isolated run reads them.
 */
export async function reviewedPackages(repository: string) {
  const manifest: SourceManifest = {
    sources: (
      await Promise.all(
        ['82', '85', '86'].map(
          async (phase) =>
            (
              JSON.parse(
                await readFile(
                  join(repository, `docs/tax-phase${phase}-source-manifest.json`),
                  'utf8',
                ),
              ) as SourceManifest
            ).sources,
        ),
      )
    ).flat(),
  }
  const tipi = manifest.sources.find((source) => source.id === 'tipi-2022')
  if (!tipi) throw new Error('the manifest pins no TIPI')
  const tipiPath = join(repository, '.artifacts/fiscal/law', tipi.sha256)
  if (!existsSync(tipiPath))
    throw new Error(`${tipiPath} is missing: the pinned TIPI is not stored`)
  return {
    phase85: [goodsPackage(manifest, readTipi(tipiPath), [DECLARED_NCM]), issPackage(manifest)],
    phase86: [
      pisCofinsNormalPackage(manifest),
      simplesMeiPackage(manifest),
      blendPackage(manifest),
    ],
  }
}

/** NCM → the TIPI's ad valorem rate as it is written, read from the pinned spreadsheet. */
export function readTipi(path: string): Map<string, string> {
  const member = (name: string) =>
    execFileSync('unzip', ['-p', path, name], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8')
  const decodeXml = (text: string) =>
    text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
  const shared = [...member('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (match) =>
      decodeXml(
        [...(match[1] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''),
      ),
  )
  const rates = new Map<string, string>()
  for (const row of member('xl/worksheets/sheet1.xml').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = new Map<string, string>()
    for (const cell of (row[1] ?? '').matchAll(
      /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(?:<v>([\s\S]*?)<\/v>)?[\s\S]*?<\/c>)/g,
    )) {
      const value = cell[3]
      if (value === undefined) continue
      cells.set(cell[1] ?? '', /t="s"/.test(cell[2] ?? '') ? (shared[Number(value)] ?? '') : value)
    }
    const ncm = (cells.get('A') ?? '').replace(/\./g, '').trim()
    // The plain row of an 8-digit code; an "Ex" row is a narrower product with its own rate.
    if (/^\d{8}$/.test(ncm) && !cells.get('B')) rates.set(ncm, (cells.get('D') ?? '').trim())
  }
  return rates
}
