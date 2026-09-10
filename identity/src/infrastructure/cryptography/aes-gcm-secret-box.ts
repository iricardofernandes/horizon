import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

import { SecretBox } from '@/domain/services/secret-box'

const CONTEXT = Buffer.from('horizon:identity:refresh-grace:v1', 'utf8')

/** The previous refresh token, never its stored digest, unlocks the grace replacement. */
export class AesGcmSecretBox extends SecretBox {
  override seal(secret: string, plaintext: string): string {
    const salt = randomBytes(16)
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.deriveKey(secret, salt), nonce)
    cipher.setAAD(CONTEXT)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])

    return [
      'v1',
      salt.toString('base64url'),
      nonce.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.')
  }

  override open(secret: string, sealed: string): string | null {
    try {
      const parts = sealed.split('.')
      if (parts.length !== 5 || parts[0] !== 'v1') return null
      const [salt, nonce, ciphertext, tag] = parts.slice(1).map((part) => {
        const decoded = Buffer.from(part, 'base64url')
        if (decoded.toString('base64url') !== part) throw new Error('Noncanonical ciphertext')
        return decoded
      })
      if (salt?.length !== 16 || nonce?.length !== 12 || tag?.length !== 16) return null
      if (ciphertext === undefined) return null

      const decipher = createDecipheriv('aes-256-gcm', this.deriveKey(secret, salt), nonce)
      decipher.setAAD(CONTEXT)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    } catch {
      return null
    }
  }

  private deriveKey(secret: string, salt: Buffer): ArrayBuffer {
    return hkdfSync('sha256', Buffer.from(secret, 'utf8'), salt, CONTEXT, 32)
  }
}
