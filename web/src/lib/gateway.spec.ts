import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Every .tsx and .ts file under a directory. */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !name.endsWith('.spec.ts') ? [path] : []
  })
}

describe('calls from the web server to Kong (Phase 80)', () => {
  it('all go through gatewayFetch, so Kong limits each browser by its own address', () => {
    const root = join(__dirname, '..')
    const offenders = sources(root)
      .filter((path) => !path.endsWith(join('lib', 'gateway.ts')))
      .filter((path) => /process\.env\.HORIZON_API_URL\b/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(root, path))
    expect(offenders).toEqual([])
  })
})
