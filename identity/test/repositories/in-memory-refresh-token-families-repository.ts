import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { RefreshTokenFamily } from '@/domain/entities/refresh-token-family'
import { RefreshTokenFamiliesRepository } from '@/domain/repositories/refresh-token-families-repository'

export class InMemoryRefreshTokenFamiliesRepository extends RefreshTokenFamiliesRepository {
  private readonly items = new Map<string, RefreshTokenFamily>()

  async findById(tenantId: string, familyId: string): Promise<RefreshTokenFamily | null> {
    const family = this.items.get(`${tenantId}:${familyId}`)
    return family ? this.copy(family) : null
  }

  async create(family: RefreshTokenFamily, _absoluteTtlSeconds: number): Promise<void> {
    const snapshot = family.toSnapshot()
    if (this.items.has(`${snapshot.tenantId}:${snapshot.id}`))
      throw new Error('Session family already exists')
    this.items.set(`${snapshot.tenantId}:${snapshot.id}`, this.copy(family))
  }

  async saveIfCurrent(family: RefreshTokenFamily, expectedDigest: string): Promise<boolean> {
    const snapshot = family.toSnapshot()
    const key = `${snapshot.tenantId}:${snapshot.id}`
    const current = this.items.get(key)
    if (!current?.isActive() || !current.isCurrent(expectedDigest)) return false
    this.items.set(key, this.copy(family))
    return true
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
