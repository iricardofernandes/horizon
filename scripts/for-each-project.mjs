#!/usr/bin/env node
/** Run one shell command in each runnable project, sequentially, failing fast. */
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT, runnableProjects } from './projects.mjs'

const [, , command, ...rest] = process.argv
if (!command) {
  console.error('usage: for-each-project.mjs "<command>" [--kinds service,package]')
  process.exit(2)
}

const kindsFlag = rest.indexOf('--kinds')
const kinds = kindsFlag === -1 ? null : rest[kindsFlag + 1].split(',')

let failed = 0
for (const project of runnableProjects(kinds)) {
  console.log(`\n\x1b[1m▸ ${project.path}\x1b[0m  ${command}`)
  try {
    execSync(command, { cwd: join(ROOT, project.path), stdio: 'inherit', shell: '/bin/bash' })
  } catch {
    failed += 1
    console.error(`\x1b[31m✗ ${project.path}\x1b[0m`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} project(s) failed`)
  process.exit(1)
}
console.log('\nall projects ok')
