import { strToU8, unzipSync, zipSync } from 'fflate'
import {
  type FailuresFile,
  ImportFiles,
  type ParsedFile,
  type SourceRow,
  type StoredRow,
} from '@/application/imports/ports'
import { type Either, left, right } from '@/core/either'
import type { ImportFormat, ImportJob } from '@/domain/imports/import-job'

const BOM = '﻿'

/** A text cell a spreadsheet would run as a formula is prefixed; plain numbers are not. */
export function neutralize(text: string): string {
  if (/^-?\d+([.,]\d+)?$/.test(text)) return text
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // A spreadsheet saved as "CSV" in a Brazilian locale is often Windows-1252.
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

function delimiterOf(text: string): string {
  let header = ''
  let quoted = false
  for (const character of text) {
    if (character === '"') quoted = !quoted
    if (!quoted && (character === '\n' || character === '\r')) break
    header += character
  }
  const counts = [';', ',', '\t'].map((candidate) => ({
    candidate,
    count: header.split(candidate).length - 1,
  }))
  const best = counts.reduce((a, b) => (b.count > a.count ? b : a))
  return best.count > 0 ? best.candidate : ','
}

type FileRecord = { line: number; cells: string[] }

/** RFC 4180, remembering the line each record starts on. */
class CsvReader {
  readonly records: FileRecord[] = []
  private cells: string[] = []
  private cell = ''
  private quoted = false
  private line = 1
  private start = 1

  constructor(
    private readonly text: string,
    private readonly delimiter: string,
  ) {}

  read(): FileRecord[] {
    for (let index = 0; index < this.text.length; index += 1)
      index = this.quoted ? this.inQuotes(index) : this.outside(index)
    if (this.cell !== '' || this.cells.length > 0) this.endRecord()
    return this.records
  }

  private inQuotes(index: number): number {
    const character = this.text[index] as string
    if (character === '"' && this.text[index + 1] === '"') {
      this.cell += '"'
      return index + 1
    }
    if (character === '"') this.quoted = false
    else {
      if (character === '\n') this.line += 1
      this.cell += character
    }
    return index
  }

  private outside(index: number): number {
    const character = this.text[index] as string
    if (character === '"' && this.cell === '') this.quoted = true
    else if (character === this.delimiter) this.endCell()
    else if (character === '\n' || character === '\r') {
      this.endRecord()
      this.line += 1
      this.start = this.line
      return character === '\r' && this.text[index + 1] === '\n' ? index + 1 : index
    } else this.cell += character
    return index
  }

  private endCell(): void {
    this.cells.push(this.cell)
    this.cell = ''
  }

  private endRecord(): void {
    this.endCell()
    this.records.push({ line: this.start, cells: this.cells })
    this.cells = []
  }
}

function entities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10))
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name] ?? ''
  })
}

/** The text of every `<t>` run, phonetic hints left out. */
function textRuns(xml: string): string {
  const withoutHints = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
  return [...withoutHints.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((match) => entities(match[1] ?? ''))
    .join('')
}

function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? 'A'
  return [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1
}

function plainNumber(value: string): string {
  const number = Number(value)
  return Number.isFinite(number) ? String(number) : value
}

function unzipped(bytes: Uint8Array): Record<string, Uint8Array> | null {
  try {
    return unzipSync(bytes)
  } catch {
    return null
  }
}

/** Where the workbook's first sheet lives in the package. */
function firstSheetPath(workbook: string, relations: string): string | null {
  const relationId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1]
  if (!relationId) return null
  const relation = [...relations.matchAll(/<Relationship\b[^>]*>/g)]
    .map((match) => match[0])
    .find((tag) => tag.includes(`Id="${relationId}"`))
  const target = relation ? /\bTarget="([^"]+)"/.exec(relation)?.[1] : undefined
  if (!target) return null
  return target.startsWith('/') ? target.slice(1) : `xl/${target}`
}

function cellValue(attributes: string, body: string, shared: readonly string[]): string {
  const type = /\bt="([a-zA-Z]+)"/.exec(attributes)?.[1] ?? 'n'
  const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
  if (type === 's') return shared[Number(raw)] ?? ''
  if (type === 'inlineStr') return textRuns(body)
  if (type === 'b') return raw === '1' ? 'true' : 'false'
  if (raw === undefined) return ''
  return type === 'n' ? plainNumber(entities(raw)) : entities(raw)
}

function sheetRecords(sheet: string, shared: readonly string[]): FileRecord[] {
  return [...sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)].map((row, index) => {
    const line = Number(/\br="(\d+)"/.exec(row[1] ?? '')?.[1] ?? index + 1)
    const cells: string[] = []
    for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1] ?? ''
      const reference = /\br="([A-Z]+)\d*"/.exec(attributes)?.[1] ?? 'A'
      cells[columnIndex(reference)] = cellValue(attributes, cell[2] ?? '', shared)
    }
    return { line, cells: Array.from(cells, (value) => value ?? '') }
  })
}

