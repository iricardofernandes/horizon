import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import type { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { TreasuryEvent } from '../events/treasury-events'
import type { Reason } from '../value-objects/treasury-values'

export const RECONCILIATION_KINDS = ['match', 'ignore'] as const
export type ReconciliationKind = (typeof RECONCILIATION_KINDS)[number]
export const RECONCILIATION_ORIGINS = ['manual', 'suggestion'] as const
export type ReconciliationOrigin = (typeof RECONCILIATION_ORIGINS)[number]

/**
 * A statement line or journal entry as reconciliation sees it: its signed amount, and how
 * much of it is not yet part of a reconciliation in force.
 */
export interface OpenItem {
  readonly id: string
  readonly accountId: string
  readonly date: string
  /** Signed minor units. */
  readonly amount: bigint
  /** Unsigned minor units still unreconciled. */
  readonly available: bigint
}

export interface ReconciliationItem {
  readonly kind: 'statement' | 'entry'
  readonly id: string
  /** Signed minor units applied, with the sign of the item. */
  readonly applied: bigint
  readonly date: string
}

interface ReconciliationProps {
  tenantId: string
  accountId: string
  kind: ReconciliationKind
  origin: ReconciliationOrigin
  suggestionKey: string | null
  suggestionScore: number | null
  corrected: boolean
  items: readonly ReconciliationItem[]
  reason: Reason | null
  status: 'active' | 'undone'
  confirmedBy: string
  confirmedAt: Date
  undo: { readonly by: string; readonly at: Date; readonly reason: Reason } | null
}

export interface ReconciliationSnapshot {
  readonly id: string
  readonly tenantId: string
  readonly accountId: string
  readonly kind: ReconciliationKind
  readonly origin: ReconciliationOrigin
  readonly suggestionKey: string | null
  readonly suggestionScore: number | null
  readonly corrected: boolean
  readonly items: readonly { kind: 'statement' | 'entry'; id: string; applied: string }[]
  readonly reason: string | null
  readonly status: 'active' | 'undone'
  readonly confirmedBy: string
  readonly confirmedAt: Date
  readonly undoneBy: string | null
  readonly undoneAt: Date | null
  readonly undoReason: string | null
}

export interface SuggestionReference {
  readonly key: string
  readonly score: number
  readonly statementLineIds: readonly string[]
  readonly entryIds: readonly string[]
}

type Selection = readonly { readonly item: OpenItem; readonly amount?: bigint | undefined }[]

function applied(
  kind: ReconciliationItem['kind'],
  accountId: string,
  selection: Selection,
): Either<InvalidInputError, ReconciliationItem[]> {
  const items: ReconciliationItem[] = []
  const seen = new Set<string>()
  for (const [index, { item, amount }] of selection.entries()) {
    const field = `/${kind === 'statement' ? 'statementLines' : 'entries'}/${index}`
    if (seen.has(item.id)) return left(new InvalidInputError(field, 'is selected twice'))
    seen.add(item.id)
    if (item.accountId !== accountId)
      return left(new InvalidInputError(field, 'belongs to another account'))
    const size = amount ?? item.available
    if (size <= 0n || size > item.available)
      return left(
        new InvalidInputError(
          field,
          `must apply between 0.01 and the ${item.available} unreconciled`,
        ),
      )
    items.push({ kind, id: item.id, applied: item.amount < 0n ? -size : size, date: item.date })
  }
  return right(items)
}

const total = (items: readonly ReconciliationItem[]) =>
  items.reduce((sum, item) => sum + item.applied, 0n)

/**
 * A person's statement that bank lines and journal entries are the same movements — one to
 * one, one to many, many to one, or partially — or that bank lines are to be ignored. It
 * always balances, and it is undone rather than deleted (ADR 0046).
 */
export class Reconciliation extends AggregateRoot<ReconciliationProps> {
  static match(
    props: {
      tenantId: string
      accountId: string
      currency: string
      statementLines: Selection
      entries: Selection
      suggestion: SuggestionReference | null
      actor: string
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<InvalidInputError | ConflictError, Reconciliation> {
    if (props.statementLines.length === 0 || props.entries.length === 0)
      return left(new InvalidInputError('/statementLines', 'a match needs bank lines and entries'))
    const lines = applied('statement', props.accountId, props.statementLines)
    if (lines.isLeft()) return left(lines.value)
    const entries = applied('entry', props.accountId, props.entries)
    if (entries.isLeft()) return left(entries.value)
    const difference = total(lines.value) - total(entries.value)
    if (difference !== 0n)
      return left(
        new ConflictError(
          `the selection is ${difference} minor units apart; match partially or add an adjustment`,
        ),
      )
    const suggestion = props.suggestion
    const corrected = suggestion ? !sameSelection(suggestion, lines.value, entries.value) : false
    return right(
      Reconciliation.confirm(
        {
          tenantId: props.tenantId,
          accountId: props.accountId,
          kind: 'match',
          origin: suggestion ? 'suggestion' : 'manual',
          suggestionKey: suggestion?.key ?? null,
          suggestionScore: suggestion?.score ?? null,
          corrected,
          items: [...lines.value, ...entries.value],
          reason: null,
          status: 'active',
          confirmedBy: props.actor,
          confirmedAt: props.now,
          undo: null,
        },
        props.currency,
        id,
      ),
    )
  }

  static ignore(
    props: {
      tenantId: string
      accountId: string
      currency: string
      statementLines: Selection
      reason: Reason
      actor: string
      now: Date
    },
    id?: UniqueEntityID,
  ): Either<InvalidInputError, Reconciliation> {
    if (props.statementLines.length === 0)
      return left(new InvalidInputError('/statementLines', 'select at least one bank line'))
    const lines = applied('statement', props.accountId, props.statementLines)
    if (lines.isLeft()) return left(lines.value)
    return right(
      Reconciliation.confirm(
        {
          tenantId: props.tenantId,
          accountId: props.accountId,
          kind: 'ignore',
          origin: 'manual',
          suggestionKey: null,
          suggestionScore: null,
          corrected: false,
          items: lines.value,
          reason: props.reason,
          status: 'active',
          confirmedBy: props.actor,
          confirmedAt: props.now,
          undo: null,
        },
        props.currency,
        id,
      ),
    )
  }

  private static confirm(
    props: ReconciliationProps,
    currency: string,
    id?: UniqueEntityID,
  ): Reconciliation {
    const reconciliation = new Reconciliation(props, id)
    const ofKind = (kind: ReconciliationItem['kind']) =>
      props.items.filter((item) => item.kind === kind)
    const amount = total(ofKind('statement'))
    reconciliation.addDomainEvent(
      new TreasuryEvent(
        'treasury.reconciliation.confirmed',
        reconciliation.id,
        props.tenantId,
        props.confirmedAt,
        {
          reconciliationId: reconciliation.id.toString(),
          accountId: props.accountId,
          kind: props.kind,
          origin: props.origin,
          statementLineIds: ofKind('statement').map((item) => item.id),
          entryIds: ofKind('entry').map((item) => item.id),
          amount: { amount: (amount < 0n ? -amount : amount).toString(), currency },
          confirmedAt: props.confirmedAt.toISOString(),
        },
      ),
    )
    return reconciliation
  }

  static rehydrate(props: ReconciliationProps, id: UniqueEntityID): Reconciliation {
    return new Reconciliation(props, id)
  }

  get accountId(): string {
    return this.props.accountId
  }

  get items(): readonly ReconciliationItem[] {
    return this.props.items
  }

  /** The latest date among its lines and entries: a closed period covering it freezes it. */
  latestDate(): string {
    return this.props.items.reduce((latest, item) => (item.date > latest ? item.date : latest), '')
  }

  undo(reason: Reason, actor: string, now: Date): Either<ConflictError, void> {
    if (this.props.status !== 'active')
      return left(new ConflictError('the reconciliation is already undone'))
    this.props.status = 'undone'
    this.props.undo = { by: actor, at: now, reason }
    this.addDomainEvent(
      new TreasuryEvent('treasury.reconciliation.undone', this.id, this.props.tenantId, now, {
        reconciliationId: this.id.toString(),
        accountId: this.props.accountId,
        undoneAt: now.toISOString(),
        reason: reason.value,
      }),
    )
    return right(undefined)
  }

  toSnapshot(): Readonly<ReconciliationSnapshot> {
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      accountId: this.props.accountId,
      kind: this.props.kind,
      origin: this.props.origin,
      suggestionKey: this.props.suggestionKey,
      suggestionScore: this.props.suggestionScore,
      corrected: this.props.corrected,
      items: this.props.items.map((item) => ({
        kind: item.kind,
        id: item.id,
        applied: item.applied.toString(),
      })),
      reason: this.props.reason?.value ?? null,
      status: this.props.status,
      confirmedBy: this.props.confirmedBy,
      confirmedAt: this.props.confirmedAt,
      undoneBy: this.props.undo?.by ?? null,
      undoneAt: this.props.undo?.at ?? null,
      undoReason: this.props.undo?.reason.value ?? null,
    })
  }
}

function sameSelection(
  suggestion: SuggestionReference,
  lines: readonly ReconciliationItem[],
  entries: readonly ReconciliationItem[],
): boolean {
  const key = (ids: readonly string[]) => [...ids].sort().join(',')
  return (
    key(suggestion.statementLineIds) === key(lines.map((item) => item.id)) &&
    key(suggestion.entryIds) === key(entries.map((item) => item.id))
  )
}
