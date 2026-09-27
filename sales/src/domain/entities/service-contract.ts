import { type Either, left, right } from '@/core/either'
import { AggregateRoot } from '@/core/entities/aggregate-root'
import { UniqueEntityID } from '@/core/entities/unique-entity-id'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import {
  SalesContractActivatedEvent,
  SalesContractAmendedEvent,
  SalesContractCancelledEvent,
  SalesContractSuspendedEvent,
} from '../events/sales-events'
import {
  addMonths,
  type ContractLine,
  type ContractRevision,
  isFirstOfMonth,
  isPeriodEnd,
  isPeriodStart,
  periodStarts,
  type Recurrence,
  readjusted,
  revisionAt,
  type SchedulePeriod,
  type Suspension,
  scheduleOf,
} from '../services/contract-schedule'
import type { BusinessDate, Currency, PaymentTerms, Reason } from '../value-objects/sales-values'

export const CONTRACT_STAGES = ['draft', 'active', 'discarded'] as const
export type ContractStage = (typeof CONTRACT_STAGES)[number]
export type ContractStatus = 'draft' | 'active' | 'suspended' | 'cancelled' | 'ended'

interface ServiceContractProps {
  tenantId: string
  customerId: string
  currency: Currency
  startsOn: BusinessDate
  endsOn: BusinessDate | null
  billingDay: number
  autoRenew: boolean
  /** The original term in months, which a renewal repeats; null without an end date. */
  termMonths: number | null
  paymentTerms: PaymentTerms
  sellerId: string | null
  notes: string | null
  stage: ContractStage
  revisions: readonly ContractRevision[]
  suspensions: readonly Suspension[]
  cancellation: {
    readonly from: BusinessDate
    readonly reason: Reason
    readonly by: string
    readonly at: Date
  } | null
  createdBy: string
  activatedAt: Date | null
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface ServiceContractInput {
  readonly tenantId: string
  readonly customerId: string
  readonly currency: Currency
  readonly lines: readonly ContractLine[]
  readonly recurrence: Recurrence
  readonly startsOn: BusinessDate
  readonly endsOn: BusinessDate | null
  readonly billingDay: number
  readonly autoRenew: boolean
  readonly paymentTerms: PaymentTerms
  readonly sellerId: string | null
  readonly notes: string | null
  readonly createdBy: string
  readonly now: Date
}

type Change = { readonly today: BusinessDate; readonly actor: string }

/**
 * Services sold for a recurring fee (ADR 0056).
 *
 * What it bills lives in immutable **revisions**, each in force from a period start. An
 * amendment, a suspension or a cancellation takes effect at a period that has not begun,
 * so a period that has begun keeps what it had. A renewal continues the schedule the day
 * after the end, for the original term, as one more revision.
 */
export class ServiceContract extends AggregateRoot<ServiceContractProps> {
  static draft(
    input: ServiceContractInput,
    id?: UniqueEntityID,
  ): Either<InvalidInputError, ServiceContract> {
    const lines = checkLines(input.lines, input.currency)
    if (lines.isLeft()) return left(lines.value)
    if (!isFirstOfMonth(input.startsOn))
      return left(new InvalidInputError('/startsOn', 'a contract starts on the first of a month'))
    if (!Number.isInteger(input.billingDay) || input.billingDay < 1 || input.billingDay > 28)
      return left(new InvalidInputError('/billingDay', 'the billing day is between 1 and 28'))
    const revision: ContractRevision = {
      number: 1,
      kind: 'initial',
      effectiveFrom: input.startsOn,
      recurrence: input.recurrence,
      lines: input.lines,
      readjustmentBasisPoints: null,
      reason: null,
      createdBy: input.createdBy,
      createdAt: input.now,
    }
    const grid = { startsOn: input.startsOn, revisions: [revision] }
    if (
      input.endsOn &&
      (!input.startsOn.isBefore(input.endsOn) || !isPeriodEnd(grid, input.endsOn))
    )
      return left(new InvalidInputError('/endsOn', 'a contract ends on the last day of a period'))
    if (input.autoRenew && !input.endsOn)
      return left(new InvalidInputError('/autoRenew', 'only a contract with an end date renews'))
    return right(
      new ServiceContract(
        {
          tenantId: input.tenantId,
          customerId: input.customerId,
          currency: input.currency,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          billingDay: input.billingDay,
          autoRenew: input.autoRenew,
          termMonths: input.endsOn ? monthsBetween(input.startsOn, input.endsOn) : null,
          paymentTerms: input.paymentTerms,
          sellerId: input.sellerId,
          notes: input.notes,
          stage: 'draft',
          revisions: [revision],
          suspensions: [],
          cancellation: null,
          createdBy: input.createdBy,
          activatedAt: null,
          version: 1,
          createdAt: input.now,
          updatedAt: input.now,
        },
        id ?? new UniqueEntityID(),
      ),
    )
  }

