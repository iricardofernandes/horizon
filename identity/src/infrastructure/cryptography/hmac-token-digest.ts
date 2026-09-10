import { createHmac } from 'node:crypto'

import { TokenDigest } from '@/domain/services/token-digest'

/** A keyed, domain-separated lookup digest for credentials carrying 256 bits of entropy. */
export class HmacTokenDigest extends TokenDigest {
  private readonly key: Buffer

  constructor(key: Uint8Array) {
    super()
    if (key.byteLength < 32) throw new Error('Token digest key must contain at least 32 bytes')
    this.key = Buffer.from(key)
  }

  override digest(value: string): string {
    return createHmac('sha256', this.key)
      .update('horizon:identity:token-digest:v1\0', 'utf8')
      .update(value, 'utf8')
      .digest('hex')
  }
}
