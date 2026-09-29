#!/usr/bin/env node
/**
 * Who may read an attachment is declared twice, because modules share no source (ADR 0001):
 * in `files/`, which serves the file (`permits`), and in `knowledge/`, which lets the same
 * people find its text (ADR 0067). This check keeps the two read tables equal. It runs on
 * the whole repository, never inside one module's isolated build.
 *
 *   node scripts/check-attachment-readers.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** `module: … read: ['a', 'b']` entries of a declared table, whatever its layout. */
function readRoles(source, start, end, pattern) {
  const from = source.indexOf(start)
  const table = source.slice(from, source.indexOf(end, from + start.length))
  if (from === -1 || !table) throw new Error(`table ${start} not found`)
  return Object.fromEntries(
    [...table.matchAll(pattern)].map(([, module, roles]) => [
      module,
      [...(roles ?? '').matchAll(/'([^']+)'/g)].map(([, role]) => role).sort(),
    ]),
  )
}

const files = readRoles(
  readFileSync(join(root, 'files/src/domain/records.ts'), 'utf8'),
  'const ROLES',
  'export interface',
  /(\w+): \{\s*read: \[([^\]]*)\]/g,
)
const knowledge = readRoles(
  readFileSync(join(root, 'knowledge/src/domain/readers.ts'), 'utf8'),
  'export const READ_ROLES',
  '\n}\n',
  /(\w+): \[([^\]]*)\]/g,
)

const modules = [...new Set([...Object.keys(files), ...Object.keys(knowledge)])].sort()
const drift = modules.filter(
  (module) => JSON.stringify(files[module]) !== JSON.stringify(knowledge[module]),
)
if (!modules.length || drift.length) {
  for (const module of drift)
    console.error(
      `${module}: files/ reads with ${JSON.stringify(files[module] ?? [])}, knowledge/ with ${JSON.stringify(knowledge[module] ?? [])}`,
    )
  console.error('attachment readers differ between files/ and knowledge/')
  process.exit(1)
}
console.log(`attachment readers ok — ${modules.length} modules read alike in files/ and knowledge/`)
