import { strToU8, zipSync } from 'fflate'

/** A one-page PDF with a text layer, built by hand with a correct cross-reference table. */
export function pdfWith(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 700 Td (${text.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

export function docxWith(paragraphs: readonly string[]): Buffer {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${paragraphs
    .map((paragraph) => `<w:p><w:r><w:t xml:space="preserve">${paragraph}</w:t></w:r></w:p>`)
    .join('')}</w:body></w:document>`
  return Buffer.from(zipSync({ 'word/document.xml': strToU8(xml) }))
}

export function xlsxWith(shared: readonly string[], rows: readonly string[]): Buffer {
  const sst = `<sst>${shared.map((text) => `<si><t>${text}</t></si>`).join('')}</sst>`
  const sheet = `<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`
  return Buffer.from(
    zipSync({ 'xl/sharedStrings.xml': strToU8(sst), 'xl/worksheets/sheet1.xml': strToU8(sheet) }),
  )
}
