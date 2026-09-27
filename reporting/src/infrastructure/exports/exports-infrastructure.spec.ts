import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { ExportLinks, LINK_TTL_MS } from './export-links'
import { writeCsv, writeFile, writeXlsx } from './writers'

const metadata = [
  ['report', 'cash-position'],
  ['filter', 'none'],
] as const
const table = {
  columns: ['section', 'key', 'amount'],
  rows: [
    ['receivables', '=HYPERLINK("http://x")', 1500.5],
    ['account', 'Açaí; "quoted"', -2.25],
    ['account', '@SUM(A1)', null],
    ['account', 'bell\u0007 kept', 1],
  ],
}

describe('CSV', () => {
  it('writes pt-BR with a BOM, semicolons, decimal commas and neutralized cells', () => {
    const text = writeCsv(metadata, table, 'pt-BR').toString('utf8')
    expect(text.startsWith('﻿')).toBe(true)
    expect(text.slice(1).split('\r\n')).toEqual([
      'report;cash-position',
      'filter;none',
      '',
      'section;key;amount',
      `receivables;"'=HYPERLINK(""http://x"")";1500,5`,
      'account;"Açaí; ""quoted""";-2,25',
      `account;"'@SUM(A1)";`,
      'account;bell\u0007 kept;1',
      '',
    ])
  })

  it('writes English with commas and decimal points', () => {
    const text = writeFile('csv', metadata, table, 'en').toString('utf8')
    expect(text).toContain('account,"Açaí; ""quoted""",-2.25')
    expect(text).toContain('receivables,"\'=HYPERLINK(""http://x"")",1500.5')
  })
})

describe('XLSX', () => {
  it('is a workbook whose numbers are numbers and whose text can never run', () => {
    const files = unzipSync(new Uint8Array(writeXlsx(metadata, table)))
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ])
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml'] ?? new Uint8Array())
    expect(sheet).toContain('<c r="C5"><v>1500.5</v></c>')
    expect(sheet).toContain(`<t xml:space="preserve">'=HYPERLINK(&quot;http://x&quot;)</t>`)
    expect(sheet).toContain(`<t xml:space="preserve">'@SUM(A1)</t>`)
    expect(sheet).toContain('<c r="A4" t="inlineStr"><is><t xml:space="preserve">section</t>')
    expect(sheet).not.toContain('<f>')
    expect(sheet).toContain('>bell kept</t>')
    expect(writeFile('xlsx', metadata, table, 'pt-BR').subarray(0, 2).toString()).toBe('PK')
  })
})

describe('download links', () => {
  const links = new ExportLinks('s'.repeat(32))
  const tenantId = '0196a1b2-0000-7000-8000-0000000000aa'
  const jobId = '0196a1b2-0000-7000-8000-0000000000bb'
  const now = new Date('2026-09-27T12:00:00Z')

  it('opens one file of one tenant until it expires, and nothing once changed', () => {
    const { path, expiresAt } = links.sign(tenantId, jobId, now)
    expect(expiresAt.getTime() - now.getTime()).toBe(LINK_TTL_MS)
    const query = new URL(path, 'http://x').searchParams
    const link = {
      tenantId,
      jobId,
      expires: Number(query.get('expires')),
      signature: query.get('signature') ?? '',
    }
    expect(links.verify(link, now)).toBe(true)
    expect(links.verify(link, new Date(expiresAt.getTime() + 1))).toBe(false)
    expect(links.verify({ ...link, jobId: tenantId }, now)).toBe(false)
    expect(links.verify({ ...link, tenantId: jobId }, now)).toBe(false)
    expect(links.verify({ ...link, expires: link.expires + 1 }, now)).toBe(false)
    expect(links.verify({ ...link, signature: link.signature.slice(2) }, now)).toBe(false)
    // A link cannot be minted to last longer than a signed one would.
    const far = { ...link, expires: now.getTime() + LINK_TTL_MS * 10 }
    expect(links.verify(far, now)).toBe(false)
    expect(() => new ExportLinks('short')).toThrow(/32/)
  })
})
