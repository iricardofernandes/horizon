#!/usr/bin/env node
/**
 * Run an npm script only in projects touched since the upstream branch.
 * Used by the pre-push hook. Falls back to every project when there is no
 * upstream to compare against.
 */
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { ROOT, projectOf, runnableProjects } from './projects.mjs'

const script = process.argv[2] ?? 'test'

function changedFiles() {
  try {
    const base = execSync('git rev-parse --abbrev-ref --symbolic-full-name @{u}', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    return execSync(`git diff --name-only ${base}...HEAD`, { cwd: ROOT }).toString().trim().split('\n')
  } catch {
    return null
  }
}

const files = changedFiles()
const targets =
  files === null
    ? runnableProjects()
    : runnableProjects().filter((project) =>
        files.some((file) => projectOf(file)?.path === project.path),
      )

if (targets.length === 0) {
  console.log('no affected projects')
  process.exit(0)
}

let failed = 0
for (const project of targets) {
  console.log(`\n\x1b[1m▸ ${project.path}\x1b[0m  npm run ${script}`)
  try {
    execSync(`npm run ${script} --if-present`, {
      cwd: join(ROOT, project.path),
      stdio: 'inherit',
      shell: '/bin/bash',
    })
  } catch {
    failed += 1
  }
}
process.exit(failed > 0 ? 1 : 0)
