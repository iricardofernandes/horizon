import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const projects = JSON.parse(
  readFileSync(join(ROOT, 'scripts/modules.json'), 'utf8'),
).projects

/** Projects that are npm packages — the ones with scripts to run. */
export function runnableProjects(kinds) {
  return projects
    .filter((project) => (kinds ? kinds.includes(project.kind) : project.kind !== 'config'))
    .filter((project) => existsSync(join(ROOT, project.path, 'package.json')))
}

/** Map a repository-relative file path to the project that owns it, or null. */
export function projectOf(file) {
  const normalised = file.replace(/\\/g, '/')
  return (
    projects
      .filter((project) => normalised.startsWith(`${project.path}/`))
      // longest path wins, so tooling/mcp-debugger beats a hypothetical tooling/
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null
  )
}
