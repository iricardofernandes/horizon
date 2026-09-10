import { randomBytes, randomInt, randomUUID } from 'node:crypto'

import { SecretGenerator } from '@/application/ports/secret-generator'

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export class CryptoSecretGenerator extends SecretGenerator {
  override token(bytes: number): string {
    this.assertSize(bytes)
    return randomBytes(bytes).toString('base64url')
  }

  override alphanumeric(length: number): string {
    this.assertSize(length)
    // randomInt performs rejection sampling internally, so 256 % 62 cannot bias a key.
    return Array.from({ length }, () => ALPHANUMERIC.charAt(randomInt(ALPHANUMERIC.length))).join(
      '',
    )
  }

  override keyMaterial(): string {
    return randomBytes(32).toString('base64')
  }

  override identifier(): string {
    return randomUUID()
  }

  private assertSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 1)
      throw new Error('Secret size must be a positive safe integer')
  }
}
