import { strToU8, zipSync } from 'fflate'
import {
  type Cell,
  type ExportFormat,
  type ExportLocale,
  neutralize,
  type Table,
} from '@/domain/exports'

/** The rows above the table: what was exported, as of when, and under which filter. */
export type Metadata = readonly (readonly [string, string])[]

const BOM = '﻿'

function csvCell(cell: Cell, locale: ExportLocale, separator: string): string {
  if (cell === null) return ''
  if (typeof cell === 'number') {
    const text = String(cell)
    return locale === 'pt-BR' ? text.replace('.', ',') : text
  }
  const text = neutralize(cell)
  const quoted = text.includes(separator) || /["\r\n]/.test(text) || text !== cell
  return quoted ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * CSV in UTF-8 with a BOM, so a spreadsheet reads the accents right: `;` and a decimal
 * comma in pt-BR, `,` and a decimal point in English. A neutralized cell is also quoted,
 * so the apostrophe survives a round trip.
 */
export function writeCsv(metadata: Metadata, table: Table, locale: ExportLocale): Buffer {
  const separator = locale === 'pt-BR' ? ';' : ','
  const line = (cells: readonly Cell[]) =>
    cells.map((cell) => csvCell(cell, locale, separator)).join(separator)
  const lines = [
    ...metadata.map(([key, value]) => line([key, value])),
    '',
    line(table.columns),
    ...table.rows.map(line),
  ]
  return Buffer.from(`${BOM}${lines.join('\r\n')}\r\n`, 'utf8')
}

/** Characters XML 1.0 cannot carry are dropped rather than corrupting the sheet. */
function xmlSafe(text: string): string {
  return [...text]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
    })
    .join('')
}

function xml(text: string): string {
  return xmlSafe(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function column(index: number): string {
  let name = ''
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26))
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name
  return name
}

function xlsxCell(cell: Cell, reference: string): string {
  if (cell === null) return ''
  if (typeof cell === 'number') return `<c r="${reference}"><v>${cell}</v></c>`
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xml(neutralize(cell))}</t></is></c>`
}

/** A one-sheet workbook: numbers as numbers, text inline, nothing a spreadsheet would run. */
export function writeXlsx(metadata: Metadata, table: Table): Buffer {
  const rows: (readonly Cell[])[] = [
    ...metadata.map(([key, value]) => [key, value]),
    [],
    table.columns,
    ...table.rows,
  ]
  const sheetRows = rows
    .map(
      (cells, row) =>
        `<row r="${row + 1}">${cells.map((cell, index) => xlsxCell(cell, `${column(index)}${row + 1}`)).join('')}</row>`,
    )
    .join('')
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Export" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  }
  const zipped = zipSync(
    Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])),
    { level: 6, mtime: new Date('2026-01-01T00:00:00Z') },
  )
  return Buffer.from(zipped)
}

export const CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

export function writeFile(
  format: ExportFormat,
  metadata: Metadata,
  table: Table,
  locale: ExportLocale,
): Buffer {
  return format === 'csv' ? writeCsv(metadata, table, locale) : writeXlsx(metadata, table)
}
