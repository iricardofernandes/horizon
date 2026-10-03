import { describe, expect, it } from 'vitest'
import { right } from '@/core/either'
import type {
  DocumentOutcome,
  FactStatus,
  PostingFactRecord,
} from '@/domain/repositories/ledger-repositories'
import type { Fact } from '@/domain/services/posting-rules'
import type { LedgerScope } from '../ports/unit-of-work'
import { DocumentTaxesUseCase } from './document-taxes'
import type { PostFactUseCase, ReverseFactUseCase } from './post-facts'

const clock = { now: () => new Date('2026-10-02T12:00:00.000Z') }
const documentId = '018f5d4e-1000-7000-8000-000000000091'

const lock = (id = documentId): Extract<Fact, { kind: 'tax-lock' }> => ({
  kind: 'tax-lock',
  id,
  reference: `Fiscal ${id.slice(0, 8)}`,
  on: '2026-10-15',
  currency: 'BRL',
  components: [{ code: 'ICMS', amount: 6836n }],
})

/** Facts and answers in memory, with the same forward-only rule as the database. */
function books() {
  const facts = new Map<string, PostingFactRecord>()
  const answers = new Map<string, DocumentOutcome>()
  const posted: string[] = []
  const scope = {
    tenantId: '018f5d4e-1000-7000-8000-000000000001',
    facts: {
      find: async (_kind: string, id: string) => facts.get(id) ?? null,
      record: async (record: PostingFactRecord) => {
        facts.set(record.factId, record)
      },
      update: async (_kind: string, id: string, change: { status: FactStatus }) => {
        const known = facts.get(id)
        if (known) facts.set(id, { ...known, status: change.status })
      },
      pending: async () => [],
    },
    documentOutcomes: {
      find: async (id: string) => answers.get(id) ?? null,
      record: async (id: string, outcome: DocumentOutcome) => {
        const held = answers.get(id)
        if (!held || (held === 'authorized' && outcome === 'cancelled')) answers.set(id, outcome)
        return answers.get(id) ?? outcome
      },
    },
  } as unknown as LedgerScope
  // Posting and reversing are proven against the database by the e2e suite; here they only
  // record what they were asked, as the real ones would leave the fact.
  const post = {
    executeInScope: async (_scope: LedgerScope, fact: Fact) => {
      posted.push(fact.id)
      const known = facts.get(fact.id)
      facts.set(fact.id, {
        ...(known ?? {
          kind: fact.kind,
          factId: fact.id,
          transactionId: null,
          reference: fact.reference,
          reason: null,
          fact,
          receivedAt: clock.now(),
        }),
        status: 'posted',
        transactionId: `tx-${fact.id}`,
      })
      return { status: 'posted' as const, transactionId: `tx-${fact.id}` }
    },
  } as unknown as PostFactUseCase
  const reverse = {
    executeInScope: async (_scope: LedgerScope, _kind: string, id: string) => {
      const known = facts.get(id)
      if (!known) return right({ status: 'nothing-to-reverse' as const })
      if (known.status === 'posted') {
        facts.set(id, { ...known, status: 'reversed' })
        return right({ status: 'reversed' as const, transactionId: `undo-${id}` })
      }
      facts.set(id, { ...known, status: 'ignored' })
      return right({ status: 'nothing-to-reverse' as const })
    },
  } as unknown as ReverseFactUseCase
  return {
    scope,
    facts,
    posted,
    taxes: new DocumentTaxesUseCase(post, reverse, clock),
  }
}

const at = new Date('2026-10-15T12:00:00.000Z')

describe("a document's taxes follow the authority (Phase 91)", () => {
  it('holds a lock until the document is authorized, then posts it once', async () => {
    const { scope, facts, posted, taxes } = books()
    expect(await taxes.locked(scope, lock())).toEqual({ status: 'held' })
    expect(facts.get(documentId)?.status).toBe('held')
    expect(posted).toEqual([])
    expect(await taxes.decided(scope, documentId, 'authorized', at)).toMatchObject({
      status: 'posted',
    })
    // A redelivered authorization, or the lock again, posts nothing more.
    expect(await taxes.decided(scope, documentId, 'authorized', at)).toEqual({
      status: 'nothing-to-do',
    })
    expect(await taxes.locked(scope, lock())).toEqual({ status: 'nothing-to-do' })
    expect(posted).toEqual([documentId])
  })

  it('never posts a rejected document, and posts its corrected successor once', async () => {
    const { scope, facts, posted, taxes } = books()
    const successor = '018f5d4e-1000-7000-8000-000000000092'
    await taxes.locked(scope, lock())
    expect(await taxes.decided(scope, documentId, 'rejected', at)).toEqual({
      status: 'nothing-to-do',
    })
    expect(facts.get(documentId)?.status).toBe('ignored')
    await taxes.locked(scope, lock(successor))
    await taxes.decided(scope, successor, 'authorized', at)
    expect(posted).toEqual([successor])
  })

  it('reverses what an authorization posted when the document is cancelled', async () => {
    const { scope, facts, taxes } = books()
    await taxes.locked(scope, lock())
    await taxes.decided(scope, documentId, 'authorized', at)
    expect(await taxes.decided(scope, documentId, 'cancelled', at)).toEqual({
      status: 'reversed',
      transactionId: `undo-${documentId}`,
    })
    expect(facts.get(documentId)?.status).toBe('reversed')
  })

  it('posts a lock at once when the authorization came first', async () => {
    const { scope, posted, taxes } = books()
    expect(await taxes.decided(scope, documentId, 'authorized', at)).toEqual({
      status: 'nothing-to-do',
    })
    expect(await taxes.locked(scope, lock())).toMatchObject({ status: 'posted' })
    expect(posted).toEqual([documentId])
  })

  it('ignores a lock whose document was already rejected or cancelled', async () => {
    const { scope, facts, posted, taxes } = books()
    const cancelled = '018f5d4e-1000-7000-8000-000000000093'
    await taxes.decided(scope, documentId, 'rejected', at)
    await taxes.decided(scope, cancelled, 'authorized', at)
    await taxes.decided(scope, cancelled, 'cancelled', at)
    await taxes.locked(scope, lock())
    await taxes.locked(scope, lock(cancelled))
    expect(facts.get(documentId)?.status).toBe('ignored')
    expect(facts.get(cancelled)?.status).toBe('ignored')
    expect(posted).toEqual([])
  })

  it('takes no answer a document can no longer give', async () => {
    const { scope, facts, posted, taxes } = books()
    await taxes.locked(scope, lock())
    await taxes.decided(scope, documentId, 'cancelled', at)
    expect(await taxes.decided(scope, documentId, 'authorized', at)).toEqual({
      status: 'nothing-to-do',
    })
    expect(facts.get(documentId)?.status).toBe('ignored')
    expect(posted).toEqual([])
  })
})
