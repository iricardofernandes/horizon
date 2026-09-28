import { z } from 'zod'

import { instantSchema, uuidSchema } from '../common'

/**
 * The bulk import job contract (ADR 0059). Every module that imports implements it inside
 * itself, through its own use cases; this package only fixes the shapes, so the web
 * wizard can drive any of them.
 *
 * Routes, under each module's prefix: `GET /imports/kinds`, `POST /imports/{kind}` (the
 * `Idempotency-Key` header is the job key), `GET /imports`, `GET /imports/{id}`,
 * `PUT /imports/{id}/mapping`, `POST /imports/{id}/preview`, `POST /imports/{id}/confirm`,
 * `POST /imports/{id}/cancel` and `GET /imports/{id}/failures`.
 */

export const IMPORT_STATES = [
  'uploaded',
  'validated',
  'previewed',
  'running',
  'completed',
  'completed-with-failures',
  'cancelled',
] as const
export type ImportState = (typeof IMPORT_STATES)[number]

export const IMPORT_FORMATS = ['csv', 'xlsx'] as const
export const IMPORT_LOCALES = ['pt-BR', 'en'] as const

/** A file holds at most this many data rows… */
export const IMPORT_MAX_ROWS = 10_000
/** …and at most this many bytes, before base64. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024
/** How many errors and valid rows a preview shows. */
export const IMPORT_PREVIEW_ERRORS = 50
export const IMPORT_PREVIEW_ROWS = 10

const kindSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)
const count = z.number().int().nonnegative()

/**
 * Where every row of a file is. `total = written + failed + remaining + cancelled`, always:
 * a job is never shown as done while a row is unaccounted for.
 */
export const importProgressSchema = z
  .object({
    total: count,
    /** Rows that passed validation; 0 until the job is validated. */
    valid: count,
    written: count,
    /** Refused by validation, or by the use case when written. */
    failed: count,
    remaining: count,
    /** Left unwritten by a cancellation. */
    cancelled: count,
  })
  .strict()
  .refine(
    (progress) =>
      progress.total ===
      progress.written + progress.failed + progress.remaining + progress.cancelled,
    { message: 'total must equal written + failed + remaining + cancelled' },
  )

export type ImportProgress = z.infer<typeof importProgressSchema>

/** One column an importer understands. */
export const importFieldSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/),
    required: z.boolean(),
    /** Header names recognised for this field when suggesting a mapping. */
    aliases: z.array(z.string().min(1).max(80)).max(20),
    description: z.string().max(300),
  })
  .strict()

export const importKindSchema = z
  .object({ kind: kindSchema, fields: z.array(importFieldSchema).min(1).max(40) })
  .strict()

export const importUploadSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    format: z.enum(IMPORT_FORMATS),
    locale: z.enum(IMPORT_LOCALES),
    /** The text of a CSV, or the base64 of an XLSX. */
    content: z.string().min(1),
  })
  .strict()

/** Field name → the file's column header, or null when the field is left empty. */
export const importMappingSchema = z
  .object({ mapping: z.record(z.string(), z.string().min(1).max(200).nullable()) })
  .strict()

export const importRowErrorSchema = z
  .object({
    /** The row's line in the file; the header is line 1. */
    line: z.number().int().min(2),
    reasons: z
      .array(z.object({ field: z.string().nullable(), message: z.string() }).strict())
      .min(1),
  })
  .strict()

export const importJobSchema = z
  .object({
    id: uuidSchema,
    kind: kindSchema,
    jobKey: z.string().min(1).max(200),
    status: z.enum(IMPORT_STATES),
    fileName: z.string(),
    format: z.enum(IMPORT_FORMATS),
    locale: z.enum(IMPORT_LOCALES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    columns: z.array(z.string()),
    mapping: z.record(z.string(), z.string().nullable()).nullable(),
    progress: importProgressSchema,
    requestedBy: z.string(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
    finishedAt: instantSchema.nullable(),
    /** Until when the failed rows' values, and so the failures file, are kept. */
    failuresUntil: instantSchema.nullable(),
  })
  .strict()

export const importPreviewSchema = z
  .object({
    job: importJobSchema,
    errors: z.array(importRowErrorSchema).max(IMPORT_PREVIEW_ERRORS),
    sample: z
      .array(
        z
          .object({
            line: z.number().int().min(2),
            values: z.record(z.string(), z.string().nullable()),
          })
          .strict(),
      )
      .max(IMPORT_PREVIEW_ROWS),
  })
  .strict()

export type ImportJob = z.infer<typeof importJobSchema>
export type ImportKind = z.infer<typeof importKindSchema>
export type ImportField = z.infer<typeof importFieldSchema>
export type ImportUpload = z.infer<typeof importUploadSchema>
export type ImportPreview = z.infer<typeof importPreviewSchema>
export type ImportRowError = z.infer<typeof importRowErrorSchema>
