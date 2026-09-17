import {
  type EventEnvelope,
  financialPayablePosted,
  financialPayableReversed,
  financialReceivablePosted,
  financialReceivableReversed,
  financialSettlementRecorded,
  financialSettlementReversed,
  treasuryEntryRecorded,
  treasuryTransferCancelled,
  treasuryTransferPosted,
} from '@horizon/contracts'
import type { Fact } from '@/domain/services/posting-rules'
import type { EventHandler } from '@/infrastructure/messaging/rabbitmq-transport'
import type { Clock } from './ports/clock'
import type { LedgerScope, LedgerUnitOfWork, ReceivedEvent } from './ports/unit-of-work'
import { PostFactUseCase, ReverseFactUseCase } from './use-cases/post-facts'

/**
 * Treasury lines the ledger deliberately ignores.
 *
 * A transfer leg, its fee, a settlement and a reversal all reach the ledger through the
 * fact that caused them — the transfer, the settlement, the reversal of either. Posting the
 * journal line as well would count every one of them twice.
 */
const ACCOUNTED_ELSEWHERE = new Set(['transfer', 'transfer-fee', 'settlement', 'reversal'])

export class LedgerModuleEventHandlers {
  readonly handlers: Readonly<Record<string, EventHandler>>
  private readonly post: PostFactUseCase
  private readonly reverse: ReverseFactUseCase

  constructor(
    private readonly unitOfWork: LedgerUnitOfWork,
    clock: Clock,
  ) {
    this.post = new PostFactUseCase(clock)
    this.reverse = new ReverseFactUseCase(clock)
    this.handlers = {
      'financial.receivable.posted': (event) => this.titlePosted(event, 'receivable'),
      'financial.payable.posted': (event) => this.titlePosted(event, 'payable'),
      'financial.receivable.reversed': (event) => this.titleReversed(event, 'receivable'),
      'financial.payable.reversed': (event) => this.titleReversed(event, 'payable'),
      'financial.settlement.recorded': (event) => this.settlementRecorded(event),
      'financial.settlement.reversed': (event) => this.settlementReversed(event),
      'treasury.transfer.posted': (event) => this.transferPosted(event),
      'treasury.transfer.cancelled': (event) => this.transferCancelled(event),
      'treasury.entry.recorded': (event) => this.entryRecorded(event),
    }
  }

  private async titlePosted(event: EventEnvelope, kind: 'receivable' | 'payable'): Promise<void> {
    const definition = kind === 'receivable' ? financialReceivablePosted : financialPayablePosted
    const parsed = definition.envelope.parse(event)
    const { payload } = parsed
    await this.handle(parsed, 'financial', (scope) =>
      this.post.executeInScope(scope, {
        kind,
        id: payload.titleId,
        reference: payload.documentNumber,
        // The competence date, not the issue date: it is the month the revenue was earned
        // or the cost incurred, which is the month the books have to show it in.
        on: payload.competenceOn,
        currency: payload.total.currency,
        categoryId: payload.categoryId,
        total: BigInt(payload.total.amount),
      }),
    )
  }

  private async titleReversed(event: EventEnvelope, kind: 'receivable' | 'payable'): Promise<void> {
    const definition =
      kind === 'receivable' ? financialReceivableReversed : financialPayableReversed
    const parsed = definition.envelope.parse(event)
    await this.handle(
      parsed,
      'financial',
      this.undo(kind, parsed.payload.titleId, parsed.payload.reason),
    )
  }

  private async settlementRecorded(event: EventEnvelope): Promise<void> {
    const parsed = financialSettlementRecorded.envelope.parse(event)
    const { payload } = parsed
    await this.handle(parsed, 'financial', async (scope) => {
      const fact: Fact = {
        kind: 'settlement',
        id: payload.settlementId,
        reference:
          payload.documentNumber ?? (await referenceOf(scope, payload.direction, payload.titleId)),
        on: payload.settledOn,
        currency: payload.received.currency,
        direction: payload.direction,
        treasuryAccountId: payload.treasuryAccountId ?? null,
        received: BigInt(payload.received.amount),
        discount: BigInt(payload.discount.amount),
        interest: BigInt(payload.interest.amount),
        penalty: BigInt(payload.penalty.amount),
      }
      return this.post.executeInScope(scope, fact)
    })
  }