  static rehydrate(props: ServiceContractProps, id: UniqueEntityID): ServiceContract {
    return new ServiceContract(props, id)
  }

  get tenantId(): string {
    return this.props.tenantId
  }

  get customerId(): string {
    return this.props.customerId
  }

  get version(): number {
    return this.props.version
  }

  get endsOn(): BusinessDate | null {
    return this.props.endsOn
  }

  get autoRenew(): boolean {
    return this.props.autoRenew
  }

  revisions(): readonly ContractRevision[] {
    return this.props.revisions
  }

  statusOn(day: BusinessDate): ContractStatus {
    if (this.props.stage === 'draft') return 'draft'
    if (this.props.stage === 'discarded') return 'cancelled'
    if (this.props.cancellation && !day.isBefore(this.props.cancellation.from)) return 'cancelled'
    if (this.props.endsOn?.isBefore(day)) return 'ended'
    const suspended = this.props.suspensions.some(
      (suspension) =>
        !day.isBefore(suspension.from) && (!suspension.until || day.isBefore(suspension.until)),
    )
    return suspended ? 'suspended' : 'active'
  }

  schedule(range: { from: BusinessDate; to: BusinessDate }): readonly SchedulePeriod[] {
    return scheduleOf(
      {
        currency: this.props.currency,
        startsOn: this.props.startsOn,
        endsOn: this.props.endsOn,
        billingDay: this.props.billingDay,
        revisions: this.props.revisions,
        suspensions: this.props.suspensions,
        cancelledFrom: this.props.cancellation?.from ?? null,
      },
      range,
    )
  }

  activate(now: Date): Either<ConflictError, void> {
    if (this.props.stage !== 'draft')
      return left(new ConflictError('only a draft contract can be activated'))
    const [first] = this.props.revisions
    if (!first) return left(new ConflictError('a contract needs its first revision'))
    this.props.stage = 'active'
    this.props.activatedAt = now
    this.touch(now)
    this.addDomainEvent(
      new SalesContractActivatedEvent(this.id, this.props.tenantId, now, {
        customerId: this.props.customerId,
        revision: first.number,
        recurrence: first.recurrence,
        startsOn: this.props.startsOn,
        endsOn: this.props.endsOn,
        billingDay: this.props.billingDay,
        autoRenew: this.props.autoRenew,
      }),
    )
    return right(undefined)
  }

  /** New prices, quantities, lines or recurrence from a period that has not begun. */
  amend(
    input: Change & {
      readonly effectiveFrom: BusinessDate
      readonly lines: readonly ContractLine[]
      readonly recurrence: Recurrence
      readonly reason: Reason
    },
    now: Date,
  ): Either<InvalidInputError | ConflictError, ContractRevision> {
    const lines = checkLines(input.lines, this.props.currency)
    if (lines.isLeft()) return left(lines.value)
    const open = this.changeable(input.effectiveFrom, input.today, '/effectiveFrom')
    if (open.isLeft()) return left(open.value)
    const latest = this.latestRevision()
    if (input.effectiveFrom.isBefore(latest.effectiveFrom))
      return left(
        new ConflictError(
          `revision ${latest.number} already applies from ${latest.effectiveFrom.value}; amend from then on`,
        ),
      )
    const revision: ContractRevision = {
      number: latest.number + 1,
      kind: 'amendment',
      effectiveFrom: input.effectiveFrom,
      recurrence: input.recurrence,
      lines: input.lines,
      readjustmentBasisPoints: null,
      reason: input.reason,
      createdBy: input.actor,
      createdAt: now,
    }
    const revisions = [...this.props.revisions, revision]
    if (
      this.props.endsOn &&
      !isPeriodEnd({ startsOn: this.props.startsOn, revisions }, this.props.endsOn)
    )
      return left(
        new ConflictError('with this recurrence the contract would not end on a period end'),
      )
    this.props.revisions = revisions
    this.record(revision, now)
    return right(revision)
  }

