import { createHash, randomUUID } from 'node:crypto'
import type postgres from 'postgres'

type Transaction = postgres.TransactionSql
const GENESIS = '0'.repeat(64)

export interface AuditRow {
  tenant_id: string
  sequence: string | number
  id: string
  actor_id: string
  action: string
  resource_id: string
  detail_digest: string
  occurred_at: Date | string
  previous_hash: string
  hash: string
}

export async function appendAudit(
  tx: Transaction,
  entry: {
    tenantId: string
    actorId: string
    action: string
    resourceId: string
    detail: unknown
  },
): Promise<void> {
  const detailDigest = digest(JSON.stringify(entry.detail ?? null))
  await tx`insert into fiscal_audit_heads (tenant_id)
    values (${entry.tenantId}) on conflict do nothing`
  const [head] = await tx`select sequence, hash from fiscal_audit_heads
    where tenant_id = ${entry.tenantId} for update`
  if (!head) throw new Error('Fiscal audit head is unavailable')
  const sequence = Number(head.sequence) + 1
  const row: AuditRow = {
    tenant_id: entry.tenantId,
    sequence,
    id: randomUUID(),
    actor_id: entry.actorId,
    action: entry.action,
    resource_id: entry.resourceId,
    detail_digest: detailDigest,
    occurred_at: new Date().toISOString(),
    previous_hash: String(head.hash),
    hash: '',
  }
  row.hash = hashRow(row)
  await tx`insert into fiscal_audit_entries (
    tenant_id, sequence, id, actor_id, action, resource_id,
    detail_digest, occurred_at, previous_hash, hash
  ) values (
    ${row.tenant_id}, ${row.sequence}, ${row.id}, ${row.actor_id}, ${row.action},
    ${row.resource_id}, ${row.detail_digest}, ${row.occurred_at},
    ${row.previous_hash}, ${row.hash}
  )`
  await tx`update fiscal_audit_heads set sequence = ${sequence}, hash = ${row.hash}
    where tenant_id = ${entry.tenantId}`
}

export function verifyAuditRows(
  rows: readonly AuditRow[],
  head?: { sequence: string | number; hash: string },
): boolean {
  let previous = GENESIS
  let sequence = 0
  for (const row of rows) {
    sequence += 1
    if (
      Number(row.sequence) !== sequence ||
      row.previous_hash !== previous ||
      row.hash !== hashRow(row)
    )
      return false
    previous = row.hash
  }
  return !head || (Number(head.sequence) === sequence && head.hash === previous)
}

function hashRow(row: AuditRow): string {
  const instant = new Date(row.occurred_at).toISOString()
  return digest(
    JSON.stringify([
      row.tenant_id,
      Number(row.sequence),
      row.id,
      row.actor_id,
      row.action,
      row.resource_id,
      row.detail_digest,
      instant,
      row.previous_hash,
    ]),
  )
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
