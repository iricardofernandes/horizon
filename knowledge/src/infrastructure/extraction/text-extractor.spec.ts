import { docxWith, pdfWith, xlsxWith } from 'test/support/fixtures'
import { describe, expect, it } from 'vitest'
import { FileTextExtractor } from './text-extractor'

const extractor = new FileTextExtractor()

describe('the text of each attachable type', () => {
  it('reads plain text and CSV, without the byte order mark', async () => {
    expect(await extractor.extract('text/plain', Buffer.from('﻿Café torrado'))).toBe('Café torrado')
    expect(await extractor.extract('text/csv', Buffer.from('sku;nome\nC-1;Café'))).toBe(
      'sku;nome\nC-1;Café',
    )
  })

  it('reads the text layer of a PDF', async () => {
    const text = await extractor.extract('application/pdf', pdfWith('Nota de entrega 4711'))
    expect(text).toContain('Nota de entrega 4711')
  })

  it('reads the paragraphs of a Word document, entities decoded', async () => {
    const bytes = docxWith(['Contrato de fornecimento', 'Cl&#225;usula 1 &amp; 2'])
    expect(
      await extractor.extract(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes,
      ),
    ).toBe('Contrato de fornecimento\nCláusula 1 & 2')
  })

  it('reads a workbook row by row, shared strings resolved', async () => {
    const bytes = xlsxWith(
      ['Item', 'Café'],
      [
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12.5</v></c></row>',
        '<row r="2"><c r="A2" t="s"><v>1</v></c></row>',
      ],
    )
    expect(
      await extractor.extract(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes,
      ),
    ).toBe('Item\t12.5\nCafé')
  })

  it('finds no text in an image or an empty file', async () => {
    expect(await extractor.extract('image/png', Buffer.from([0x89, 0x50]))).toBeNull()
    expect(await extractor.extract('text/plain', Buffer.from('  \n '))).toBeNull()
  })
})
