#!/usr/bin/env node
/**
 * Emit the GitHub Actions matrix of projects affected by a change.
 *
 * Path-filtered so a change in one module does not rebuild the others (ADR 0001).
 * Reads the same scripts/modules.json the boundary check and commitlint read, so the
 * three cannot disagree about which projects exist.
 *
 * usage: ci-matrix.mjs <base-ref>     # empty base ref means "everything"
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, projects, projectOf } from './projects.mjs'

const baseRef = process.argv[2]

// `config` projects (gateway/, infra/) carry a package.json only so the root Makefile
// can call them uniformly. They have no dependencies, no lockfile and no npm tooling —
// the repo workflow validates them with deck and terraform instead. Same filter as
// scripts/for-each-project.mjs, so the two cannot disagree.
const runnable = projects
  .filter((project) => project.kind !== 'config')
  .filter((project) => existsSync(join(ROOT, project.path, 'package.json')))

function affected() {
  if (!baseRef) return runnable
  let changed
  try {
    changed = execSync(`git diff --name-only ${baseRef}...HEAD`, { cwd: ROOT }).toString().trim()
  } catch {
    return runnable
  }
  if (!changed) return []
  const files = changed.split('\n')

  // A change to shared repository machinery affects everything.
  const global = files.some(
    (file) =>
      file.startsWith('scripts/') ||
      file.startsWith('.github/') ||
      ['Makefile', 'lefthook.yml', 'commitlint.config.js'].includes(file),
  )
  if (global) return runnable

  return runnable.filter((project) => files.some((file) => projectOf(file)?.path === project.path))
}

const selected = affected().map((project) => ({
  name: project.path.split('/').pop(),
  path: project.path,
  kind: project.kind,
  containerized: project.kind === 'service' || project.kind === 'frontend',
}))

console.log(JSON.stringify({ include: selected }))
