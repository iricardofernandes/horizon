import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { RefreshTokenFamily } from '@/domain/entities/refresh-token-family'

export function makeRefreshTokenFamily(
  overrides: Partial<Parameters<typeof RefreshTokenFamily.create>[0]> = {},
) {
  return RefreshTokenFamily.create({
    tenantId: new UniqueEntityID().toString(),
    userId: new UniqueEntityID().toString(),
    currentDigest: 'initial-digest',
    createdAt: new Date('2026-09-10T12:00:00.000Z'),
    ...overrides,
  })
}
