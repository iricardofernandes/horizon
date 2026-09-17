import type { Reason } from './title-values'

export const APPROVAL_STATES = ['none', 'pending', 'approved', 'rejected', 'not-required'] as const
export type ApprovalState = (typeof APPROVAL_STATES)[number]

/**
 * Where a title stands on the way to being posted. Only payables ask for approval: money
 * leaves the company on the strength of it, so the person who asked may not decide.
 */
export interface TitleApproval {
  readonly state: ApprovalState
  readonly requestedBy: string | null
  readonly requestedAt: Date | null
  readonly decidedBy: string | null
  readonly decidedAt: Date | null
  readonly reason: Reason | null
}

export const NO_APPROVAL: TitleApproval = Object.freeze({
  state: 'none',
  requestedBy: null,
  requestedAt: null,
  decidedBy: null,
  decidedAt: null,
  reason: null,
})
