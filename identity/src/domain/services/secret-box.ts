/**
 * Authenticated encryption under a key *derived from a secret the caller already holds*.
 *
 * It exists for one narrow job, and the job is the reason the shape is odd. ADR 0020
 * requires that two tabs racing a refresh get **the same replacement token** rather than
 * one of them tripping reuse detection — which means the replacement has to be
 * retrievable for a couple of seconds. Storing it in plaintext for those seconds would
 * undo the reason refresh tokens are hashed at rest in the first place.
 *
 * So the replacement is sealed under a key derived from the *previous token itself*. The
 * racing tab holds that token and can open it; anyone who has compromised Redis holds
 * only ciphertext and a digest, and the digest is not the key. Nothing usable is at rest.
 */
export abstract class SecretBox {
  /** Seal `plaintext` under a key derived from `secret`. */
  abstract seal(secret: string, plaintext: string): string

  /** Open a sealed value, or `null` if the secret is wrong or the ciphertext is torn. */
  abstract open(secret: string, sealed: string): string | null
}
