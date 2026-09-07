#!/usr/bin/env node
/**
 * Module boundary check — see docs/adr/0002-mechanical-enforcement-of-module-boundaries.md
 *
 * Verifies, without depending on the TypeScript compiler:
 *   1. no import resolves outside its own project directory
 *   2. no project declares a `file:` or `link:` dependency
 *   3. every top-level directory holding a package.json is declared in modules.json
 *   4. src/domain/ imports nothing from application/, infrastructure/, main/,
 *      @nestjs/*, drizzle-orm, zod or @horizon/*
 *   5. toSnapshot() is referenced only from infrastructure/ and test/
 *   6. no bare import of a package absent from the project's own package.json
 *
 * Exits non-zero on any violation. No dependencies; runs on plain Node.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinModules } from 'node:module'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { projects } = JSON.parse(readFileSync(join(ROOT, 'scripts/modules.json'), 'utf8'))

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.jsx'])
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.next', 'coverage', '.git', 'build'])
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

const DOMAIN_FORBIDDEN_PACKAGES = [/^@nestjs\//, /^drizzle-orm/, /^zod$/, /^@horizon\//, /^@casl\//]
const DOMAIN_FORBIDDEN_LAYERS = ['application', 'infrastructure', 'main']

const violations = []

function fail(file, line, rule, message) {
  violations.push({ file: relative(ROOT, file), line, rule, message })
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRECTORIES.has(entry)) continue
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) walk(full, out)
    else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) out.push(full)
  }
  return out
}

/** Import specifiers with their 1-based line numbers. */
function readImports(file) {
  const text = readFileSync(file, 'utf8')
  const pattern =
    /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|(?:^|[^.\w])require\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[^.\w])import\(\s*['"]([^'"]+)['"]\s*\)/g
  const found = []
  let match
  while ((match = pattern.exec(text)) !== null) {
    const specifier = match[1] ?? match[2] ?? match[3]
    // Offset to the specifier itself: the pattern may start at the preceding newline,
    // which would otherwise report the line before the import.
    const offset = match.index + match[0].indexOf(specifier)
    const line = text.slice(0, offset).split('\n').length
    found.push({ specifier, line })
  }
  return { text, imports: found }
}

function packageNameOf(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

// ---------------------------------------------------------------- rule 3
const declared = new Set(projects.map((p) => p.path))
for (const entry of readdirSync(ROOT)) {
  if (SKIP_DIRECTORIES.has(entry) || entry.startsWith('.')) continue
  const full = join(ROOT, entry)
  if (!statSync(full).isDirectory()) continue
  if (existsSync(join(full, 'package.json')) && !declared.has(entry)) {
    fail(join(full, 'package.json'), 1, 'undeclared-project',
      `directory "${entry}" holds a package.json but is not declared in scripts/modules.json`)
  }
  // one level deeper, for container directories such as tooling/
  if (!existsSync(join(full, 'package.json'))) {
    for (const nested of readdirSync(full)) {
      const nestedFull = join(full, nested)
      if (!statSync(nestedFull).isDirectory()) continue
      if (existsSync(join(nestedFull, 'package.json')) && !declared.has(`${entry}/${nested}`)) {
        fail(join(nestedFull, 'package.json'), 1, 'undeclared-project',
          `directory "${entry}/${nested}" holds a package.json but is not declared in scripts/modules.json`)
      }
    }
  }
}

// ------------------------------------------------------- rules 1, 2, 4, 5, 6
for (const project of projects) {
  const projectRoot = join(ROOT, project.path)
  if (!existsSync(projectRoot)) continue

  // rule 2 + the dependency inventory rule 6 needs
  const manifestPath = join(projectRoot, 'package.json')
  const declaredDependencies = new Set()
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        declaredDependencies.add(name)
        if (typeof range === 'string' && (range.startsWith('file:') || range.startsWith('link:'))) {
          fail(manifestPath, 1, 'filesystem-dependency',
            `"${name}": "${range}" couples projects through the filesystem — publish a version instead (ADR 0029)`)
        }
      }
    }
  }

  for (const file of [...walk(join(projectRoot, 'src')), ...walk(join(projectRoot, 'test'))]) {
    const { text, imports } = readImports(file)
    const inDomain = relative(projectRoot, file).startsWith(`src${sep}domain${sep}`)
    const inInfrastructure = relative(projectRoot, file).startsWith(`src${sep}infrastructure${sep}`)
    const inTest = relative(projectRoot, file).startsWith(`test${sep}`)

    for (const { specifier, line } of imports) {
      // rule 1 — relative imports must stay inside the project
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier)
        if (relative(projectRoot, target).startsWith('..')) {
          fail(file, line, 'cross-project-import',
            `"${specifier}" resolves outside ${project.path}/`)
        }
      }

      // rule 4 — the dependency rule, inward only
      if (inDomain) {
        for (const layer of DOMAIN_FORBIDDEN_LAYERS) {
          const hitsAlias = specifier.startsWith(`@/${layer}/`) || specifier === `@/${layer}`
          const hitsRelative =
            specifier.startsWith('.') &&
            relative(projectRoot, resolve(dirname(file), specifier)).startsWith(`src${sep}${layer}${sep}`)
          if (hitsAlias || hitsRelative) {
            fail(file, line, 'domain-depends-outward',
              `domain/ must not import from ${layer}/ ("${specifier}")`)
          }
        }
        for (const forbidden of DOMAIN_FORBIDDEN_PACKAGES) {
          if (forbidden.test(specifier)) {
            fail(file, line, 'domain-depends-on-framework',
              `domain/ must not import "${specifier}" — it stays free of framework and schema libraries`)
          }
        }
      }

      // rule 6 — no phantom dependencies
      if (!specifier.startsWith('.') && !specifier.startsWith('@/') && !specifier.startsWith('test/')) {
        const packageName = packageNameOf(specifier)
        if (
          !NODE_BUILTINS.has(specifier) &&
          !NODE_BUILTINS.has(packageName) &&
          !declaredDependencies.has(packageName)
        ) {
          fail(file, line, 'phantom-dependency',
            `"${packageName}" is imported but absent from ${project.path}/package.json`)
        }
      }
    }

    // rule 5 — snapshots leave the aggregate only at the boundary
    if (!inInfrastructure && !inTest) {
      const snapshotPattern = /\.toSnapshot\(/g
      let match
      while ((match = snapshotPattern.exec(text)) !== null) {
        const line = text.slice(0, match.index).split('\n').length
        fail(file, line, 'snapshot-outside-boundary',
          'toSnapshot() may only be called from infrastructure/ or test/ (ADR 0031)')
      }
    }
  }
}

// ---------------------------------------------------------------- report
if (violations.length === 0) {
  console.log(`boundaries ok — ${projects.length} projects checked`)
  process.exit(0)
}

const byRule = new Map()
for (const violation of violations) {
  if (!byRule.has(violation.rule)) byRule.set(violation.rule, [])
  byRule.get(violation.rule).push(violation)
}

console.error(`\n${violations.length} boundary violation(s):\n`)
for (const [rule, entries] of byRule) {
  console.error(`  ${rule}`)
  for (const entry of entries) console.error(`    ${entry.file}:${entry.line}  ${entry.message}`)
  console.error('')
}
process.exit(1)
