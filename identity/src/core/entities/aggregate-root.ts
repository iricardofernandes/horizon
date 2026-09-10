import type { DomainEvent } from '../events/domain-event'
import { Entity } from './entity'

/**
 * An entity that is the consistency boundary for a cluster of objects, and the only
 * thing a repository loads or saves.
 *
 * It accumulates the events its behaviour produced. Nothing dispatches them here: the
 * repository drains them with `pullDomainEvents()` and writes them to the outbox inside
 * the same transaction as the state change (ADR 0024).
 */
export abstract class AggregateRoot<Props> extends Entity<Props> {
  private _domainEvents: DomainEvent[] = []

  protected addDomainEvent(event: DomainEvent): void {
    this._domainEvents.push(event)
  }

  /**
   * Take the recorded events, leaving the aggregate empty.
   *
   * Draining rather than reading is deliberate: an aggregate saved twice in one
   * transaction must not publish its events twice, and making the read destructive is
   * what removes the question.
   */
  pullDomainEvents(): readonly DomainEvent[] {
    const events = this._domainEvents
    this._domainEvents = []
    return events
  }

  get hasPendingEvents(): boolean {
    return this._domainEvents.length > 0
  }
}
