#!/usr/bin/env node
/**
 * Fails when a component carries user-visible copy inline instead of a message key.
 *
 * Localization stops at the presentation boundary (ADR 0044): everything a reader sees
 * comes from `messages/*.json`. This check is deliberately literal — it looks for text
 * nodes and copy-bearing attributes written as string literals inside `src/`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const COPY_ATTRIBUTES = [
  'label',
  'placeholder',
  'description',
  'title',
  'copy',
  'submitLabel',
  'eyebrow',
  'note',
  'alt',
  'aria-label',
]

/** Values that are data, a code or a symbol — never sentences shown to a reader. */
const ALLOWED = new Set([
  'BRL',
  'H',
  'NCM',
  'SKU-001',
  'UN',
  'Horizon',
  '—',
  '·',
  '0.00',
  '0901.21.00',
  '+55 11 99999-0000',
  'Horizon-demo-2026!',
  'demo@horizon.local',
  'https://example.com/horizon',
])

const files = []
;(function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (path.endsWith('.tsx')) files.push(path)
  }
})('src')

const findings = []
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    const report = (value) => findings.push(`${file}:${index + 1}  ${value.trim()}`)

    for (const attribute of COPY_ATTRIBUTES) {
      const match = new RegExp(`(?:^|\\s)${attribute}="([^"]*)"`).exec(line)
      const value = match?.[1]
      if (value && !ALLOWED.has(value) && /\p{L}{2}/u.test(value)) report(`${attribute}="${value}"`)
    }

    // A text node: characters between an opening and a closing tag on the same line.
    // Requiring the closing `</` keeps TypeScript generics (`Promise<void>`) out.
    for (const match of line.matchAll(/>([^<>{}]+)<\//g)) {
      const value = match[1]?.trim() ?? ''
      if (!value || ALLOWED.has(value) || !/\p{L}{2}/u.test(value)) continue
      report(value)
    }
  })
}

if (findings.length) {
  console.error('User-visible copy must come from messages/*.json (ADR 0044):\n')
  for (const finding of findings) console.error(`  ${finding}`)
  console.error(`\n${findings.length} inline strings found.`)
  process.exit(1)
}
console.log(`ui copy ok — ${files.length} components carry no inline copy`)
