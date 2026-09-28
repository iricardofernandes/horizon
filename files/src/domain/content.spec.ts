import { describe, expect, it } from 'vitest'
import { asciiFileName, encodedFileName, matchesType, safeFileName } from './content'

const bytes = (...values: number[]) => new Uint8Array(values)
const text = (value: string) => new TextEncoder().encode(value)

describe('the first bytes against the declared type', () => {
  it('recognises each accepted type', () => {
    expect(matchesType('application/pdf', text('%PDF-1.4'))).toBe(true)
    expect(matchesType('image/png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(
      true,
    )
    expect(matchesType('image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true)
    expect(matchesType('image/gif', text('GIF89a...'))).toBe(true)
    expect(matchesType('image/gif', text('GIF87a...'))).toBe(true)
    expect(matchesType('image/webp', text('RIFF1234WEBPVP8 '))).toBe(true)
    expect(matchesType('text/csv', text('a;b\n1;2'))).toBe(true)
    expect(matchesType('text/plain', text('olá'))).toBe(true)
    expect(
      matchesType(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes(0x50, 0x4b, 0x03, 0x04),
      ),
    ).toBe(true)
    expect(
      matchesType(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes(0x50, 0x4b, 0x03, 0x04),
      ),
    ).toBe(true)
  })

  it('refuses a label the bytes do not bear out', () => {
    expect(matchesType('application/pdf', text('<html>'))).toBe(false)
    expect(matchesType('image/png', text('%PDF-'))).toBe(false)
    expect(matchesType('image/webp', text('RIFF1234WAVE'))).toBe(false)
    expect(matchesType('text/plain', bytes(0x61, 0x00, 0x62))).toBe(false)
    expect(matchesType('text/csv', bytes(0xc3, 0x28))).toBe(false)
  })
})

describe('file names in a header', () => {
  it('keeps letters and digits, and replaces anything that could break the header', () => {
    expect(safeFileName('Contrato São Paulo (v2).pdf')).toBe('Contrato São Paulo (v2).pdf')
    expect(safeFileName('a"b\r\nc;d.pdf')).toBe('a_b__c_d.pdf')
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd')
    expect(safeFileName('...')).toBe('attachment')
  })

  it('reduces the name to ASCII for old clients', () => {
    expect(asciiFileName('Relatório Técnico.pdf')).toBe('Relatorio Tecnico.pdf')
    expect(asciiFileName('合同.pdf')).toBe('__.pdf')
  })

  it('encodes the UTF-8 name for filename*, parentheses included', () => {
    expect(encodedFileName('Relatório (v2).pdf')).toBe('Relat%C3%B3rio%20%28v2%29.pdf')
  })
})
