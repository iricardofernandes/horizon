import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Verifies the Phase 43 candidate sources by SHA-256.
 *
 * A source the code consumes ships in `fiscal/fixtures/official` and must match in every
 * checkout. Reference documents (manuals and technical notes) are retained outside git in
 * `.artifacts/fiscal/nfe/<sha256>/`; they are verified when that store is present, and
 * required with `--require-retained`, which the homologation workflow passes.
 */
const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const requireRetained = process.argv.includes('--require-retained')
const manifest = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'docs/fiscal-phase43-source-manifest.json'), 'utf8'),
)
if (manifest.schemaVersion !== 1 || manifest.phase !== 43 || !Array.isArray(manifest.candidateSources))
  throw new Error('Invalid Phase 43 source manifest')

const fixtures = resolve(repositoryRoot, 'fiscal/fixtures/official')
const shipped = new Map(
  readdirSync(fixtures).map((name) => {
    const path = resolve(fixtures, name)
    return [digest(readFileSync(path)), path]
  }),
)

let verified = 0
const notRetained = []
for (const source of manifest.candidateSources) {
  if (!/^[0-9a-f]{64}$/.test(source.sha256))
    throw new Error(`Invalid source digest for ${source.id}`)
  const sourcePath = shipped.get(source.sha256) ?? retained(source)
  if (!sourcePath) {
    notRetained.push(source.id)
    continue
  }
  verify(source.id, readFileSync(sourcePath), source.sha256)
  for (const entry of source.consumedResponseSchemas ?? []) {
    const bytes = execFileSync('unzip', ['-p', sourcePath, entry.path], {
      maxBuffer: 2 * 1024 * 1024,
    })
    verify(`${source.id}:${entry.path}`, bytes, entry.sha256)
  }
  verified += 1
}

if (notRetained.length && requireRetained)
  throw new Error(`Retained sources are missing: ${notRetained.join(', ')}`)
console.log(`Phase 43 candidate sources verified: ${verified} artifacts`)
if (notRetained.length)
  console.log(`Reference documents not retained in this checkout: ${notRetained.join(', ')}`)

function retained(source) {
  const directory = resolve(repositoryRoot, '.artifacts/fiscal/nfe', source.sha256)
  if (!existsSync(directory)) return null
  const names = readdirSync(directory)
  if (names.length !== 1) throw new Error(`${source.id} must have one retained source file`)
  return resolve(directory, names[0])
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function verify(label, bytes, expectedDigest) {
  const actual = digest(bytes)
  if (actual !== expectedDigest) throw new Error(`${label} digest mismatch: ${actual}`)
}
