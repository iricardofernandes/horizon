import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_MAX_BYTES,
  attachmentAbilities,
  contentTypeOf,
  isSettling,
  proxied,
  refusalOf,
  sizeLabel,
  slotRequestOf,
} from './attachments'

describe('attachments on the web', () => {
  it('declares a file by its extension, and refuses what files would refuse', () => {
    expect(contentTypeOf('Contrato.PDF')).toBe('application/pdf')
    expect(contentTypeOf('planilha.xlsx')).toMatch(/spreadsheetml/)
    expect(contentTypeOf('page.html')).toBeNull()
    expect(contentTypeOf('no-extension')).toBeNull()
    expect(refusalOf({ name: 'a.svg', size: 10 })).toBe('type')
    expect(refusalOf({ name: 'a.pdf', size: 0 })).toBe('empty')
    expect(refusalOf({ name: 'a.pdf', size: ATTACHMENT_MAX_BYTES + 1 })).toBe('size')
    expect(refusalOf({ name: 'a.pdf', size: 10 })).toBeNull()
  })

  it('names the record, and its party only outside the party registry', () => {
    const record = {
      module: 'financial' as const,
      recordType: 'payable',
      recordId: 'r',
      ownerPartyId: 'p',
    }
    expect(slotRequestOf(record, { name: 'boleto.pdf', size: 5 })).toMatchObject({
      contentType: 'application/pdf',
      ownerPartyId: 'p',
    })
    expect(
      slotRequestOf(
        { ...record, module: 'parties', recordType: 'party' },
        { name: 'a.pdf', size: 5 },
      ),
    ).not.toHaveProperty('ownerPartyId')
  })

  it('reads and attaches with the owning module role', () => {
    const roles = [{ module: 'procurement', role: 'approver' }]
    expect(attachmentAbilities(roles, 'procurement')).toEqual({ canRead: true, canWrite: false })
    expect(attachmentAbilities(roles, 'financial')).toEqual({ canRead: false, canWrite: false })
  })

  it('polls while a scan is pending, and proxies only files links', () => {
    const row = {
      id: '1',
      fileName: 'a',
      contentType: 'x',
      size: 1,
      finding: null,
      uploadedBy: 'u',
      createdAt: '',
      expiresAt: null,
    }
    expect(isSettling([{ ...row, status: 'scanning' }])).toBe(true)
    expect(isSettling([{ ...row, status: 'available' }])).toBe(false)
    expect(proxied({ method: 'GET', url: '/files/attachments/1/content?x=1', expiresAt: '' })).toBe(
      '/api/horizon/files/attachments/1/content?x=1',
    )
    expect(() => proxied({ method: 'GET', url: 'https://evil.test/', expiresAt: '' })).toThrow()
  })

  it('reads a size in bytes, KB or MB', () => {
    const number = (value: number, digits: number) => value.toFixed(digits)
    expect(sizeLabel(45, number)).toBe('45 B')
    expect(sizeLabel(48_213, number)).toBe('47 KB')
    expect(sizeLabel(3 * 1024 * 1024, number)).toBe('3.0 MB')
  })
})