  /**
   * Continue the contract for its original term from the day after it ends, readjusting
   * every price by a reviewer's percentage when there is one. Automatic renewal carries no
   * readjustment and waits for the last period to begin.
   */
  renew(
    input: Change & {
      readonly readjustmentBasisPoints: number | null
      readonly reason: Reason | null
      readonly automatic: boolean
    },
    now: Date,
  ): Either<InvalidInputError | ConflictError, ContractRevision> {
    const { endsOn, termMonths } = this.props
    if (this.props.stage !== 'active' || !endsOn || !termMonths)
      return left(new ConflictError('only an active contract with an end date renews'))
    if (this.props.cancellation && !endsOn.isBefore(this.props.cancellation.from))
      return left(new ConflictError('a cancelled contract does not renew'))
    const bp = input.readjustmentBasisPoints
    if (bp !== null && (!Number.isInteger(bp) || bp < -10_000 || bp > 100_000))
      return left(new InvalidInputError('/readjustmentBasisPoints', 'must be whole basis points'))
    if (input.automatic && (!this.props.autoRenew || bp !== null))
      return left(new ConflictError('this contract does not renew by itself'))
    const effectiveFrom = endsOn.plusDays(1)
    const current = revisionAt(this.props.revisions, endsOn)
    if (!current) return left(new ConflictError('the contract has no revision in force'))
    if (input.automatic && input.today.isBefore(this.lastPeriodStart(endsOn)))
      return left(new ConflictError('the last period has not begun yet'))
    const nextEnd = addMonths(effectiveFrom, termMonths).plusDays(-1)
    const revision: ContractRevision = {
      number: this.latestRevision().number + 1,
      kind: 'renewal',
      effectiveFrom,
      recurrence: current.recurrence,
      lines: current.lines.map((line) => ({
        ...line,
        unitPrice: bp === null ? line.unitPrice : readjusted(line.unitPrice, bp),
      })),
      readjustmentBasisPoints: bp,
      reason: input.reason,
      createdBy: input.actor,
      createdAt: now,
    }
    const revisions = [...this.props.revisions, revision]
    if (!isPeriodEnd({ startsOn: this.props.startsOn, revisions }, nextEnd))
      return left(new ConflictError('the original term does not fit the current recurrence'))
    this.props.revisions = revisions
    this.props.endsOn = nextEnd
    this.record(revision, now)
    return right(revision)
  }

  /** Stop billing from a period start, until the period it resumes at when known. */
  suspend(
    input: Change & {
      readonly suspensionId: string
      readonly from: BusinessDate
      readonly until: BusinessDate | null
      readonly reason: Reason
    },
    now: Date,
  ): Either<InvalidInputError | ConflictError, void> {
    const open = this.changeable(input.from, input.today, '/from')
    if (open.isLeft()) return left(open.value)
    if (input.until) {
      const resumes = this.checkResumption(input.from, input.until)
      if (resumes.isLeft()) return left(resumes.value)
    }
    const overlaps = this.props.suspensions.some(
      (other) =>
        (!other.until || input.from.isBefore(other.until)) &&
        (!input.until || other.from.isBefore(input.until)),
    )
    if (overlaps) return left(new ConflictError('the contract is already suspended then'))
    const suspension: Suspension = {
      id: input.suspensionId,
      from: input.from,
      until: input.until,
      reason: input.reason,
      createdBy: input.actor,
      createdAt: now,
    }
    this.props.suspensions = [...this.props.suspensions, suspension]
    this.touch(now)
    this.announceSuspension(suspension, now)
    return right(undefined)
  }

