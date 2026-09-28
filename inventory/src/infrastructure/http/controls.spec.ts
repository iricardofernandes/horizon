import { dutyConflictsOf, segregationOfDutiesProblemSchema } from '@horizon/contracts'
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { left } from '@/core/either'
import { NotAllowedError } from '@/core/errors/errors/not-allowed-error'
import { SegregationOfDutiesError } from '@/core/errors/errors/segregation-of-duties-error'
import { ENFORCED_PAIRS } from '@/domain/controls/duties'
import { unwrap } from './request-parsing'

function refusal(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected a refusal')
}

describe('segregation of duties at the edge', () => {
  it('enforces exactly the rows of the contracts matrix for this module', () => {
    expect(
      dutyConflictsOf('inventory').map(({ id, perform, approve }) => ({ id, perform, approve })),
    ).toEqual(ENFORCED_PAIRS)
  })

  it('answers a refused pair with the shared 403 body', () => {
    const error = refusal(() =>
      unwrap(left(new SegregationOfDutiesError('financial.payable', 'cannot decide it'))),
    )
    expect(error).toBeInstanceOf(ForbiddenException)
    const body = (error as ForbiddenException).getResponse()
    expect(segregationOfDutiesProblemSchema.parse(body).pair).toBe('financial.payable')
  })

  it('answers a decision without authority with a plain 403', () => {
    const error = refusal(() => unwrap(left(new NotAllowedError('no approval'))))
    expect(error).toBeInstanceOf(ForbiddenException)
    expect((error as ForbiddenException).getResponse()).not.toHaveProperty('code')
  })
})
