import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common'
import { z } from 'zod'
import type { Either } from '@/core/either'
import { SegregationOfDutiesError } from '@/core/errors/errors/segregation-of-duties-error'
import type { UseCaseError } from '@/core/errors/use-case-error'

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new BadRequestException(
      issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request',
    )
  }
  return parsed.data
}

export function unwrap<T>(result: Either<UseCaseError, T>): T {
  if (result.isRight()) return result.value
  if (result.value instanceof SegregationOfDutiesError)
    throw new ForbiddenException({
      type: result.value.type,
      title: result.value.title,
      status: 403,
      detail: result.value.message,
      code: 'segregation-of-duties',
      pair: result.value.pair,
    })
  if (result.value.title === 'Forbidden') throw new ForbiddenException(result.value.message)
  if (result.value.title === 'Conflict') throw new ConflictException(result.value.message)
  if (result.value.title === 'Resource not found') throw new NotFoundException(result.value.message)
  throw new BadRequestException(result.value.message)
}

export function id(value: string): string {
  return parse(z.uuid(), value)
}
