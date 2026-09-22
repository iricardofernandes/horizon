#!/usr/bin/env node
/** Run the repository and project gates from ci.yml/repo.yml before a push. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, runnableProjects } from './projects.mjs'

const failures = []
const services = runnableProjects().filter((project) => project.kind === 'service')
const projects = runnableProjects()
const full = process.argv.includes('--full')
if (process.argv.slice(2).some((argument) => argument !== '--full')) {
  console.error('Usage: node scripts/ci-local.mjs [--full]')
  process.exit(2)
}

function run(label, command, args, cwd = ROOT) {
  console.log(`\n▸ ${label}`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env })
  if (result.status !== 0) {
    failures.push(label)
    console.error(`✗ ${label} (exit ${result.status ?? 'unknown'})`)
  }
}

function digest(path) {
  return createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')
}

if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('CI uses Node 24; run this check with Node 24.')
  process.exit(1)
}

if (full) {
  for (const project of projects)
    run(`${project.path}: clean install`, 'npm', ['ci', '--no-audit', '--no-fund'], join(ROOT, project.path))
}

for (const [label, script] of [
  ['module boundaries', 'check-boundaries.mjs'],
  ['contract pins', 'check-contract-pins.mjs'],
  ['contract compatibility', 'check-contract-compat.mjs'],
  ['documentation links', 'check-doc-links.mjs'],
  ['action references', 'check-action-refs.mjs'],
  ['Terraform apply guard', 'assert-no-terraform-apply.mjs'],
]) run(label, process.execPath, [join(ROOT, 'scripts', script)])
run('secret scan', 'docker', [
  'run', '--rm', '-v', `${ROOT}:/repo`, 'zricethezav/gitleaks:latest',
  'detect', '--source=/repo', '--redact', '--exit-code', '1',
])
run('compatibility analysis tests', process.execPath, ['--test', 'scripts/lib/contract-diff.test.mjs'])

for (const project of projects) {
  for (const script of ['typecheck', 'lint', 'test', 'build'])
    run(`${project.path}: ${script}`, 'npm', ['run', script, '--if-present'], join(ROOT, project.path))
}

for (const project of services)
  run(`${project.path}: test:e2e`, 'npm', ['run', 'test:e2e', '--if-present'], join(ROOT, project.path))

for (const [path, script] of [
  ['docs/events.md', 'docs:events'],
  ['contracts/published-schemas.json', 'schemas:snapshot'],
]) {
  const before = digest(path)
  run(`generated ${path}`, 'npm', ['run', script], join(ROOT, 'contracts'))
  if (digest(path) !== before) {
    failures.push(`generated ${path} changed`)
    console.error(`✗ ${path} changed during generation; include the regenerated file.`)
  }
}

run('git whitespace check', 'git', ['diff', '--check'])

if (full) {
  run('Docker images', 'docker', [
    'compose', '-f', 'infra/docker-compose.yml', '-f', 'infra/docker-compose.apps.yml',
    '--profile', 'fiscal', 'build',
    'identity', 'catalog', 'inventory', 'sales', 'webhooks', 'parties',
    'financial', 'treasury', 'ledger', 'procurement', 'fiscal', 'web',
  ])
}

if (failures.length > 0) {
  console.error(`\nLocal CI failed: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  console.log('\nLocal code and integration gates passed.')
  if (full) console.log('Clean npm installs and Docker image builds passed.')
  else console.log('Use --full for clean npm installs and Docker image builds.')
  console.log('The browser golden path, gateway and Terraform still run in their own CI jobs.')
}
