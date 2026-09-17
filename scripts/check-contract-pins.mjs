#!/usr/bin/env node
/**
 * Every project that depends on `@horizon/contracts` pins the version in `contracts/`.
 *
 * CI publishes exactly one contracts version — the one in this checkout — to a throwaway
 * registry per job (scripts/ci-publish-contracts.sh). A project pinned to an older version
 * installs fine on a developer machine whose local registry still holds it, and fails with
 * a 404 in every CI job. Checking the pins here turns that into a fast, local failure.
 *
 *   node scripts/check-contract-pins.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))

const expected = read(join(ROOT, 'contracts/package.json')).version
const { projects } = read(join(ROOT, 'scripts/modules.json'))
const drift = []

for (const { path } of projects) {
  const manifest = join(ROOT, path, 'package.json')
  if (!existsSync(manifest)) continue
  const { dependencies = {}, devDependencies = {} } = read(manifest)
  const pinned = dependencies['@horizon/contracts'] ?? devDependencies['@horizon/contracts']
  if (pinned === undefined) continue
  const lock = join(ROOT, path, 'package-lock.json')
  const locked = existsSync(lock)
    ? read(lock).packages?.['node_modules/@horizon/contracts']?.version
    : undefined
  if (pinned !== expected || (locked !== undefined && locked !== expected))
    drift.push(`${path}: package.json ${pinned}, lockfile ${locked ?? 'absent'}`)
}

if (drift.length > 0) {
  console.error(`@horizon/contracts is ${expected}, but these projects pin another version:\n`)
  for (const line of drift) console.error(`  ${line}`)
  console.error('\nCI publishes only the current version; move them to it before pushing.')
  process.exit(1)
}
console.log(`contract pins ok — every consumer pins @horizon/contracts@${expected}`)
