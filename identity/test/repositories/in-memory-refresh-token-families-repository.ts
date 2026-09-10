import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { RefreshTokenFamily } from '@/domain/entities/refresh-token-family'
import { RefreshTokenFamiliesRepository } from '@/domain/repositories/refresh-token-families-repository'

export class InMemoryRefreshTokenFamiliesRepository extends RefreshTokenFamiliesRepository {
  private readonly items = new Map<string, RefreshTokenFamily>()

  async findById(tenantId: string, familyId: string): Promise<RefreshTokenFamily | null> {
    const family = this.items.get(`${tenantId}:${familyId}`)
    return family ? this.copy(family) : null
  }

  async save(family: RefreshTokenFamily, _ttlSeconds: number): Promise<void> {
    const snapshot = family.toSnapshot()
    this.items.set(`${snapshot.tenantId}:${snapshot.id}`, this.copy(family))
  }

  async delete(tenantId: string, familyId: string): Promise<void> {
    this.items.delete(`${tenantId}:${familyId}`)
  }

  async findAllForUser(tenantId: string, userId: string): Promise<readonly RefreshTokenFamily[]> {
    return [...this.items.values()]
      .filter((family) => family.toSnapshot().tenantId === tenantId && family.userId() === userId)
      .map((family) => this.copy(family))
  }

  private copy(family: RefreshTokenFamily): RefreshTokenFamily {
    const snapshot = structuredClone(family.toSnapshot())
    const { previousDigest, graceSealed, previousRotatedAt, endedReason, ...props } = snapshot
    return RefreshTokenFamily.create(
      {
        ...props,
        ...(previousDigest === null ? {} : { previousDigest }),
        ...(graceSealed === null ? {} : { graceSealed }),
        ...(previousRotatedAt === null ? {} : { previousRotatedAt }),
        ...(endedReason === null ? {} : { endedReason }),
      },
      new UniqueEntityID(snapshot.id),
    )
  }
}
