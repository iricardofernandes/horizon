import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { User } from '@/domain/entities/user'
import { Email } from '@/domain/value-objects/email'
import { PasswordHash } from '@/domain/value-objects/password-hash'
import { PersonName } from '@/domain/value-objects/person-name'

export function makeUser(overrides: Partial<Parameters<typeof User.create>[0]> = {}) {
  const email = Email.create('person@example.com')
  const name = PersonName.create('Test Person')
  const hash = PasswordHash.create('$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')
  if (email.isLeft() || name.isLeft() || hash.isLeft()) throw new Error('Invalid user fixture')
  return User.create({
    tenantId: new UniqueEntityID().toString(),
    email: email.value,
    name: name.value,
    passwordHash: hash.value,
    ...overrides,
  })
}
