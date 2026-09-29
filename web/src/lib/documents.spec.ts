import { describe, expect, it } from 'vitest'
import { canSearchDocuments, documentSearchPath, excerptLine } from './documents'

describe('document search (Phase 75)', () => {
  it('is offered to whoever reads the attachments of some module', () => {
    expect(canSearchDocuments([{ module: 'financial', role: 'viewer' }])).toBe(true)
    expect(canSearchDocuments([{ module: 'parties', role: 'fiscal-reader' }])).toBe(false)
    expect(canSearchDocuments([{ module: 'identity', role: 'owner' }])).toBe(false)
  })

  it('asks the proxied knowledge search, for the workspace or one record', () => {
    expect(documentSearchPath('  nota fiscal ', { limit: 5 })).toBe(
      '/api/horizon/knowledge/search?q=nota+fiscal&limit=5',
    )
    expect(
      documentSearchPath('contrato', {
        record: { module: 'parties', recordType: 'party', recordId: 'p1' },
      }),
    ).toBe('/api/horizon/knowledge/search?q=contrato&module=parties&recordType=party&recordId=p1')
    expect(documentSearchPath('x'.repeat(300))).toHaveLength(
      '/api/horizon/knowledge/search?q='.length + 200,
    )
  })

  it('shows an excerpt on one line, cut on a word', () => {
    expect(excerptLine('Contrato\nde   fornecimento')).toBe('Contrato de fornecimento')
    expect(excerptLine('palavra '.repeat(30), 20)).toBe('palavra palavra…')
  })
})
