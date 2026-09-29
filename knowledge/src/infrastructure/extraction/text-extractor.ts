import { unzipSync } from 'fflate'
import { PDFParse } from 'pdf-parse'
import { TextExtractor } from '@/application/ports'

/** At most this much text is taken from one file; the chunk cap cuts further. */
const MAX_TEXT = 2_000_000

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return ENTITIES[entity.toLowerCase()] ?? ''
  })
}

function fromZip(bytes: Buffer, name: (entry: string) => boolean): Record<string, string> {
  const entries = unzipSync(new Uint8Array(bytes), { filter: (file) => name(file.name) })
  return Object.fromEntries(
    Object.entries(entries).map(([entry, data]) => [entry, Buffer.from(data).toString('utf8')]),
  )
}

/** A Word document's paragraphs, from `word/document.xml`. */
function docxText(bytes: Buffer): string {
  const xml = fromZip(bytes, (entry) => entry === 'word/document.xml')['word/document.xml'] ?? ''
  return xml
    .split(/<\/w:p>/)
    .map((paragraph) =>
      [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
        .map((match) => decodeXml(match[1] ?? ''))
        .join(''),
    )
    .filter(Boolean)
    .join('\n')
}

/** A workbook's cells, row by row: shared strings resolved, numbers as written. */
function xlsxText(bytes: Buffer): string {
  const files = fromZip(
    bytes,
    (entry) => entry === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(entry),
  )
  const shared = [...(files['xl/sharedStrings.xml'] ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (item) =>
      [...(item[1] ?? '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)]
        .map((text) => decodeXml(text[1] ?? ''))
        .join(''),
  )
  const sheets = Object.keys(files)
    .filter((entry) => entry.startsWith('xl/worksheets/'))
    .sort()
  return sheets
    .flatMap((sheet) =>
      [...(files[sheet] ?? '').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
        [...(row[1] ?? '').matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)]
          .map((cell) => {
            const value = /<v>([^<]*)<\/v>/.exec(cell[2] ?? '')?.[1]
            const inline = /<t(?:\s[^>]*)?>([^<]*)<\/t>/.exec(cell[2] ?? '')?.[1]
            if (/\bt="s"/.test(cell[1] ?? '')) return shared[Number(value)] ?? ''
            return decodeXml(value ?? inline ?? '')
          })
          .filter(Boolean)
          .join('\t'),
      ),
    )
    .filter(Boolean)
    .join('\n')
}

async function pdfText(bytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) })
  try {
    return (await parser.getText()).text
  } finally {
    await parser.destroy()
  }
}

/**
 * The text of the attachable types (ADR 0060) that carry any: plain text, CSV, PDF text
 * layers, DOCX and XLSX. Images, and PDFs that are only scans, have none: there is no OCR.
 */
export class FileTextExtractor extends TextExtractor {
  async extract(contentType: string, bytes: Buffer): Promise<string | null> {
    const text = await this.textOf(contentType, bytes)
    const trimmed = text?.trim()
    return trimmed ? trimmed.slice(0, MAX_TEXT) : null
  }

  private async textOf(contentType: string, bytes: Buffer): Promise<string | null> {
    switch (contentType) {
      case 'text/plain':
      case 'text/csv':
        return bytes.toString('utf8').replace(/^﻿/, '')
      case 'application/pdf':
        return pdfText(bytes)
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return docxText(bytes)
      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        return xlsxText(bytes)
      default:
        return null
    }
  }
}
