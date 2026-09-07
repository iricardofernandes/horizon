#!/usr/bin/env node
/**
 * Run a check only in the projects that own the staged files.
 * Used by the pre-commit hook so committing to docs/ costs nothing.
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ROOT, projectOf } from './projects.mjs'

const [, , task, ...files] = process.argv
if (!task) {
  console.error('usage: staged-by-project.mjs <biome|typecheck> <files...>')
  process.exit(2)
}

const byProject = new Map()
for (const file of files) {
  const repoRelative = relative(ROOT, file.startsWith('/') ? file : join(ROOT, file))
  const project = projectOf(repoRelative)
  if (!project) continue
  if (!existsSync(join(ROOT, project.path, 'package.json'))) continue
  if (!byProject.has(project.path)) byProject.set(project.path, [])
  byProject.get(project.path).push(relative(project.path, repoRelative))
}

let failed = 0
for (const [projectPath, projectFiles] of byProject) {
  const command =
    task === 'biome'
      ? `npx biome check --write --no-errors-on-unmatched ${projectFiles.map((f) => `'${f}'`).join(' ')}`
      : 'npm run typecheck'
  console.log(`▸ ${projectPath}  ${task}`)
  try {
    execSync(command, { cwd: join(ROOT, projectPath), stdio: 'inherit', shell: '/bin/bash' })
  } catch {
    failed += 1
  }
}

process.exit(failed > 0 ? 1 : 0)
