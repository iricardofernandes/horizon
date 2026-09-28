import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  IMPORT_STATES,
  importJobSchema,
  importMappingSchema,
  importProgressSchema,
  importUploadSchema,
} from './imports'

const progress = { total: 10, valid: 8, written: 6, failed: 3, remaining: 1, cancelled: 0 }
const job = {
  id: randomUUID(),
  kind: 'parties',
  jobKey: 'a'.repeat(64),
  status: 'running',
  fileName: 'clientes.csv',
  format: 'csv',
  locale: 'pt-BR',
  sha256: 'f'.repeat(64),
  columns: ['Nome', 'CNPJ'],
  mapping: { legalName: 'Nome', documentNumber: 'CNPJ', email: null },
  progress,
  requestedBy: randomUUID(),
  createdAt: '2026-09-28T12:00:00.000Z',
  updatedAt: '2026-09-28T12:01:00.000Z',
  finishedAt: null,
  failuresUntil: null,
}

describe('import progress', () => {
  it('accepts counts that account for every row', () => {
    expect(importProgressSchema.parse(progress).total).toBe(10)
  })

  it('refuses counts that leave a row unaccounted for', () => {
    expect(importProgressSchema.safeParse({ ...progress, remaining: 0 }).success).toBe(false)
    expect(importProgressSchema.safeParse({ ...progress, written: 7 }).success).toBe(false)
  })
})

describe('import job', () => {
  it('accepts a job in every state', () => {
    for (const status of IMPORT_STATES)
      expect(importJobSchema.safeParse({ ...job, status }).success).toBe(true)
  })

  it('refuses an unknown state, kind or field', () => {
    expect(importJobSchema.safeParse({ ...job, status: 'done' }).success).toBe(false)
    expect(importJobSchema.safeParse({ ...job, kind: 'Parties' }).success).toBe(false)
    expect(importJobSchema.safeParse({ ...job, rows: [] }).success).toBe(false)
  })
})

describe('upload and mapping', () => {
  it('accepts a CSV in pt-BR and an XLSX in English', () => {
    expect(
      importUploadSchema.safeParse({
        fileName: 'a.csv',
        format: 'csv',
        locale: 'pt-BR',
        content: 'a;b',
      }).success,
    ).toBe(true)
    expect(
      importUploadSchema.safeParse({
        fileName: 'a.xlsx',
        format: 'xlsx',
        locale: 'en',
        content: 'UEs=',
      }).success,
    ).toBe(true)
  })

  it('refuses another format or locale and an empty file', () => {
    const upload = { fileName: 'a.csv', format: 'csv', locale: 'en', content: 'a' }
    expect(importUploadSchema.safeParse({ ...upload, format: 'ods' }).success).toBe(false)
    expect(importUploadSchema.safeParse({ ...upload, locale: 'fr' }).success).toBe(false)
    expect(importUploadSchema.safeParse({ ...upload, content: '' }).success).toBe(false)
  })

  it('maps a field to a column or to nothing', () => {
    expect(importMappingSchema.safeParse({ mapping: { a: 'A', b: null } }).success).toBe(true)
    expect(importMappingSchema.safeParse({ mapping: { a: '' } }).success).toBe(false)
  })
})
