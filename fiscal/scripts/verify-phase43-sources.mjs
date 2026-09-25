import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const manifest = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'docs/fiscal-phase43-source-manifest.json'), 'utf8'),
)
if (manifest.schemaVersion !== 1 || manifest.phase !== 43 || !Array.isArray(manifest.candidateSources))
  throw new Error('Invalid Phase 43 source manifest')

for (const source of manifest.candidateSources) {
  if (!/^[0-9a-f]{64}$/.test(source.sha256))
    throw new Error(`Invalid source digest for ${source.id}`)
  const directory = resolve(repositoryRoot, '.artifacts/fiscal/nfe', source.sha256)
  const names = readdirSync(directory)
  if (names.length !== 1) throw new Error(`${source.id} must have one retained source file`)
  const sourcePath = resolve(directory, names[0])
  verify(source.id, readFileSync(sourcePath), source.sha256)
  for (const entry of source.consumedResponseSchemas ?? []) {
    const bytes = execFileSync('unzip', ['-p', sourcePath, entry.path], {
      maxBuffer: 2 * 1024 * 1024,
    })
    verify(`${source.id}:${entry.path}`, bytes, entry.sha256)
  }
}

console.log(`Phase 43 candidate sources verified: ${manifest.candidateSources.length} artifacts`)

function verify(label, bytes, expectedDigest) {
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expectedDigest) throw new Error(`${label} digest mismatch: ${actual}`)
}
