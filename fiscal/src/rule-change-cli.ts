import { FiscalRuleChanges } from './rule-changes'
import { FiscalRuleStore } from './rule-store'

/**
 * The rule changes an operator CLI requests and approves (Phase 88, ADR 0074). Adopting has
 * no other path: one person requests, another approves, and the service refuses the same
 * person doing both.
 */
export async function withRuleChanges<T>(
  databaseUrl: string,
  artifactKeyHex: string,
  work: (changes: FiscalRuleChanges) => Promise<T>,
): Promise<T> {
  const store = new FiscalRuleStore(databaseUrl)
  const changes = new FiscalRuleChanges(databaseUrl, Buffer.from(artifactKeyHex, 'hex'), store)
  try {
    return await work(changes)
  } finally {
    await Promise.all([changes.close(), store.close()])
  }
}

/** A request's id, kind and what it would do, for the operator to read before approving. */
export function changeSummary(change: Awaited<ReturnType<FiscalRuleChanges['request']>>) {
  return {
    changeId: change.id,
    kind: change.kind,
    status: change.status,
    requestedBy: change.requestedBy,
    counts: change.diff.counts,
    impact: {
      examined: change.impact.examined,
      changed: change.impact.changed.length,
      unsupported: change.impact.unsupported.length,
      digest: change.impact.digest,
    },
    ...(change.decision
      ? {
          decidedBy: change.decision.decidedBy,
          resultId: change.decision.resultId,
        }
      : {}),
  }
}
