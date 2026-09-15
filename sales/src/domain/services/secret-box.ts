export abstract class SecretBox {
  abstract seal(secret: string, plaintext: string): string
  abstract open(secret: string, sealed: string): string | null
}
