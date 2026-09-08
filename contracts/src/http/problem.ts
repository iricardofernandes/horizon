import { z } from 'zod'

/**
 * RFC 9457 `application/problem+json` — the single error shape for every endpoint
 * in every module (ADR 0032).
 *
 * Mapping happens once, in a global exception filter keyed on error class. A controller
 * never chooses a status code, and adding a domain error is one filter entry rather than
 * an edit to N controllers.
 */
export const problemDetailsSchema = z.object({
  /**
   * A URI identifying the problem type. This is what a client branches on — the
   * alternative is string-matching a human-readable message, which breaks the moment
   * anyone improves the wording.
   */
  type: z.string().default('about:blank'),

  /** Short, human-readable summary. Stable for a given `type`. */
  title: z.string(),

  status: z.number().int().min(100).max(599),

  /** Human-readable explanation specific to this occurrence. */
  detail: z.string().optional(),

  /** URI reference identifying the specific occurrence. */
  instance: z.string().optional(),

  /**
   * The gateway's correlation id, echoed on every response. It ties a user-visible
   * failure to a trace in Jaeger and to log lines in Loki, which turns a support
   * request into a query rather than an investigation (ADR 0033).
   */
  requestId: z.string().optional(),
})

export type ProblemDetails = z.infer<typeof problemDetailsSchema>

/** One field-level failure inside a validation problem. */
export const violationSchema = z.object({
  /** JSON Pointer to the offending member, e.g. `/lines/0/quantity`. */
  pointer: z.string(),
  detail: z.string(),
  code: z.string().optional(),
})

/**
 * The problem document returned when a request body fails schema validation. An
 * extension member rather than a separate shape, which is exactly what RFC 9457
 * extension members are for.
 */
export const validationProblemSchema = problemDetailsSchema.extend({
  violations: z.array(violationSchema).min(1),
})

export type ValidationProblem = z.infer<typeof validationProblemSchema>
