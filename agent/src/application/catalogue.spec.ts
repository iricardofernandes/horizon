import { describe, expect, it } from 'vitest'
import { CATALOGUE, requestFor, toolsFor } from './catalogue'

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

  it('has no tool that could reach a write, an approval or access', () => {
    for (const tool of CATALOGUE)
      expect(tool.path).not.toMatch(
        /approve|reject|cancel|reverse|settle|post|confirm|issue|api-keys|roles|settings|imports|exports|erase/,
      )
  })
})

describe('toolsFor', () => {
  it('reaches a module with its read or write scope, and nothing else', () => {
    const read = toolsFor(['agent:connect', 'parties:read']).map((tool) => tool.module)
    expect(new Set(read)).toEqual(new Set(['parties']))
    const write = toolsFor(['crm:write']).map((tool) => tool.module)
    expect(new Set(write)).toEqual(new Set(['crm']))
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
