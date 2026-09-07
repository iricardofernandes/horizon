/**
 * Conventional Commits — see docs/adr/0015-conventional-commits-lefthook-commitlint.md
 *
 * Scopes are project names, read from scripts/modules.json so this file and the
 * boundary check cannot disagree about which projects exist.
 */
import { readFileSync } from 'node:fs'

const { projects } = JSON.parse(readFileSync(new URL('./scripts/modules.json', import.meta.url), 'utf8'))

const scopes = [
  ...projects.map((project) => project.path.split('/').pop()),
  'docs',
  'ci',
  'deps',
  'repo',
]

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'perf', 'ci']],
    'scope-enum': [2, 'always', scopes],
    'scope-empty': [2, 'never'],
    'subject-case': [2, 'always', 'lower-case'],
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [2, 'always', 100],
  },
}
