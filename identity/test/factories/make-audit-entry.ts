import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { AuditEntry } from '@/domain/audit/audit-entry'
import type { HashedAuditPayload } from '@/domain/audit/chain'

export function makeAuditEntry(overrides: Partial<HashedAuditPayload> = {}, previousHash?: string) {
  return AuditEntry.append({
    payload: {
      sequence: 1,
      tenantId: new UniqueEntityID().toString(),
      actorType: 'system',
      actorId: null,
      subjectType: 'session',
      subjectId: new UniqueEntityID().toString(),
      action: 'session.reuse-detected',
      occurredAt: new Date('2026-09-10T12:00:00Z'),
      requestId: null,
      traceId: null,
      sourceIp: null,
      before: null,
      after: null,
      redacted: [],
      ...overrides,
    },
    ...(previousHash === undefined ? {} : { previousHash }),
  })
}

export function tamperAuditEntry(entry: AuditEntry, overrides: Partial<HashedAuditPayload>) {
  const { id, ...snapshot } = entry.toSnapshot()
  return AuditEntry.rehydrate({ ...snapshot, ...overrides }, new UniqueEntityID(id))
}
