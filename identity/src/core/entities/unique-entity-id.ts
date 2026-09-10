import { uuidv7 } from 'uuidv7'

/**
 * A public identifier. UUIDv7 inside (ADR 0009), because v4 fragments a B-tree index on
 * insert: v7 leads with a millisecond timestamp, so successive inserts land at the right
 * edge of the index rather than scattering across it.
 *
 * The reference project's class defaulted to `randomUUID()` — the public surface is kept
 * and the generator swapped (`docs/reference-analysis.md` §3.4).
 */
export class UniqueEntityID {
  private readonly value: string

  constructor(value?: string) {
    this.value = value ?? uuidv7()
  }

  toString(): string {
    return this.value
  }

  toValue(): string {
    return this.value
  }

  equals(other: UniqueEntityID): boolean {
    return other.toValue() === this.value
  }
}
