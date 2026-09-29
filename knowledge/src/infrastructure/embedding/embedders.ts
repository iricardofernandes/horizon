import { Embedder } from '@/application/ports'

export const DIMENSIONS = 384

/** Lower case, accents folded, split on anything that is not a letter or a digit. */
export function tokensOf(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1)
}

/** FNV-1a, 32 bits: fast, stable across runs and machines. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function normalized(vector: number[]): number[] {
  const norm = Math.hypot(...vector)
  if (norm === 0) {
    // An empty text still gets a vector the index can compare, and it matches nothing well.
    const unit = new Array<number>(vector.length).fill(0)
    unit[0] = 1
    return unit
  }
  return vector.map((value) => value / norm)
}

/**
 * The deterministic embedder of CI and of a stack without the `ai` profile (ADR 0069): each
 * token and each pair of neighbouring tokens is hashed into one of 384 signed buckets. It
 * finds shared words, not meaning, and it never leaves the process.
 */
export class HashEmbedder extends Embedder {
  readonly version = 'hash-384-v1'
  readonly dimensions = DIMENSIONS

  embed(text: string): number[] {
    const vector = new Array<number>(DIMENSIONS).fill(0)
    const tokens = tokensOf(text)
    const features = [
      ...tokens,
      ...tokens.slice(1).map((token, index) => `${tokens[index]} ${token}`),
    ]
    for (const feature of features) {
      const hash = fnv1a(feature)
      const bucket = hash % DIMENSIONS
      vector[bucket] = (vector[bucket] ?? 0) + (hash & 0x80000000 ? -1 : 1)
    }
    return normalized(vector)
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => this.embed(text))
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(text)
  }
}

/**
 * `multilingual-e5-small` on Text Embeddings Inference, in the stack's `ai` profile (ADR 0069).
 * E5 asks for a `passage:` or `query:` prefix. Nothing leaves the stack.
 */
export class TeiEmbedder extends Embedder {
  readonly version = 'e5-small-v1'
  readonly dimensions = DIMENSIONS

  constructor(
    private readonly url: string,
    private readonly timeoutMs = 30_000,
    private readonly batch = 16,
  ) {
    super()
  }

  async embedDocuments(texts: readonly string[]): Promise<number[][]> {
    const vectors: number[][] = []
    for (let start = 0; start < texts.length; start += this.batch)
      vectors.push(
        ...(await this.embed(
          texts.slice(start, start + this.batch).map((text) => `passage: ${text}`),
        )),
      )
    return vectors
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([`query: ${text}`])
    if (!vector) throw new Error('the embedder answered no vector')
    return vector
  }

  private async embed(inputs: string[]): Promise<number[][]> {
    const response = await fetch(new URL('/embed', this.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs, normalize: true, truncate: true }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error(`the embedder answered ${response.status}`)
    const vectors = (await response.json()) as number[][]
    if (!Array.isArray(vectors) || vectors.some((vector) => vector.length !== DIMENSIONS))
      throw new Error('the embedder answered vectors of another size')
    return vectors
  }
}
