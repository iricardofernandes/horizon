import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Every .tsx and .ts file under a directory. */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !name.endsWith('.spec.ts') ? [path] : []
  })
}

describe('useLoader callers (Phase 78)', () => {
  it('never pass an inline function, which would load again on every render', () => {
    // The Developers → Agent page did, and asked the agent some 200 times a minute.
    const offenders = sources(join(__dirname, '..')).filter((path) =>
      /useLoader\(\s*(async\s*)?\(/.test(readFileSync(path, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
