#!/usr/bin/env node
/**
 * Assert that no GitHub Actions workflow can apply Terraform.
 *
 * The Terraform in this repository is written and never applied (ADR 0034). That claim
 * is only worth making if something enforces it, and the enforcement has to survive
 * someone adding a deploy job in good faith.
 *
 * Lives in a script rather than inline in the workflow because an inline grep matches
 * its own error message — which is how the first version of this check failed.
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

const offences = []

for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
  const lines = readFileSync(join(WORKFLOWS, file), 'utf8').split('\n')
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (line.startsWith('#')) return
    // Reporting the rule is not breaking it.
    if (/\becho\b/.test(line)) return
    // Word boundaries that exclude hyphens, so a filename such as
    // assert-no-terraform-apply.mjs is not mistaken for the command it guards against.
    if (/(?<![-\w])terraform(?![-\w])[^\n]*(?<![-\w])apply(?![-\w])/i.test(line)) {
      offences.push(`${file}:${index + 1}  ${line}`)
    }
  })
}

if (offences.length > 0) {
  console.error('\nA workflow can apply Terraform. See docs/adr/0034-terraform-written-but-never-applied.md\n')
  for (const offence of offences) console.error(`  ${offence}`)
  console.error('')
  process.exit(1)
}

console.log('no workflow can apply terraform')
