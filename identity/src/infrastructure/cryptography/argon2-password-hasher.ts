import { randomBytes } from 'node:crypto'

import { hash, hashSync, type Options, verify } from '@node-rs/argon2'

import { PasswordHasher } from '@/domain/services/password-hasher'
import type { Argon2Policy } from '@/domain/value-objects/password-hash'

const MINIMUM_POLICY: Argon2Policy = Object.freeze({
  memoryKib: 19_456,
  timeCost: 2,
  parallelism: 1,
})

/** Real password and API-key hashing; salts and native verification belong to Argon2. */
export class Argon2PasswordHasher extends PasswordHasher {
  private readonly options: Options
  private readonly dummyHash: string

  constructor(policy: Argon2Policy = MINIMUM_POLICY) {
    super()
    for (const field of ['memoryKib', 'timeCost', 'parallelism'] as const) {
      if (!Number.isInteger(policy[field]) || policy[field] < MINIMUM_POLICY[field])
        throw new Error(`Argon2 ${field} must meet the minimum password policy`)
    }
    if (policy.memoryKib > 0xffff_ffff || policy.timeCost > 0xffff_ffff)
      throw new Error('Argon2 memory and time cost must fit unsigned 32-bit integers')
    if (policy.parallelism > 255 || policy.memoryKib < 8 * policy.parallelism)
      throw new Error('Argon2 parallelism exceeds the available memory or supported range')

    this.options = {
      // The binding declares ambient const enums, which verbatimModuleSyntax cannot
      // import. These are its documented Algorithm.Argon2id and Version.V0x13 values.
      algorithm: 2,
      version: 1,
      memoryCost: policy.memoryKib,
      timeCost: policy.timeCost,
      parallelism: policy.parallelism,
      outputLen: 32,
    }
    // Pay this once at boot. A lazy dummy would make the first unknown-user request
    // perform two expensive operations, exposing a different timing profile.
    this.dummyHash = hashSync(randomBytes(32), this.options)
  }

  override hash(plaintext: string): Promise<string> {
    return hash(plaintext, this.options)
  }

  override async verify(encoded: string, plaintext: string): Promise<boolean> {
    try {
      return await verify(encoded, plaintext)
    } catch {
      return false
    }
  }

  override async verifyDummy(): Promise<void> {
    await verify(this.dummyHash, 'horizon:identity:dummy-verification')
  }
}
