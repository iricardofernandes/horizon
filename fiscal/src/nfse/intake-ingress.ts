import { randomUUID } from 'node:crypto'
import { salesServiceDelivered, salesServiceDeliveryCancelled } from '@horizon/contracts'
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
    const facts = {
      entryId: line.entryId,
      period: delivery.competence,
      deliveryId: delivery.deliveryId,
      serviceOrderId: delivery.serviceOrderId,
      customerId: delivery.customerId,
      serviceItemId: line.itemId,
      competenceDate: delivery.performedOn,
      amount: line.amount,
      description: line.description,
    }
    const digest = canonicalDigest(facts)
    await tx`insert into fiscal_service_intakes (
        id, tenant_id, source_module, source_document_type, entry_id, period, delivery_id,
        service_order_id, customer_id, service_item_id, competence_date, amount_minor,
        currency, description, facts_digest, status, next_attempt_at
      ) values (
        ${randomUUID()}, ${tenantId}, 'sales', 'service-delivery', ${line.entryId},
        ${delivery.competence}, ${delivery.deliveryId}, ${delivery.serviceOrderId},
        ${delivery.customerId}, ${line.itemId}, ${delivery.performedOn}, ${line.amount.amount},
        ${line.amount.currency}, ${line.description}, ${digest}, 'pending', now()
      ) on conflict on constraint fiscal_service_intake_entry_key do nothing`
    const [existing] = await tx`select facts_digest from fiscal_service_intakes
      where tenant_id = ${tenantId} and entry_id = ${line.entryId}`
    if (existing?.facts_digest !== digest)
      throw new Error('Conflicting service delivery facts for an existing entry')
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