  /** Bill again from `at`, which ends the suspension that has no end yet. */
  resume(
    input: Change & { readonly at: BusinessDate },
    now: Date,
  ): Either<InvalidInputError | ConflictError, void> {
    const suspension = this.props.suspensions.find((candidate) => !candidate.until)
    if (!suspension) return left(new ConflictError('the contract has no open suspension'))
    const open = this.changeable(input.at, input.today, '/at')
    if (open.isLeft()) return left(open.value)
    const resumes = this.checkResumption(suspension.from, input.at)
    if (resumes.isLeft()) return left(resumes.value)
    const resumed = { ...suspension, until: input.at }
    this.props.suspensions = this.props.suspensions.map((candidate) =>
      candidate.id === suspension.id ? resumed : candidate,
    )
    this.touch(now)
    this.announceSuspension(resumed, now)
    return right(undefined)
  }

  /**
   * No period is billed from `from` on. A draft that never took effect is simply discarded.
   */
  cancel(
    input: Change & { readonly from: BusinessDate | null; readonly reason: Reason },
    now: Date,
  ): Either<InvalidInputError | ConflictError, void> {
    if (this.props.stage === 'discarded' || this.props.cancellation)
      return left(new ConflictError('the contract is already cancelled'))
    if (this.props.stage === 'draft') {
      this.props.stage = 'discarded'
      this.props.cancellation = {
        from: this.props.startsOn,
        reason: input.reason,
        by: input.actor,
        at: now,
      }
      this.touch(now)
      return right(undefined)
    }
    if (!input.from)
      return left(new InvalidInputError('/from', 'say from which period the contract stops'))
    const open = this.changeable(input.from, input.today, '/from')
    if (open.isLeft()) return left(open.value)
    this.props.cancellation = { from: input.from, reason: input.reason, by: input.actor, at: now }
    this.touch(now)
    this.addDomainEvent(
      new SalesContractCancelledEvent(this.id, this.props.tenantId, now, {
        customerId: this.props.customerId,
        effectiveFrom: input.from,
        reason: input.reason.value,
      }),
    )
    return right(undefined)
  }

  toSnapshot() {
    const money = (value: { amount: bigint }) => value.amount.toString()
    return Object.freeze({
      id: this.id.toString(),
      tenantId: this.props.tenantId,
      customerId: this.props.customerId,
      currency: this.props.currency.value,
      startsOn: this.props.startsOn.value,
      endsOn: this.props.endsOn?.value ?? null,
      billingDay: this.props.billingDay,
      autoRenew: this.props.autoRenew,
      termMonths: this.props.termMonths,
      paymentTermDays: [...this.props.paymentTerms.days],
      sellerId: this.props.sellerId,
      notes: this.props.notes,
      stage: this.props.stage,
      cancelledFrom: this.props.cancellation?.from.value ?? null,
      cancellationReason: this.props.cancellation?.reason.value ?? null,
      cancelledBy: this.props.cancellation?.by ?? null,
      cancelledAt: this.props.cancellation?.at ?? null,
      createdBy: this.props.createdBy,
      activatedAt: this.props.activatedAt,
      version: this.props.version,
      createdAt: this.props.createdAt,
      updatedAt: this.props.updatedAt,
      revisions: this.props.revisions.map((revision) => ({
        number: revision.number,
        kind: revision.kind,
        effectiveFrom: revision.effectiveFrom.value,
        recurrence: revision.recurrence,
        readjustmentBasisPoints: revision.readjustmentBasisPoints,
        reason: revision.reason?.value ?? null,
        createdBy: revision.createdBy,
        createdAt: revision.createdAt,
        lines: revision.lines.map((line) => ({
          lineId: line.lineId,
          itemId: line.itemId,
          description: line.description.value,
          quantity: line.quantity.toString(),
          unitPrice: money(line.unitPrice),
        })),
      })),
      suspensions: this.props.suspensions.map((suspension) => ({
        id: suspension.id,
        from: suspension.from.value,
        until: suspension.until?.value ?? null,
        reason: suspension.reason.value,
        createdBy: suspension.createdBy,
        createdAt: suspension.createdAt,
      })),
    })
  }

