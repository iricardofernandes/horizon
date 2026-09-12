import { ApiBody, type SchemaObject } from '@nestjs/swagger'
import type { z } from 'zod'
import { toJSONSchema } from 'zod'

/** Validation and the published request contract share the same Zod source. */
export function RequestSchema(schema: z.ZodType): MethodDecorator {
  return ApiBody({
    required: true,
    schema: toJSONSchema(schema, { target: 'openapi-3.0' }) as SchemaObject,
  })
}
