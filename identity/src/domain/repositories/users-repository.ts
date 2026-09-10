import type { Page, PaginationParams } from '@/core/repositories/pagination-params'
import type { User } from '@/domain/entities/user'
import type { Email } from '@/domain/value-objects/email'

export abstract class UsersRepository {
  abstract findById(id: string): Promise<User | null>

  /**
   * Exact match only, and that is not an implementation detail leaking upward — it is the
   * whole surface (ADR 0026).
   *
   * The email column holds ciphertext, which cannot be indexed, searched, sorted or
   * joined. What is indexed is a keyed HMAC of the normalised address, computed by the
   * adapter, which supports equality and nothing else. There is deliberately no
   * `findByEmailLike` and no "users at this domain" — the schema is designed around the
   * constraint rather than working around it.
   */
  abstract findByEmail(email: Email): Promise<User | null>

  abstract create(user: User): Promise<void>
  abstract save(user: User): Promise<void>
  abstract list(params: PaginationParams): Promise<Page<User>>
  abstract countActive(): Promise<number>
}
