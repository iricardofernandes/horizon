import { z } from 'zod'

import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { FAMILY_END_REASONS, RefreshTokenFamily } from '@/domain/entities/refresh-token-family'

const storedFamily = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  currentDigest: z.string().min(1),
  previousDigest: z.string().nullable(),
  rotatedDigests: z.array(z.string()),
  graceSealed: z.string().nullable(),
  previousRotatedAt: z.coerce.date().nullable(),
  status: z.enum(['active', 'ended']),
  endedReason: z.enum(FAMILY_END_REASONS).nullable(),
  createdAt: z.coerce.date(),
  lastUsedAt: z.coerce.date(),
})

/** Corrupt session state fails closed instead of becoming an authenticated family. */
export function restoreRefreshFamily(
  serialized: string,
  tenantId: string,
  familyId: string,
): RefreshTokenFamily {
  const snapshot = storedFamily.parse(JSON.parse(serialized))
  if (snapshot.tenantId !== tenantId || snapshot.id !== familyId)
    throw new Error('Refresh family scope does not match its Redis key')
  const { previousDigest, graceSealed, previousRotatedAt, endedReason, ...props } = snapshot
  return RefreshTokenFamily.create(
    {
      ...props,
      ...(previousDigest === null ? {} : { previousDigest }),
      ...(graceSealed === null ? {} : { graceSealed }),
      ...(previousRotatedAt === null ? {} : { previousRotatedAt }),
      ...(endedReason === null ? {} : { endedReason }),
    },
    new UniqueEntityID(familyId),
  )
}
