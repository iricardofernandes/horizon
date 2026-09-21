import { catalogCompositionDefined, type EventEnvelope } from '@horizon/contracts'
import { Quantity } from '@/domain/value-objects/inventory-values'
import type { EventHandler } from '@/infrastructure/messaging/rabbitmq-transport'
import type { Clock } from './ports/clock'
import type { InventoryUnitOfWork } from './ports/unit-of-work'

/**
 * What the catalogue says things are made of, kept where production can reach it.
 *
 * A copy rather than a question asked across a boundary. An order has to be releasable
 * when the catalogue is down, and the version it was released under has to stay readable
 * after the catalogue has moved on — neither of which a lookup at release time could
 * promise.
 *
 * A version is heard once and never revised: a recipe that changed is another version,
 * so a redelivery is the same message arriving twice rather than a change of mind.
 */
export class InventoryCatalogEventHandlers {
  readonly handlers: Readonly<Record<string, EventHandler>>

  constructor(
    private readonly unitOfWork: InventoryUnitOfWork,
    private readonly clock: Clock,
  ) {
    this.handlers = {
      'catalog.composition.defined': (event) => this.compositionDefined(event),
    }
  }

  private async compositionDefined(event: EventEnvelope): Promise<void> {
    const parsed = catalogCompositionDefined.envelope.parse(event)
    await this.unitOfWork.processEvent(
      parsed.tenantId,
      { sourceModule: 'catalog', eventId: parsed.eventId, eventType: parsed.eventType },
      async (scope) => {
        await scope.compositions.record(
          {
            parentItemId: parsed.payload.parentItemId,
            version: parsed.payload.version,
            realisation: parsed.payload.realisation,
            effectiveFrom: parsed.payload.effectiveFrom,
            components: parsed.payload.lines.map((line) => ({
              itemId: line.componentItemId,
              perUnit: restored(line.quantity),
            })),
          },
          this.clock.now(),
        )
      },
    )
  }
}

/** The wire has already been validated by the schema, so a bad quantity is a bug here. */
function restored(quantity: string): Quantity {
  const parsed = Quantity.create(quantity)
  if (parsed.isLeft()) throw new Error('Invalid quantity on a validated composition event')
  return parsed.value
}
