import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { SefazOperationMap } from './nfe55/sefaz-adapter'
import { SEFAZ_HOMOLOGATION_ENDPOINTS, type SefazAuthorizer } from './nfe55/sefaz-authorizers'
import { loadSefazTrustAnchor, type SefazTrustAnchor } from './nfe55/sefaz-trust-anchor'

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

export const authorizerSchema = z.enum(
  Object.keys(SEFAZ_HOMOLOGATION_ENDPOINTS) as [SefazAuthorizer, ...SefazAuthorizer[]],
)

export const authorizerRuntimeSchema = z
  .partialRecord(
    authorizerSchema,
    z.strictObject({
      operationsPath: z.string().min(1),
      /** Only when this authorizer's TLS chain ends at a different reviewed root. */
      trustAnchorPath: z.string().min(1).optional(),
      trustAnchorFingerprint: digestSchema.optional(),
    }),
  )
  .refine((value) => Object.keys(value).length > 0, 'At least one authorizer is required')

export const emulatorRouteSchema = z.strictObject({
  host: z.enum(['127.0.0.1', '::1']),
  port: z.number().int().min(1).max(65_535),
})

export type LoadedAuthorizers = Partial<
  Record<SefazAuthorizer, { operations: SefazOperationMap; trustAnchor: SefazTrustAnchor | null }>
>

export async function loadAuthorizerOperations(
  input: z.infer<typeof authorizerRuntimeSchema>,
): Promise<LoadedAuthorizers> {
  const entries = await Promise.all(
    (
      Object.entries(input) as [SefazAuthorizer, NonNullable<(typeof input)[SefazAuthorizer]>][]
    ).map(async ([authorizer, settings]) => {
      if (Boolean(settings.trustAnchorPath) !== Boolean(settings.trustAnchorFingerprint))
        throw new Error('Authorizer trust anchor needs both path and fingerprint')
      const operations = operationsSchema.parse(
        JSON.parse(await readFile(settings.operationsPath, 'utf8')),
      ) as SefazOperationMap
      const trustAnchor =
        settings.trustAnchorPath && settings.trustAnchorFingerprint
          ? await loadSefazTrustAnchor({
              certificatePath: settings.trustAnchorPath,
              expectedFingerprint: settings.trustAnchorFingerprint,
            })
          : null
      return [authorizer, { operations, trustAnchor }] as const
    }),
  )
  return Object.fromEntries(entries) as LoadedAuthorizers
}
