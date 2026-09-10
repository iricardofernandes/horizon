import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common'
import { ZodError } from 'zod'

import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { UseCaseError } from '@/core/errors/use-case-error'
import type { IdentityHttpRequest } from './http-context'

const DOMAIN_STATUS: Readonly<Record<string, number>> = {
  InvalidInputError: 422,
  ConflictError: 409,
  ResourceNotFoundError: 404,
  NotAllowedError: 403,
  InvalidCredentialsError: 401,
  InvalidAccessTokenError: 401,
  AccountDisabledError: 403,
  TenantSuspendedError: 403,
  ScopeBeyondIssuerError: 403,
  SessionExpiredError: 401,
  SessionReusedError: 401,
  SubjectErasedError: 410,
}

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
    const request = host.switchToHttp().getRequest<IdentityHttpRequest>()
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
    if (
      typeof exception === 'object' &&
      exception !== null &&
      'code' in exception &&
      exception.code === '23505'
    )
      return {
        status: 409,
        type: 'https://horizon.dev/problems/conflict',
        title: 'Conflict',
        detail: 'A record with these unique attributes already exists',
      }
    if (
      typeof exception === 'object' &&
      exception !== null &&
      'cause' in exception &&
      exception.cause !== exception &&
      typeof exception.cause === 'object' &&
      exception.cause !== null &&
      'code' in exception.cause &&
      exception.cause.code === '23505'
    )
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
        violations: exception.issues.map((issue) => ({
          pointer: `/${issue.path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`,
          detail: issue.message,
          code: issue.code,
        })),
      }
    if (exception instanceof UseCaseError) {
      const status = DOMAIN_STATUS[exception.name] ?? 500
      return {
        status,
        type: exception.type,
        title: exception.title,
        detail: exception.message,
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
    return {
      status: 500,
      type: 'about:blank',
      title: 'Internal server error',
      detail: 'The request could not be completed',
    }
  }
}
