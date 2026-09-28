import { describe, expect, it } from 'vitest'
import { entryForPath, visibleNavigation } from './navigation'

describe('the CRM navigation group', () => {
  it('appears for any CRM role and not without one (ADR 0045)', () => {
    const withCrm = visibleNavigation([{ module: 'crm', role: 'viewer' }], false)
    expect(
      withCrm.find((group) => group.labelKey === 'crm')?.entries.map((entry) => entry.labelKey),
    ).toEqual(['pipeline', 'accounts', 'agenda', 'forecast', 'crmSettings'])
    const without = visibleNavigation([{ module: 'sales', role: 'admin' }], false)
    expect(without.some((group) => group.labelKey === 'crm')).toBe(false)
    expect(
      visibleNavigation([{ module: 'crm', role: 'admin' }], true).some(
        (group) => group.labelKey === 'crm',
      ),
    ).toBe(false)
  })

  it('resolves a CRM route to its entry', () => {
    expect(entryForPath('/app/crm/pipeline')?.labelKey).toBe('pipeline')
    expect(entryForPath('/app/crm/accounts')?.labelKey).toBe('accounts')
  })
})

describe('the imports screen', () => {
  it('sits under Administration, and the screen itself narrows it to administered modules', () => {
    const administration = visibleNavigation([{ module: 'catalog', role: 'admin' }], false).find(
      (group) => group.labelKey === 'administration',
    )
    expect(administration?.entries.map((entry) => entry.labelKey)).toContain('imports')
    expect(entryForPath('/app/administration/imports')?.labelKey).toBe('imports')
    expect(
      visibleNavigation([], true)
        .flatMap((group) => group.entries)
        .some((entry) => entry.labelKey === 'imports'),
    ).toBe(false)
  })
})

describe('the Phase 70 screens', () => {
  it('show reports to a Reporting role, and controls under Administration', () => {
    const entries = (roles: { module: string; role: string }[]) =>
      visibleNavigation(roles, false).flatMap((group) =>
        group.entries.map((entry) => entry.labelKey),
      )
    expect(entries([{ module: 'reporting', role: 'viewer' }])).toContain('crossReports')
    expect(entries([{ module: 'sales', role: 'admin' }])).not.toContain('crossReports')
    expect(entries([])).toContain('controls')
    expect(entryForPath('/app/reports')?.labelKey).toBe('crossReports')
    expect(entryForPath('/app/settings/controls')?.labelKey).toBe('controls')
    expect(
      visibleNavigation([], true)
        .flatMap((group) => group.entries)
        .some((entry) => entry.labelKey === 'controls'),
    ).toBe(false)
  })
})
