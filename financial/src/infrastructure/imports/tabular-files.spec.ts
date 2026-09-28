import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { ImportJob } from '@/domain/imports/import-job'
import { neutralize, TabularImportFiles, writeXlsx } from './tabular-files'

const files = new TabularImportFiles()
const bytes = (text: string) => new TextEncoder().encode(text)

function read(format: 'csv' | 'xlsx', content: Uint8Array) {
  const parsed = files.read(format, content)
  if (parsed.isLeft()) throw new Error(parsed.value)
  return parsed.value
}

describe('reading a CSV', () => {
  it('finds the separator, strips the BOM and keeps each row with its line', () => {
    const parsed = read('csv', bytes('﻿Nome;Valor\r\nAlfa;1,5\r\n\r\nBeta;2\r\n'))
    expect(parsed.delimiter).toBe(';')
    expect(parsed.columns).toEqual(['Nome', 'Valor'])
    expect(parsed.rows).toEqual([
      { line: 2, cells: ['Alfa', '1,5'] },
      { line: 4, cells: ['Beta', '2'] },
    ])
  })

  it('reads quoted cells with separators, quotes and line breaks', () => {
    const parsed = read('csv', bytes('name,note\n"Alfa, Ltd","said ""hi""\nthen left"\nBeta,x'))
    expect(parsed.delimiter).toBe(',')
    expect(parsed.rows).toEqual([
      { line: 2, cells: ['Alfa, Ltd', 'said "hi"\nthen left'] },
      { line: 4, cells: ['Beta', 'x'] },
    ])
  })

  it('pads short rows, reads Windows-1252 and a tab-separated file', () => {
    const latin = new Uint8Array([0x4e, 0x6f, 0x6d, 0x65, 0x0a, 0x53, 0xe3, 0x6f])
    expect(read('csv', latin).rows[0]?.cells).toEqual(['São'])
    expect(read('csv', bytes('a\tb\n1')).rows[0]?.cells).toEqual(['1', ''])
  })

  it('refuses an empty file, a blank header and repeated headers', () => {
    expect(files.read('csv', bytes('\n\n')).isLeft()).toBe(true)
    expect(files.read('csv', bytes('a;;b\n1;2;3')).isLeft()).toBe(true)
    expect(files.read('csv', bytes('a;a\n1;2')).isLeft()).toBe(true)
  })
})

describe('reading an XLSX', () => {
  it('reads back a workbook this module writes', () => {
    const workbook = writeXlsx(
      [
        ['Nome', 'Valor', 'Data'],
        ['Alfa & Cia', '1234.5', '46293'],
        ['', '', ''],
        ['Beta <b>', '-2', ''],
      ],
      'Plan',
    )
    const parsed = read('xlsx', workbook)
    expect(parsed.columns).toEqual(['Nome', 'Valor', 'Data'])
    expect(parsed.rows).toEqual([
      { line: 2, cells: ['Alfa & Cia', '1234.5', '46293'] },
      { line: 4, cells: ['Beta <b>', '-2', ''] },
    ])
  })

  it('reads shared strings, booleans and sparse cells of a spreadsheet program', () => {
    const xml = (body: string) => strToU8(`<?xml version="1.0"?>${body}`)
    const workbook = zipSync({
      'xl/workbook.xml': xml(
        '<workbook><sheets><sheet name="A" sheetId="1" r:id="rId7"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': xml(
        '<Relationships><Relationship Target="worksheets/sheet9.xml" Id="rId7" Type="x"/></Relationships>',
      ),
      'xl/sharedStrings.xml': xml(
        '<sst><si><t>Nome</t></si><si><r><t>Ativo</t></r></si><si><t>Jo&#227;o</t><rPh><t>x</t></rPh></si></sst>',
      ),
      'xl/worksheets/sheet9.xml': xml(
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Idade</t></is></c><c r="C1" t="s"><v>1</v></c></row>' +
          '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="C3" t="b"><v>1</v></c></row></sheetData></worksheet>',
      ),
    })
    const parsed = read('xlsx', workbook)
    expect(parsed.columns).toEqual(['Nome', 'Idade', 'Ativo'])
    expect(parsed.rows).toEqual([{ line: 3, cells: ['João', '', 'true'] }])
  })

  it('refuses a file that is not a workbook', () => {
    expect(files.read('xlsx', bytes('not a zip')).isLeft()).toBe(true)
    expect(files.read('xlsx', zipSync({ 'a.txt': strToU8('a') })).isLeft()).toBe(true)
  })
})

describe('the failures file', () => {
  const job = {
    fileName: 'clientes.csv',
    format: 'csv',
    locale: 'pt-BR',
    delimiter: ';',
    columns: ['Nome', 'Doc'],
  } as unknown as ImportJob
  const rows = [
    {
      line: 3,
      cells: ['=HYPERLINK("x")', '1;2'],
      state: 'invalid' as const,
      issues: [
        { field: 'documentNumber', message: 'a CNPJ has 14 characters' },
        { field: null, message: 'other' },
      ],
      reference: null,
    },
  ]

  it('writes a CSV with the input separator, the line and every reason', () => {
    const file = files.failures(job, rows)
    expect(file.fileName).toBe('clientes-falhas.csv')
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(file.bytes)
    expect(text.startsWith('﻿Nome;Doc;linha;motivo\r\n')).toBe(true)
    expect(text).toContain(
      `"'=HYPERLINK(""x"")";"1;2";3;"documentNumber: a CNPJ has 14 characters; other"`,
    )
  })

  it('writes an XLSX that reads back with the same rows', () => {
    const file = files.failures({ ...job, format: 'xlsx', locale: 'en' }, rows)
    expect(file.fileName).toBe('clientes-failures.xlsx')
    const parsed = read('xlsx', file.bytes)
    expect(parsed.columns).toEqual(['Nome', 'Doc', 'line', 'reason'])
    expect(parsed.rows[0]?.cells.slice(0, 3)).toEqual(['\'=HYPERLINK("x")', '1;2', '3'])
  })

  it('neutralizes formulas but not plain numbers', () => {
    expect(neutralize('-12,5')).toBe('-12,5')
    expect(neutralize('-x')).toBe("'-x")
    expect(neutralize('@a')).toBe("'@a")
    expect(neutralize('+1 555')).toBe("'+1 555")
    expect(neutralize('Alfa')).toBe('Alfa')
  })
})
