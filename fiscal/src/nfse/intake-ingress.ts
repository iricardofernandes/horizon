import { randomUUID } from 'node:crypto'
import {
  salesContractPeriodBilled,
  salesContractPeriodCredited,
  salesServiceDelivered,
  salesServiceDeliveryCancelled,
} from '@horizon/contracts'
import type postgres from 'postgres'
import { canonicalDigest } from '../canonical-json'

type Transaction = postgres.TransactionSql

/**
 * Records each delivered service line once, inside the inbox transaction (Phase 50).
 *
 * The line's entry id is its identity: a replay of the fact, or the same facts under a
 * new event id, finds the intake already there. Different facts under a known entry id are
 * refused, never merged. A line that bills nothing has nothing to issue and is skipped.
 */
export async function recordServiceDelivery(
  tx: Transaction,
  tenantId: string,
  raw: unknown,
): Promise<void> {
  const delivery = salesServiceDelivered.payload.parse(raw)
  for (const line of delivery.lines) {
    if (BigInt(line.amount.amount) <= 0n) continue
    await recordLine(tx, tenantId, {
      documentType: 'service-delivery',
      source: { deliveryId: delivery.deliveryId, serviceOrderId: delivery.serviceOrderId },
      entryId: line.entryId,
      period: delivery.competence,
      customerId: delivery.customerId,
      serviceItemId: line.itemId,
      competenceDate: delivery.performedOn,
      amount: line.amount,
      description: line.description,
    })
  }
}

/**
 * Asks for the NFS-e of a cancelled delivery to be undone. The worker decides how: cancel
 * an authorized NFS-e, withdraw a draft, or wait for a transmission in flight.
 */
export async function withdrawServiceDelivery(
  tx: Transaction,
  tenantId: string,
  raw: unknown,
): Promise<void> {
  const cancelled = salesServiceDeliveryCancelled.payload.parse(raw)
  const [known] = await tx`select count(*)::int as count from fiscal_service_intakes
    where tenant_id = ${tenantId} and delivery_id = ${cancelled.deliveryId}`
  // The cancellation overtook its delivery: rolling back lets the broker bring it again.
  if (!known || Number(known.count) === 0)
    throw new Error('The cancelled service delivery has not been received yet')
  await tx`update fiscal_service_intakes set
      withdrawal_requested = true,
      withdrawal_reason = ${cancelled.reason},
      next_attempt_at = now(),
      updated_at = now()
    where tenant_id = ${tenantId} and delivery_id = ${cancelled.deliveryId}
      and entry_id = any(${cancelled.entryIds}::uuid[]) and not withdrawal_requested`
}

/**
 * Records each line of a billed contract period once (Phase 52), exactly as a delivered
 * line: keyed by its entry id, with the competence month as its period. The competence
 * date is the first day of the period.
 */
export async function recordContractPeriod(
  tx: Transaction,
  tenantId: string,
  raw: unknown,
): Promise<void> {
  const period = salesContractPeriodBilled.payload.parse(raw)
  for (const line of period.lines) {
    if (BigInt(line.amount.amount) <= 0n) continue
    await recordLine(tx, tenantId, {
      documentType: 'contract-period',
      source: { billedPeriodId: period.billedPeriodId, contractId: period.contractId },
      entryId: line.entryId,
      period: period.competence,
      customerId: period.customerId,
      serviceItemId: line.itemId,
      competenceDate: period.startsOn,
      amount: line.amount,
      description: line.description,
    })
  }
}

/**
 * Asks for the NFS-e of a credited period to be undone, with the cancellation reason the
 * credit calls for: 2 when the service was not provided, 1 when it was billed in error.
 */
export async function withdrawContractPeriod(
  tx: Transaction,
  tenantId: string,
  raw: unknown,
): Promise<void> {
  const credited = salesContractPeriodCredited.payload.parse(raw)
  const [known] = await tx`select count(*)::int as count from fiscal_service_intakes
    where tenant_id = ${tenantId} and billed_period_id = ${credited.billedPeriodId}`
  // The credit overtook its billed period: rolling back lets the broker bring it again.
  if (!known || Number(known.count) === 0)
    throw new Error('The credited contract period has not been received yet')
  const code = credited.reasonCode === 'billing-error' ? '1' : '2'
  await tx`update fiscal_service_intakes set
      withdrawal_requested = true,
      withdrawal_reason = ${credited.reason},
      withdrawal_code = ${code},
      next_attempt_at = now(),
      updated_at = now()
    where tenant_id = ${tenantId} and billed_period_id = ${credited.billedPeriodId}
      and entry_id = any(${credited.entryIds}::uuid[]) and not withdrawal_requested`
}

type IntakeLine = {
  entryId: string
  period: string
  customerId: string
  serviceItemId: string
  competenceDate: string
  amount: { amount: string; currency: string }
  description: string
} & (
  | {
      documentType: 'service-delivery'
      source: { deliveryId: string; serviceOrderId: string }
    }
  | {
      documentType: 'contract-period'
      source: { billedPeriodId: string; contractId: string }
    }
)

/**
 * One billed line, recorded once under its entry id. The digest covers the line's facts
 * and the document it came from, so different facts under a known entry are refused.
 */
async function recordLine(tx: Transaction, tenantId: string, line: IntakeLine): Promise<void> {
  const { documentType, source, ...rest } = line
  const digest = canonicalDigest({ ...rest, ...source })
  const delivery = documentType === 'service-delivery' ? source : null
  const contract = documentType === 'contract-period' ? source : null
  await tx`insert into fiscal_service_intakes (
      id, tenant_id, source_module, source_document_type, entry_id, period, delivery_id,
      service_order_id, billed_period_id, contract_id, customer_id, service_item_id,
      competence_date, amount_minor, currency, description, facts_digest, status,
      next_attempt_at
    ) values (
      ${randomUUID()}, ${tenantId}, 'sales', ${documentType}, ${line.entryId}, ${line.period},
      ${delivery?.deliveryId ?? null}, ${delivery?.serviceOrderId ?? null},
      ${contract?.billedPeriodId ?? null}, ${contract?.contractId ?? null}, ${line.customerId},
      ${line.serviceItemId}, ${line.competenceDate}, ${line.amount.amount},
      ${line.amount.currency}, ${line.description}, ${digest}, 'pending', now()
    ) on conflict on constraint fiscal_service_intake_entry_key do nothing`
  const [existing] = await tx`select facts_digest from fiscal_service_intakes
    where tenant_id = ${tenantId} and entry_id = ${line.entryId}`
  if (existing?.facts_digest !== digest)
    throw new Error(
      documentType === 'service-delivery'
        ? 'Conflicting service delivery facts for an existing entry'
        : 'Conflicting contract period facts for an existing entry',
    )
}
