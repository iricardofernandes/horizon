import { Injectable } from '@nestjs/common'

import { type Either, left, right } from '@/core/either'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { GENESIS_HASH } from '@/domain/audit/chain'
import type { UnitOfWork } from '../ports/unit-of-work'

export interface VerifyAuditChainRequest {
  readonly tenantId: string
  /** Rows read per round trip. The chain can be long; the memory must not be. */
  readonly batchSize?: number
}

export interface AuditChainVerdict {
  readonly intact: boolean
  /** How many links verified before the first failure — or in total, if intact. */
  readonly verifiedThrough: number
  /** The sequence number of the first entry that does not match, if any. */
  readonly brokenAt: number | null
  readonly detail: string
}

export type VerifyAuditChainResponse = Either<InvalidInputError, AuditChainVerdict>

/**
 * Walk a tenant's chain and report the **first broken link**, not a boolean (ADR 0025).
 *
 * "The log is invalid" is not an actionable answer. "Intact through entry 40,912; entry
 * 40,913 does not match its stored hash" is: it names the row, and everything before it
 * is still evidence. An auditor who does not trust the operators can run this and reach
 * their own conclusion, which is the property that makes the chain worth having.
 *
 * A deletion is caught the same way — the successor's `previous_hash` no longer matches
 * the hash of the row that now precedes it — which is why a chain detects removal where a
 * per-row signature would not.
 *
 * Erasure does **not** break it. The chain is computed over the encrypted diff, so
 * destroying a subject's key changes nothing that was hashed (ADR 0026).
 */
@Injectable()
export class VerifyAuditChainUseCase {
  private static readonly DEFAULT_BATCH = 500
  private static readonly MAX_BATCH = 1000

  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(request: VerifyAuditChainRequest): Promise<VerifyAuditChainResponse> {
    const batchSize = request.batchSize ?? VerifyAuditChainUseCase.DEFAULT_BATCH
    if (
      !Number.isInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > VerifyAuditChainUseCase.MAX_BATCH
    )
      return left(
        new InvalidInputError('/batchSize', 'batch size must be an integer between 1 and 1000'),
      )

    return this.unitOfWork.inTenant<VerifyAuditChainResponse>(request.tenantId, async (scope) => {
      let previousHash = GENESIS_HASH
      let verified = 0
      let cursor = 0

      for (;;) {
        const batch = await scope.audit.walk(cursor, batchSize)
        if (batch.length === 0) break

        for (const entry of batch) {
          if (!entry.verifiesAgainst(previousHash))
            return right(VerifyAuditChainUseCase.broken(verified, entry.sequenceNumber()))

          previousHash = entry.hashValue()
          verified += 1
          cursor = entry.sequenceNumber()
        }

        if (batch.length < batchSize) break
      }

      return right({
        intact: true,
        verifiedThrough: verified,
        brokenAt: null,
        detail: `chain is intact across ${verified} entr${verified === 1 ? 'y' : 'ies'}`,
      })
    })
  }

  private static broken(verified: number, brokenAt: number): AuditChainVerdict {
    return {
      intact: false,
      verifiedThrough: verified,
      brokenAt,
      detail:
        `chain is intact through ${verified} entr${verified === 1 ? 'y' : 'ies'}; ` +
        `entry ${brokenAt} does not match its stored hash`,
    }
  }
}