/** The first sheet of a workbook, as rows of text keyed by their row number. */
function xlsxRecords(bytes: Uint8Array): Either<string, FileRecord[]> {
  const files = unzipped(bytes)
  const text = (name: string) => {
    const file = files?.[name]
    return file ? new TextDecoder().decode(file) : null
  }
  const workbook = text('xl/workbook.xml')
  const relations = text('xl/_rels/workbook.xml.rels')
  if (!workbook || !relations) return left('the file is not a readable XLSX workbook')
  const path = firstSheetPath(workbook, relations)
  const sheet = path ? text(path) : null
  if (!sheet) return left('the workbook has no sheet')
  const shared = [...(text('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (match) => textRuns(match[1] ?? ''),
  )
  return right(sheetRecords(sheet, shared))
}

/**
 * The header is the first row that is not blank; each column needs a distinct name so a
 * mapping can point at it. Blank rows are skipped, and every row keeps its file line.
 */
function tabulate(records: readonly FileRecord[], delimiter: string): Either<string, ParsedFile> {
  const filled = records.filter((record) => record.cells.some((cell) => cell.trim() !== ''))
  const [header, ...body] = filled
  if (!header) return left('the file is empty')
  const columns = header.cells.map((cell) => cell.trim())
  while (columns.length > 0 && columns.at(-1) === '') columns.pop()
  if (columns.some((column) => column === ''))
    return left('every column needs a name in the first row')
  if (new Set(columns).size !== columns.length) return left('two columns have the same name')
  const rows: SourceRow[] = body.map((record) => ({
    line: record.line,
    cells: columns.map((_, index) => record.cells[index] ?? ''),
  }))
  return right({ columns, rows, delimiter })
}

function csvCell(value: string, delimiter: string): string {
  const text = neutralize(value)
  const quoted = text.includes(delimiter) || /["\r\n]/.test(text) || text !== value
  return quoted ? `"${text.replaceAll('"', '""')}"` : text
}

function xml(text: string): string {
  return [...text]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
    })
    .join('')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function columnName(index: number): string {
  let name = ''
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26))
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name
  return name
}

function xlsxCell(value: string, reference: string): string {
  if (value === '') return ''
  // A leading zero is text (a code, a document): as a number it would be lost.
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value) && value.length < 16)
    return `<c r="${reference}"><v>${value}</v></c>`
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xml(neutralize(value))}</t></is></c>`
}

export function writeXlsx(rows: readonly (readonly string[])[], sheetName: string): Uint8Array {
  const sheetRows = rows
    .map(
      (cells, row) =>
        `<row r="${row + 1}">${cells.map((cell, index) => xlsxCell(cell, `${columnName(index)}${row + 1}`)).join('')}</row>`,
    )
    .join('')
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  }
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])),
    { level: 6, mtime: new Date('2026-01-01T00:00:00Z') },
  )
}

const CONTENT_TYPES: Readonly<Record<ImportFormat, string>> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

export class TabularImportFiles extends ImportFiles {
  read(format: ImportFormat, bytes: Uint8Array): Either<string, ParsedFile> {
    if (format === 'xlsx') {
      const records = xlsxRecords(bytes)
      return records.isLeft() ? left(records.value) : tabulate(records.value, ';')
    }
    const text = decode(bytes).replace(/^﻿/, '')
    const delimiter = delimiterOf(text)
    return tabulate(new CsvReader(text, delimiter).read(), delimiter)
  }

  /** The original columns, then the line and every reason, in the input's own format. */
  failures(job: ImportJob, rows: readonly StoredRow[]): FailuresFile {
    const english = job.locale === 'en'
    const header = [...job.columns, english ? 'line' : 'linha', english ? 'reason' : 'motivo']
    const body = rows.map((row) => [
      ...row.cells,
      String(row.line),
      row.issues
        .map((issue) => (issue.field ? `${issue.field}: ${issue.message}` : issue.message))
        .join('; '),
    ])
    const base = job.fileName.replace(/\.[^.]+$/, '')
    const fileName = `${base}-${english ? 'failures' : 'falhas'}.${job.format}`
    if (job.format === 'xlsx')
      return {
        fileName,
        contentType: CONTENT_TYPES.xlsx,
        bytes: writeXlsx([header, ...body], english ? 'Failures' : 'Falhas'),
      }
    const lines = [header, ...body].map((cells) =>
      cells.map((cell) => csvCell(cell, job.delimiter)).join(job.delimiter),
    )
    return {
      fileName,
      contentType: CONTENT_TYPES.csv,
      bytes: new TextEncoder().encode(`${BOM}${lines.join('\r\n')}\r\n`),
    }
  }
}
