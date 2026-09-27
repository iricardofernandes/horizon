import type { DomainEvent } from '../events/domain-event'
import { Entity } from './entity'

export abstract class AggregateRoot<Props> extends Entity<Props> {
  private events: DomainEvent[] = []
  protected addDomainEvent(event: DomainEvent): void {
    this.events.push(event)
  }
  pullDomainEvents(): readonly DomainEvent[] {
    const pending = this.events
    this.events = []
    return pending
  }
  get hasPendingEvents(): boolean {
    return this.events.length > 0
  }
}
