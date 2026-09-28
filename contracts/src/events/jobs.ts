import { z } from 'zod'

import { moneySchema, uuidSchema } from '../common'
import { defineEvent } from './define'

/**
 * Facts a person waits for (Phase 66): an approval asked of them, a job of theirs that
 * ended. They name who asked and count what happened; they never carry a name, a document
 * or a row of the job.
 */
const actor = z.string().min(1).max(255)
const count = z.number().int().nonnegative()

const importFinished = z.strictObject({
  jobId: uuidSchema,
  kind: z.string().regex(/^[a-z][a-z-]*$/),
  status: z.enum(['completed', 'completed-with-failures', 'cancelled']),
  requestedBy: actor,
  total: count,
  written: count,
  failed: count,
  cancelled: count,
})

const importDescription = (module: string) =>
  `A bulk import job of ${module} ended (ADR 0059): every row was written, some failed, or the job was cancelled.`

export const partiesImportFinished = defineEvent({
  type: 'parties.import.finished',
  version: 1,
  description: importDescription('Parties'),
  payload: importFinished,
})

export const catalogImportFinished = defineEvent({
  type: 'catalog.import.finished',
  version: 1,
  description: importDescription('Catalog'),
  payload: importFinished,
})

export const inventoryImportFinished = defineEvent({
  type: 'inventory.import.finished',
  version: 1,
  description: importDescription('Inventory'),
  payload: importFinished,
})

export const financialImportFinished = defineEvent({
  type: 'financial.import.finished',
  version: 1,
  description: importDescription('Financial'),
  payload: importFinished,
})

export const financialPayableApprovalRequested = defineEvent({
  type: 'financial.payable.approval-requested',
  version: 1,
  description:
    'A payable draft at or above the approval threshold waits for a second person, who must hold the approving role and not be the requester.',
  payload: z.strictObject({
    titleId: uuidSchema,
    requestedBy: actor,
    amount: moneySchema,
  }),
})

export const salesBillingRunFinished = defineEvent({
  type: 'sales.billing-run.finished',
  version: 1,
  description:
    'A billing run of a competence month decided every contract of it: billed, skipped or refused.',
  payload: z.strictObject({
    runId: uuidSchema,
    competence: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    startedBy: actor,
    billed: count,
    skipped: count,
    refused: count,
  }),
})
