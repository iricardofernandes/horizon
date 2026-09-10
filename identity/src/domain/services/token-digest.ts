/**
 * A fast keyed digest for high-entropy secrets — refresh tokens and API-key secrets on
 * the cache path.
 *
 * Deliberately **not** Argon2id. Argon2id exists to make a low-entropy secret expensive
 * to guess; these values are 256 bits of randomness, so there is no dictionary to attack
 * and paying 19 MiB per lookup would buy nothing (ADR 0020).
 */
export abstract class TokenDigest {
  abstract digest(value: string): string
}
