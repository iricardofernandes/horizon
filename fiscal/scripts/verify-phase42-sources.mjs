import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const fiscalRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = resolve(fiscalRoot, '..')
const manifestPath = resolve(repositoryRoot, 'docs/fiscal-phase42-source-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

if (manifest.schemaVersion !== 1 || manifest.phase !== 42 || !Array.isArray(manifest.artifacts)) {
  throw new Error('Invalid Phase 42 source manifest')
}

for (const artifact of manifest.artifacts) {
  const path = resolve(repositoryRoot, artifact.storagePath)
  const bytes = readFileSync(path)
  verifyBytes(artifact.id, bytes, artifact.byteSize, artifact.sha256)
  if (artifact.testFixturePath) {
    const fixture = readFileSync(resolve(repositoryRoot, artifact.testFixturePath))
    verifyBytes(`${artifact.id}:test-fixture`, fixture, artifact.byteSize, artifact.sha256)
  }
  for (const entry of artifact.entries ?? []) {
    const entryBytes = execFileSync('unzip', ['-p', path, entry.path], {
      cwd: dirname(path),
      maxBuffer: 2 * 1024 * 1024,
    })
    verifyBytes(`${artifact.id}:${entry.path}`, entryBytes, entry.byteSize, entry.sha256)
  }
}

console.log(`Phase 42 sources verified: ${manifest.artifacts.length} artifacts`)

function verifyBytes(label, bytes, expectedSize, expectedDigest) {
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== expectedSize || digest !== expectedDigest) {
    throw new Error(
      `${label} mismatch: expected ${expectedSize}/${expectedDigest}, got ${bytes.length}/${digest}`,
    )
  }
}
