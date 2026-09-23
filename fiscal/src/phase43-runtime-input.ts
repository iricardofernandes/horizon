import { z } from 'zod'

export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/)

const operation = z.strictObject({
  operation: z.string().min(1),
  operationNamespace: z.url(),
})

export const operationsSchema = z.strictObject({
  wsdlDigest: digestSchema,
  authorization: operation,
  receipt: operation,
  protocol: operation,
  status: operation,
  event: operation,
})

export const endpointsSchema = z.strictObject({
  authorization: z.url(),
  receipt: z.url(),
  protocol: z.url(),
  status: z.url(),
  event: z.url(),
})
