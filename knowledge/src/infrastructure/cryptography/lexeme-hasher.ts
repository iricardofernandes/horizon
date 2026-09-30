import { createHash, createHmac } from 'node:crypto'
import { LexemeHasher } from '@/application/ports'

/** 128 bits of HMAC-SHA-256: no two lexemes of a tenant will meet by chance. */
const HASH_HEX = 32
/** Tenant keys kept derived; past this many, the oldest is derived again when needed. */
const CACHED_TENANTS = 1000

/**
 * Keyed lexemes (Phase 75, ADR 0068): each tenant's lexemes are hashed under a key derived
 * from the master key for that tenant, so the full-text index holds no word in the clear,
 * and the same word hashes differently in every tenant.
 */
export class HmacLexemeHasher extends LexemeHasher {
  readonly keyId: string
  readonly #master: Buffer
  readonly #keys = new Map<string, Buffer>()

  /** The lexeme key: the master key's value unless `KNOWLEDGE_LEXEME_KEY` names another. */
  constructor(masterKey: Buffer) {
    super()
    if (masterKey.length !== 32) throw new Error('The knowledge lexeme key must be 32 bytes')
    this.#master = Buffer.from(masterKey)
    this.keyId = createHash('sha256')
      .update('horizon-lexeme-key:')
      .update(masterKey)
      .digest('hex')
      .slice(0, 8)
  }

  hash(tenantId: string, lexeme: string): string {
    return createHmac('sha256', this.keyOf(tenantId))
      .update(lexeme, 'utf8')
      .digest('hex')
      .slice(0, HASH_HEX)
  }

  private keyOf(tenantId: string): Buffer {
    const cached = this.#keys.get(tenantId)
    if (cached) return cached
    const key = createHmac('sha256', this.#master).update(`lexemes:${tenantId}`).digest()
    if (this.#keys.size >= CACHED_TENANTS) {
      const oldest = this.#keys.keys().next().value
      if (oldest !== undefined) this.#keys.delete(oldest)
    }
    this.#keys.set(tenantId, key)
    return key
  }
}
