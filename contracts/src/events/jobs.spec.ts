import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { filesAttachmentQuarantined } from './files'
import {
  catalogImportFinished,
  financialPayableApprovalRequested,
  partiesImportFinished,
  salesBillingRunFinished,
} from './jobs'

describe('events a person waits for', () => {
  const finished = {
    jobId: randomUUID(),
    kind: 'parties',
    status: 'completed-with-failures',
    requestedBy: randomUUID(),
    total: 10,
    written: 8,
    failed: 2,
    cancelled: 0,
  }

  it('says how an import ended, and nothing of its rows', () => {
    expect(partiesImportFinished.payload.safeParse(finished).success).toBe(true)
    expect(
      catalogImportFinished.payload.safeParse({ ...finished, status: 'running' }).success,
    ).toBe(false)
    expect(
      partiesImportFinished.payload.safeParse({ ...finished, fileName: 'clientes.csv' }).success,
    ).toBe(false)
  })

  it('asks for an approval with the amount, and ends a billing run with its counts', () => {
    expect(
      financialPayableApprovalRequested.payload.safeParse({
        titleId: randomUUID(),
        requestedBy: 'user-1',
        amount: { amount: '1500000', currency: 'BRL' },
      }).success,
    ).toBe(true)
    expect(
      salesBillingRunFinished.payload.safeParse({
        runId: randomUUID(),
        competence: '2026-09',
        startedBy: 'user-1',
        billed: 3,
        skipped: 1,
        refused: 0,
      }).success,
    ).toBe(true)
  })

  it('names the uploader of a quarantined file, optionally', () => {
    const reference = {
      attachmentId: randomUUID(),
      module: 'crm',
      recordType: 'opportunity',
      recordId: randomUUID(),
    }
    expect(filesAttachmentQuarantined.payload.safeParse(reference).success).toBe(true)
    expect(
      filesAttachmentQuarantined.payload.safeParse({ ...reference, uploadedBy: 'user-1' }).success,
    ).toBe(true)
  })
})
