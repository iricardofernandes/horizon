import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common'
import { ZodError, type z } from 'zod'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { UseCaseError } from '@/core/errors/use-case-error'
import type { CatalogHttpRequest } from './http-context'

/** Catalog's own failures, not Identity's: a module maps the errors it can raise. */
const DOMAIN_STATUS: Readonly<Record<string, number>> = {
  InvalidInputError: 422,
  ConflictError: 409,
  ResourceNotFoundError: 404,
  InvalidAccessTokenError: 401,
}

interface Violation {
  readonly pointer: string
  readonly detail: string
  readonly code: string
}

const UNIQUE_VIOLATION = '23505'

interface ProblemResponse {
  status(code: number): ProblemResponse
  type(contentType: string): ProblemResponse
  header(name: string, value: string): ProblemResponse
  send(body: unknown): void
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<CatalogHttpRequest>()
    const response = host.switchToHttp().getResponse<ProblemResponse>()
    const problem = this.describe(exception)
    if (problem.status >= 500)
      this.logger.error({
        event: 'http.request-failed',
        errorType: exception instanceof Error ? exception.name : 'UnknownError',
        requestId: request.id,
      })

    if (problem.status === 401) response.header('WWW-Authenticate', 'Bearer')
    response
      .status(problem.status)
      .type('application/problem+json')
      .send({
        ...problem,
        instance: request.originalUrl ?? request.url,
        ...(request.id === undefined ? {} : { requestId: request.id }),
      })
  }

  private describe(exception: unknown) {
    // A uniqueness check that loses a race still owes the client a conflict, not a 500.
    if (isUniqueViolation(exception))
      return {
        status: 409,
        type: 'https://horizon.dev/problems/conflict',
        title: 'Conflict',
        detail: 'A record with these unique attributes already exists',
      }
    if (exception instanceof ZodError)
      return {
        status: 422,
        type: 'https://horizon.dev/problems/invalid-input',
        title: 'Invalid input',
        detail: 'The request does not match its schema',
        // The pointer names the offending member; the request body is never echoed.
        violations: exception.issues.flatMap(violationsOf),
      }
    if (exception instanceof UseCaseError) {
      // An unmapped domain error is a programming oversight, not an expected failure:
      // it answers 500, and a 500 never carries an internal message outwards.
      const status = DOMAIN_STATUS[exception.name] ?? 500
      return {
        status,
        type: status >= 500 ? 'about:blank' : exception.type,
        title: status >= 500 ? 'Internal server error' : exception.title,
        detail: status >= 500 ? 'The request could not be completed' : exception.message,
        ...(exception instanceof InvalidInputError
          ? { violations: [{ pointer: exception.field, detail: exception.message }] }
          : {}),
      }
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus()
      return {
        status,
        type: 'about:blank',
        title: exception.name.replace(/Exception$/, ''),
        detail: status >= 500 ? 'The service is temporarily unavailable' : exception.message,
      }
    }
    // Nothing from an unexpected failure reaches the client: a driver error carries the
    // query, and a query can carry data.
    return {
      status: 500,
      type: 'about:blank',
      title: 'Internal server error',
      detail: 'The request could not be completed',
    }
  }
}

/**
 * One violation per offending member. An unrecognized key carries no path of its own —
 * Zod reports it against the object — so the key is turned into the pointer rather than
 * leaving the client with a bare "/".
 */
function violationsOf(issue: z.core.$ZodIssue): Violation[] {
  const pointer = (path: readonly PropertyKey[]) =>
    `/${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`
  if (issue.code === 'unrecognized_keys')
    return issue.keys.map((key) => ({
      pointer: pointer([...issue.path, key]),
      detail: `unrecognized key "${key}"`,
      code: issue.code,
    }))
  return [{ pointer: pointer(issue.path), detail: issue.message, code: issue.code }]
}

function isUniqueViolation(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) return false
  if ('code' in exception && exception.code === UNIQUE_VIOLATION) return true
  return 'cause' in exception && exception.cause !== exception && isUniqueViolation(exception.cause)
}
