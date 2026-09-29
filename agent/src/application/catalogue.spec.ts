import { describe, expect, it } from 'vitest'
import { CATALOGUE, DENIED_ROUTE, DRAFT_ROUTES, requestFor, toolsFor } from './catalogue'

describe('the declared catalogue (ADR 0065)', () => {
  it('names each tool once, and each path belongs to its own module', () => {
    const names = CATALOGUE.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const tool of CATALOGUE) expect(tool.path.startsWith(`/${tool.module}/`)).toBe(true)
  })

  it('takes path parameters only as ids or a closed report name', () => {
    for (const tool of CATALOGUE)
      for (const [, name] of tool.path.matchAll(/\{(\w+)\}/g)) {
        expect(['id', 'name']).toContain(name)
        expect(name === undefined ? undefined : tool.input[name]).toBeDefined()
      }
  })

  it('writes only to the six creation routes, and no tool reaches a decision or access', () => {
    const writes = CATALOGUE.filter((tool) => tool.kind === 'draft')
    expect(writes.map((tool) => tool.path).sort()).toEqual([...DRAFT_ROUTES].sort())
    for (const tool of writes) expect(tool.record).toBeDefined()
    for (const tool of CATALOGUE) expect(tool.path).not.toMatch(DENIED_ROUTE)
  })

  it('names in the deny pattern every kind of decision a module exposes', () => {
    for (const path of [
      '/procurement/requisitions/x/approve',
      '/procurement/requisitions/x/submit',
      '/financial/payables/x/post',
      '/financial/payables/x/settlements',
      '/financial/payables/x/reverse',
      '/treasury/transfers/x/cancel',
      '/sales/quotes/x/convert',
      '/sales/orders/x/confirm',
      '/fiscal/documents/x/transmission',
      '/identity/api-keys',
      '/identity/users/x/roles',
      '/agent/settings',
      '/ledger/manual-entries/x/approve',
      '/inventory/adjustment-policies',
    ])
      expect(path).toMatch(DENIED_ROUTE)
  })
})

describe('toolsFor', () => {
  it('reaches a module with its read or write scope, and nothing else', () => {
    const read = toolsFor(['agent:connect', 'parties:read']).map((tool) => tool.module)
    expect(new Set(read)).toEqual(new Set(['parties']))
    const write = toolsFor(['crm:write']).map((tool) => tool.module)
    expect(new Set(write)).toEqual(new Set(['crm']))
    expect(toolsFor(['crm:read']).some((tool) => tool.kind === 'draft')).toBe(false)
    expect(toolsFor(['crm:write']).filter((tool) => tool.kind === 'draft')).toHaveLength(3)
    expect(toolsFor(['agent:connect'])).toEqual([])
  })
})

describe('requestFor', () => {
  const byName = (name: string) => {
    const tool = CATALOGUE.find((entry) => entry.name === name)
    if (!tool) throw new Error(name)
    return tool
  }

  it('fills path parameters encoded and sends the rest as query', () => {
    const request = requestFor(byName('get_report'), { name: 'cash-position', cutoff: 'x' }, 50)
    expect(request).toEqual({ path: '/reporting/reports/cash-position', query: { cutoff: 'x' } })
    expect(requestFor(byName('get_party'), { id: '../../x' }, 50).path).toBe(
      '/parties/parties/..%2F..%2Fx',
    )
  })

  it('never asks a list for more rows than the cap, and asks for the cap by default', () => {
    expect(requestFor(byName('list_parties'), { limit: 200 }, 50).query).toEqual({ limit: '50' })
    expect(requestFor(byName('list_parties'), {}, 50).query).toEqual({ limit: '50' })
    expect(requestFor(byName('list_quotes'), {}, 50).query).toEqual({})
  })

  it('drops an argument the tool does not declare', () => {
    expect(requestFor(byName('list_quotes'), { status: 'x' }, 50).query).toEqual({})
  })
})
