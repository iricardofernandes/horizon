import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ATTACHING_MODULES, READ_ROLES, readableModules, screenOf } from './readers'

/** `files/`'s own table, read from its source: the copy must not drift from it. */
function filesReadRoles(): Record<string, string[]> {
  const source = readFileSync(join(__dirname, '../../../files/src/domain/records.ts'), 'utf8')
  const table = source.slice(source.indexOf('const ROLES'), source.indexOf('export interface'))
  return Object.fromEntries(
    [...table.matchAll(/(\w+): \{\s*read: \[([^\]]*)\]/g)].map(([, module, roles]) => [
      module,
      [...(roles ?? '').matchAll(/'([^']+)'/g)].map(([, role]) => role ?? ''),
    ]),
  )
}

describe('who may find a chunk (ADR 0067)', () => {
  it('reads with exactly the roles files/ reads attachments with', () => {
    expect(filesReadRoles()).toEqual(READ_ROLES)
  })

  it('searches the modules a read role reaches, and nothing for a write-only or other role', () => {
    expect(
      readableModules([
        { module: 'financial', role: 'viewer' },
        { module: 'crm', role: 'representative' },
        { module: 'parties', role: 'fiscal-reader' },
        { module: 'identity', role: 'owner' },
      ]),
    ).toEqual(['financial', 'crm'])
    expect(readableModules([])).toEqual([])
  })

  it('narrows a key’s token to the modules its scopes reach, as the caller decides it', () => {
    const roles = ATTACHING_MODULES.map((module) => ({ module, role: 'admin' }))
    expect(readableModules(roles, (module) => module === 'parties' || module === 'crm')).toEqual([
      'parties',
      'crm',
    ])
    expect(readableModules(roles, () => false)).toEqual([])
    expect(readableModules(roles)).toEqual([...ATTACHING_MODULES])
  })

  it('links each attachable record to the screen that reads it', () => {
    expect(screenOf('financial', 'payable', 'p/1')).toBe('/app/finance/payables?open=p%2F1')
    expect(screenOf('crm', 'opportunity', 'o')).toBe('/app/crm/pipeline?open=o')
    expect(screenOf('parties', 'party', 'x')).toBe('/app/registrations/parties')
    expect(screenOf('procurement', 'purchase-order', 'x')).toBe('/app/purchasing/orders')
    expect(screenOf('sales', 'service-order', 'x')).toBe('/app/sales/service-orders')
    expect(screenOf('financial', 'receivable', 'r')).toBe('/app/finance/receivables?open=r')
    expect(screenOf('other', 'thing', 'x')).toBe('/app')
  })
})
