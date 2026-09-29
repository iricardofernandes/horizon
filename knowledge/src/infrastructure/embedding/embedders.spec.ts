import { describe, expect, it } from 'vitest'
import { HashEmbedder, tokensOf } from './embedders'

const cosine = (a: number[], b: number[]) =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0)

describe('the hash embedder', () => {
  const embedder = new HashEmbedder()

  it('gives the same unit vector of 384 dimensions for the same text', () => {
    const vector = embedder.embed('Nota fiscal de café torrado')
    expect(vector).toHaveLength(384)
    expect(Math.hypot(...vector)).toBeCloseTo(1, 6)
    expect(embedder.embed('Nota fiscal de café torrado')).toEqual(vector)
  })

  it('brings texts that share words closer than texts that share none', () => {
    const query = embedder.embed('café torrado')
    expect(cosine(query, embedder.embed('pedido de café torrado em grãos'))).toBeGreaterThan(
      cosine(query, embedder.embed('contrato de manutenção predial')),
    )
  })

  it('folds case and accents, and still answers an empty text', () => {
    expect(tokensOf('CAFÉ Café cafe')).toEqual(['cafe', 'cafe', 'cafe'])
    expect(embedder.embed('')[0]).toBe(1)
  })
})
