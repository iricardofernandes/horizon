import type { ContentType } from './vocabulary'

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]
const ZIP = [0x50, 0x4b, 0x03, 0x04]

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return prefix.every((byte, index) => bytes[offset + index] === byte)
}

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0))
}

/** Valid UTF-8 without NUL: a text file, not a binary with a text label. */
function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * Whether the first bytes are what the declared type says (Phase 65). A label is the
 * uploader's word; the signature is the file's. Office documents are ZIP containers.
 */
export function matchesType(contentType: ContentType, bytes: Uint8Array): boolean {
  switch (contentType) {
    case 'application/pdf':
      return startsWith(bytes, ascii('%PDF-'))
    case 'image/png':
      return startsWith(bytes, PNG)
    case 'image/jpeg':
      return startsWith(bytes, JPEG)
    case 'image/gif':
      return startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))
    case 'image/webp':
      return startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)
    case 'text/plain':
    case 'text/csv':
      return isText(bytes)
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return startsWith(bytes, ZIP)
  }
}

/**
 * A file name safe inside a `Content-Disposition` header: letters, digits and `. _ - ( )`
 * kept, anything else a `_`, and never empty or hidden.
 */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._\-() ]/gu, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 200)
  return cleaned.length > 0 ? cleaned : 'attachment'
}

/** The same name reduced to ASCII, for clients that ignore `filename*`. */
export function asciiFileName(name: string): string {
  const ascii = safeFileName(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/"/g, '_')
  return ascii.length > 0 ? ascii : 'attachment'
}

/** The name for `filename*` (RFC 5987): UTF-8, with every character outside attr-char encoded. */
export function encodedFileName(name: string): string {
  return encodeURIComponent(safeFileName(name)).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}
