#!/usr/bin/env node
/**
 * Verify that every relative link in the repository's Markdown resolves.
 *
 * Documentation is a deliverable here — the ADRs and READMEs cross-reference heavily,
 * and a broken link in a document nobody can run is exactly the kind of rot that goes
 * unnoticed. Cheap to check, so it is checked.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = new Set(['node_modules', 'dist', '.next', '.git', 'coverage', 'build'])

function markdownFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) markdownFiles(full, out)
    else if (entry.endsWith('.md')) out.push(full)
  }
  return out
}

const broken = []

/**
 * Blank out fenced blocks and inline code, keeping the byte offsets intact so reported
 * line numbers stay accurate.
 *
 * Without this, anything link-shaped inside backticks is treated as a link — a regex
 * such as `(?:[01]\d|2[0-3])` in a generated schema table reads as `[01]\d|2[0-3]`
 * followed by a parenthesised target, and the checker fails on documentation that is
 * perfectly correct.
 */
function maskCode(text) {
  const blank = (match) => match.replace(/[^\n]/g, ' ')
  return text.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, blank)
}

for (const file of markdownFiles(ROOT)) {
  const text = maskCode(readFileSync(file, 'utf8'))
  const pattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const target = match[1]
    if (/^(https?:|mailto:|#)/.test(target)) continue

    const [path] = target.split('#')
    if (!path) continue

    const resolved = resolve(dirname(file), path)
    if (!existsSync(resolved)) {
      const line = text.slice(0, match.index).split('\n').length
      broken.push(`${relative(ROOT, file)}:${line}  →  ${target}`)
    }
  }
}

if (broken.length > 0) {
  console.error(`\n${broken.length} broken relative link(s):\n`)
  for (const entry of broken) console.error(`  ${entry}`)
  console.error('')
  process.exit(1)
}

console.log('all relative documentation links resolve')
