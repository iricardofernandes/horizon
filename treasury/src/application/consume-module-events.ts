import {
  type EventEnvelope,
  financialSettlementRecorded,
  financialSettlementReversed,
} from '@horizon/contracts'
import type { EventHandler } from '@/infrastructure/messaging/rabbitmq-transport'
import type { Clock } from './ports/clock'
import type { ReceivedEvent, TreasuryUnitOfWork } from './ports/unit-of-work'
import {
  RecordSettlementEntryUseCase,
  ReverseSettlementEntryUseCase,
} from './use-cases/record-settlements'

export class TreasuryModuleEventHandlers {
  readonly handlers: Readonly<Record<string, EventHandler>>
  private readonly record: RecordSettlementEntryUseCase
  private readonly reverse: ReverseSettlementEntryUseCase

  constructor(
    private readonly unitOfWork: TreasuryUnitOfWork,
    clock: Clock,
  ) {
    this.record = new RecordSettlementEntryUseCase(clock)
    this.reverse = new ReverseSettlementEntryUseCase(clock)
    this.handlers = {
      'financial.settlement.recorded': (event) => this.settlementRecorded(event),
      'financial.settlement.reversed': (event) => this.settlementReversed(event),
    }
  }

  private async settlementRecorded(event: EventEnvelope): Promise<void> {
    const parsed = financialSettlementRecorded.envelope.parse(event)
    const outcome = await this.unitOfWork.processEvent(parsed.tenantId, received(parsed), (scope) =>
      this.record.executeInScope(scope, parsed.payload),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }

  private async settlementReversed(event: EventEnvelope): Promise<void> {
    const parsed = financialSettlementReversed.envelope.parse(event)
    const outcome = await this.unitOfWork.processEvent(parsed.tenantId, received(parsed), (scope) =>
      this.reverse.executeInScope(scope, parsed.payload),
    )
    if (outcome.processed && outcome.value.isLeft()) throw outcome.value.value
  }
}

function received(event: EventEnvelope): ReceivedEvent {
  return { sourceModule: 'financial', eventId: event.eventId, eventType: event.eventType }
}
