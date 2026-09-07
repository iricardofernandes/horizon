#!/usr/bin/env node
/**
 * Verify that every `uses:` reference in every workflow resolves to a real tag.
 *
 * GitHub resolves action references during "Set up job", before any step-level `if` is
 * evaluated — so a single bad ref fails the whole job even when the step that needs it
 * would have been skipped. The failure message points at the action, not at the typo,
 * and it only appears after a push.
 *
 * This turned up twice while setting the workflows up (a version that did not exist,
 * then the same version without its `v` prefix), which is twice more than it should
 * take to write the check.
 *
 * Needs no token for public repositories; uses GITHUB_TOKEN when present to avoid the
 * unauthenticated rate limit.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOWS = join(ROOT, '.github/workflows')

if (!existsSync(WORKFLOWS)) {
  console.log('no workflows directory')
  process.exit(0)
}

const refs = new Map()
for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
  const text = readFileSync(join(WORKFLOWS, file), 'utf8')
  for (const match of text.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@([\w.-]+)/g)) {
    const [, repository, ref] = match
    const key = `${repository}@${ref}`
    if (!refs.has(key)) refs.set(key, { repository, ref, files: new Set() })
    refs.get(key).files.add(file)
  }
}

const headers = { 'user-agent': 'horizon-ci-check' }
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`

const broken = []

for (const [key, { repository, ref, files }] of refs) {
  const candidates = [
    `https://api.github.com/repos/${repository}/git/ref/tags/${ref}`,
    `https://api.github.com/repos/${repository}/git/ref/heads/${ref}`,
    `https://api.github.com/repos/${repository}/commits/${ref}`,
  ]

  let resolved = false
  for (const url of candidates) {
    const response = await fetch(url, { headers })
    if (response.ok) {
      resolved = true
      break
    }
    if (response.status === 403 || response.status === 429) {
      console.error(`rate limited while checking ${key} — skipping the rest`)
      process.exit(0)
    }
  }

  if (resolved) console.log(`  ok    ${key}`)
  else broken.push(`${key}  (referenced by ${[...files].join(', ')})`)
}

if (broken.length > 0) {
  console.error(`\n${broken.length} unresolvable action reference(s):\n`)
  for (const entry of broken) console.error(`  ${entry}`)
  console.error('\nA bad reference fails the job at set-up, before any `if` is evaluated.\n')
  process.exit(1)
}

console.log(`\nall ${refs.size} action references resolve`)