  /** A change applies at a period start of an active contract, today or later. */
  private changeable(
    day: BusinessDate,
    today: BusinessDate,
    field: string,
  ): Either<InvalidInputError | ConflictError, void> {
    if (this.props.stage !== 'active')
      return left(new ConflictError('only an active contract changes'))
    if (this.props.cancellation && !day.isBefore(this.props.cancellation.from))
      return left(new ConflictError('the contract is cancelled from then on'))
    if (day.isBefore(today))
      return left(
        new ConflictError('a period that has begun keeps what it had; choose a later period'),
      )
    if (this.props.endsOn?.isBefore(day))
      return left(new ConflictError('the contract has ended by then; renew it first'))
    if (
      !isPeriodStart(
        { startsOn: this.props.startsOn, endsOn: null, revisions: this.props.revisions },
        day,
      )
    )
      return left(new InvalidInputError(field, 'a change takes effect at the start of a period'))
    return right(undefined)
  }

  private checkResumption(
    from: BusinessDate,
    until: BusinessDate,
  ): Either<InvalidInputError, void> {
    if (!from.isBefore(until))
      return left(new InvalidInputError('/until', 'a contract resumes after it was suspended'))
    if (
      !isPeriodStart(
        { startsOn: this.props.startsOn, endsOn: null, revisions: this.props.revisions },
        until,
      )
    )
      return left(new InvalidInputError('/until', 'a contract resumes at the start of a period'))
    return right(undefined)
  }

  private lastPeriodStart(endsOn: BusinessDate): BusinessDate {
    let last = this.props.startsOn
    for (const period of periodStarts({ ...this.props, endsOn })) last = period.startsOn
    return last
  }

  private latestRevision(): ContractRevision {
    return this.props.revisions.reduce((latest, revision) =>
      revision.number > latest.number ? revision : latest,
    )
  }

  private record(revision: ContractRevision, now: Date): void {
    this.touch(now)
    this.addDomainEvent(
      new SalesContractAmendedEvent(this.id, this.props.tenantId, now, {
        customerId: this.props.customerId,
        revision: revision.number,
        kind: revision.kind === 'renewal' ? 'renewal' : 'amendment',
        effectiveFrom: revision.effectiveFrom,
        recurrence: revision.recurrence,
        endsOn: this.props.endsOn,
        readjustmentBasisPoints: revision.readjustmentBasisPoints,
      }),
    )
  }

  private announceSuspension(suspension: Suspension, now: Date): void {
    this.addDomainEvent(
      new SalesContractSuspendedEvent(this.id, this.props.tenantId, now, {
        customerId: this.props.customerId,
        suspensionId: suspension.id,
        from: suspension.from,
        until: suspension.until,
        reason: suspension.reason.value,
      }),
    )
  }

  private touch(now: Date): void {
    this.props.version += 1
    this.props.updatedAt = now
  }
}

function monthsBetween(startsOn: BusinessDate, endsOn: BusinessDate): number {
  const [startYear = 0, startMonth = 0] = startsOn.value.split('-').map(Number)
  const [endYear = 0, endMonth = 0] = endsOn.plusDays(1).value.split('-').map(Number)
  return (endYear - startYear) * 12 + (endMonth - startMonth)
}

function checkLines(
  lines: readonly ContractLine[],
  currency: Currency,
): Either<InvalidInputError, void> {
  if (lines.length === 0)
    return left(new InvalidInputError('/lines', 'a contract bills at least one line'))
  if (new Set(lines.map((line) => line.lineId)).size !== lines.length)
    return left(new InvalidInputError('/lines', 'each line appears once'))
  for (const [index, line] of lines.entries()) {
    if (line.quantity.isZero())
      return left(new InvalidInputError(`/lines/${index}/quantity`, 'must be positive'))
    if (!line.unitPrice.currency.equals(currency))
      return left(new InvalidInputError(`/lines/${index}`, 'every line is priced in one currency'))
  }
  return right(undefined)
}
