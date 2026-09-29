/**
 * Text into chunks for the index (Phase 74): about `size` characters each, overlapping by
 * `overlap`, cut on whitespace where one is near, and at most `max` of them. What does not
 * fit is left out and said so, never silently.
 */
export interface Chunked {
  readonly chunks: readonly string[]
  readonly truncated: boolean
}

export const CHUNK_SIZE = 800
export const CHUNK_OVERLAP = 100
export const MAX_CHUNKS = 400

/** Whitespace folded, control characters dropped: what the index and a reader both see. */
export function normalizeText(text: string): string {
  let clean = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    // Control characters other than tab and line breaks carry nothing a reader sees.
    clean += code < 32 && code !== 9 && code !== 10 && code !== 13 ? ' ' : character
  }
  return clean
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\r?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function chunkText(
  text: string,
  size = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP,
  max = MAX_CHUNKS,
): Chunked {
  if (overlap >= size) throw new Error('the overlap must be smaller than the chunk')
  const clean = normalizeText(text)
  const chunks: string[] = []
  let start = 0
  while (start < clean.length && chunks.length < max) {
    let end = Math.min(start + size, clean.length)
    if (end < clean.length) {
      const space = clean.lastIndexOf(' ', end)
      const breakAt = Math.max(space, clean.lastIndexOf('\n', end))
      if (breakAt > start + size / 2) end = breakAt
    }
    const chunk = clean.slice(start, end).trim()
    if (chunk) chunks.push(chunk)
    if (end >= clean.length) return { chunks, truncated: false }
    // The next chunk starts `overlap` back, on the start of a word rather than inside one.
    const back = Math.max(end - overlap, start + 1)
    const wordStart = clean.slice(back, end).search(/\s\S/)
    start = wordStart === -1 ? back : back + wordStart + 1
  }
  return { chunks, truncated: start < clean.length }
}