  private async settlementReversed(event: EventEnvelope): Promise<void> {
    const parsed = financialSettlementReversed.envelope.parse(event)
    await this.handle(
      parsed,
      'financial',
      this.undo('settlement', parsed.payload.settlementId, parsed.payload.reason),
    )
  }

  private async transferPosted(event: EventEnvelope): Promise<void> {
    const parsed = treasuryTransferPosted.envelope.parse(event)
    const { payload } = parsed
    await this.handle(parsed, 'treasury', (scope) =>
      this.post.executeInScope(scope, {
        kind: 'transfer',
        id: payload.transferId,
        reference: `Transfer ${payload.transferId.slice(0, 8)}`,
        on: payload.valueOn,
        currency: payload.amount.currency,
        fromAccountId: payload.fromAccountId,
        toAccountId: payload.toAccountId,
        amount: BigInt(payload.amount.amount),
        fee: payload.fee ? BigInt(payload.fee.amount) : 0n,
      }),
    )
  }

  private async transferCancelled(event: EventEnvelope): Promise<void> {
    const parsed = treasuryTransferCancelled.envelope.parse(event)
    await this.handle(
      parsed,
      'treasury',
      this.undo('transfer', parsed.payload.transferId, parsed.payload.reason),
    )
  }

  private async entryRecorded(event: EventEnvelope): Promise<void> {
    const parsed = treasuryEntryRecorded.envelope.parse(event)
    const { payload } = parsed
    if (ACCOUNTED_ELSEWHERE.has(payload.source.type)) return
    const source = payload.source.type === 'opening' ? 'opening' : 'manual'
    await this.handle(parsed, 'treasury', (scope) =>
      this.post.executeInScope(scope, {
        kind: 'treasury-entry',
        id: payload.entryId,
        reference:
          source === 'opening' ? 'Opening balance' : `Entry ${payload.entryId.slice(0, 8)}`,
        on: payload.valueOn,
        currency: payload.amount.currency,
        accountId: payload.accountId,
        source,
        direction: payload.direction,
        amount: BigInt(payload.amount.amount),
      }),
    )
  }

  private async handle<T>(
    event: EventEnvelope,
    sourceModule: string,
    work: (scope: LedgerScope) => Promise<T>,
  ): Promise<void> {
    const received: ReceivedEvent = {
      sourceModule,
      eventId: event.eventId,
      eventType: event.eventType,
    }
    await this.unitOfWork.processEvent(event.tenantId, received, work)
  }

  /**
   * Undo what a fact posted, or fail loudly.
   *
   * A posting the workspace has not configured yet waits as a pending fact, because the
   * books contain nothing wrong in the meantime. A reversal that cannot be applied is the
   * opposite case: the books already hold something now known to be wrong. Throwing rolls
   * the inbox claim back with it, so the event is redelivered until the month is reopened
   * and, failing that, becomes visible in the dead-letter queue.
   */
  private undo(
    kind: Fact['kind'],
    factId: string,
    why: string,
  ): (scope: LedgerScope) => Promise<unknown> {
    return async (scope) => {
      const outcome = await this.reverse.executeInScope(scope, kind, factId, why)
      if (outcome.isLeft()) throw outcome.value
      return outcome.value
    }
  }
}

/**
 * The document number the title was posted under.
 *
 * Only for a settlement published before `documentNumber` was part of the event: the two
 * events race through the queue, so looking the title up is not reliable on its own.
 */
async function referenceOf(
  scope: LedgerScope,
  direction: 'receivable' | 'payable',
  titleId: string,
): Promise<string> {
  const title = await scope.facts.find(direction, titleId)
  return title?.reference ?? `Settlement ${titleId.slice(0, 8)}`
}
