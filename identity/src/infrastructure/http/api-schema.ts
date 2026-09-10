import { ApiBody, type SchemaObject } from '@nestjs/swagger'
import { z } from 'zod'

/** Validation and the published request contract share the same Zod source. */
export function RequestSchema(schema: z.ZodType): MethodDecorator {
  return ApiBody({
    required: true,
    schema: z.toJSONSchema(schema, { target: 'openapi-3.0' }) as SchemaObject,
  })
}
