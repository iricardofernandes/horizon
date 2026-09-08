#!/usr/bin/env node
/**
 * Contract compatibility gate — see docs/adr/0030-event-naming-envelope-and-versioning.md
 *
 * Compares the current contract schemas against the last published snapshot
 * (`contracts/published-schemas.json`) and fails a breaking change that is not
 * accompanied by the right version bump.
 *
 * This is the load-bearing part of the versioning policy. Everything else about
 * versioning — the table in the README, the rules in the ADR — is documentation until
 * something enforces it, and documentation does not stop a `git push`.
 *
 * The baseline is a committed file rather than a package fetched from a registry, so the
 * check needs no infrastructure: it runs in a fresh checkout, in a sparse checkout, and
 * offline. The snapshot is regenerated at publish time by `npm run release:prepare`;
 * regenerating it *without* bumping the version is exactly what this catches.
 *
 *   node scripts/check-contract-compat.mjs
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACTS = join(ROOT, 'contracts')

import {
  ADDITIVE,
  BREAKING,
  bumpSatisfied,
  diffSchema,
  parseVersion,
  requiredBump,
} from './lib/contract-diff.mjs'

// ---------------------------------------------------------------- run

const snapshotPath = join(CONTRACTS, 'published-schemas.json')
if (!existsSync(snapshotPath)) {
  console.error('no contracts/published-schemas.json — run `npm run schemas:snapshot` in contracts/')
  process.exit(1)
}

const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))

if (!existsSync(join(CONTRACTS, 'dist/index.mjs'))) {
  console.log('building contracts…')
  execSync('npm run build', { cwd: CONTRACTS, stdio: 'inherit' })
}

const { toJsonSchemas } = await import(join(CONTRACTS, 'dist/index.mjs'))
const current = toJsonSchemas()
const currentVersion = JSON.parse(readFileSync(join(CONTRACTS, 'package.json'), 'utf8')).version

const findings = []

for (const id of Object.keys(snapshot.schemas)) {
  if (!(id in current)) {
    // Removing a published schema breaks anything importing it, whatever it contained.
    findings.push({ severity: BREAKING, path: id, message: 'schema removed' })
    continue
  }
  diffSchema(snapshot.schemas[id], current[id], id, findings)
}

for (const id of Object.keys(current)) {
  if (!(id in snapshot.schemas)) {
    findings.push({ severity: ADDITIVE, path: id, message: 'schema added' })
  }
}

const breaking = findings.filter((finding) => finding.severity === BREAKING)
const additive = findings.filter((finding) => finding.severity === ADDITIVE)

const baseline = parseVersion(snapshot.version)
const currentParsed = parseVersion(currentVersion)

console.log(`baseline  v${snapshot.version}  (contracts/published-schemas.json)`)
console.log(`current   v${currentVersion}  (contracts/package.json)\n`)

if (findings.length === 0) {
  console.log('no schema changes')
  process.exit(0)
}

for (const finding of [...breaking, ...additive]) {
  const label = finding.severity === BREAKING ? '\x1b[31mBREAKING\x1b[0m' : '\x1b[33madditive\x1b[0m'
  console.log(`  ${label}  ${finding.path}: ${finding.message}`)
}
console.log('')

const severity = breaking.length > 0 ? BREAKING : ADDITIVE
const position = requiredBump(baseline, severity)

if (bumpSatisfied(baseline, currentParsed, position)) {
  console.log(
    `\x1b[32mok\x1b[0m — ${breaking.length} breaking, ${additive.length} additive; ` +
      `${position} bump present (v${snapshot.version} → v${currentVersion})`,
  )
  process.exit(0)
}

console.error(
  `\x1b[31mfail\x1b[0m — ${breaking.length} breaking, ${additive.length} additive change(s) ` +
    `require a ${position} bump, but the version is still v${currentVersion}.\n`,
)

if (breaking.length > 0) {
  console.error(
    'A published schema is never mutated in place. Either make the change additive, or\n' +
      `publish a new eventVersion and bump the ${position} version, emitting both during a\n` +
      'deprecation window with a declared end date in docs/events.md (ADR 0030).\n',
  )
}

console.error('After deciding, run `npm run release:prepare` in contracts/ to move the baseline.')
process.exit(1)
