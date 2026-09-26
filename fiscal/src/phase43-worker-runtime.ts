import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { FiscalArtifacts } from './artifacts'
import { FiscalEstablishmentCredentials } from './establishment-credentials'
import { HomologationExchangeLedger } from './homologation-exchange-ledger'
import { HomologationExchangeRunner } from './homologation-exchange-runner'
import { HomologationExchangeWorker } from './homologation-exchange-worker'
import { SefazNfe55HomologationAdapter } from './nfe55/sefaz-adapter'
import { authorizerForUf, SEFAZ_HOMOLOGATION_ENDPOINTS } from './nfe55/sefaz-authorizers'
import { SefazResponseSchemaValidator } from './nfe55/sefaz-response-schema'
import { SefazHomologationTransport } from './nfe55/sefaz-transport'
import { loadSefazTrustAnchor, type SefazTrustAnchor } from './nfe55/sefaz-trust-anchor'
import {
  authorizerRuntimeSchema,
  digestSchema,
  type LoadedAuthorizers,
  loadAuthorizerOperations,
} from './phase43-runtime-input'

const path = z.string().min(1)
const configSchema = z.strictObject({
  trustAnchorPath: path,
  trustAnchorFingerprint: digestSchema,
  documentResponseSchemaPath: path,
  consultationResponseSchemaPath: path,
  /** Reviewed SOAP operations per authorizer; a UF whose authorizer is absent stays closed. */
  authorizers: authorizerRuntimeSchema,
})

/**
 * Shared SEFAZ sources are mounted once. Each exchange resolves its tenant's issuer
 * UF, the authorizer serving that UF, its official endpoints and its encrypted A1.
 * The worker only runs activated `homologated` tuples, so it never uses an emulator.
 */
export async function loadPhase43WorkerRuntime(
  databaseUrl: string,
  artifacts: FiscalArtifacts,
  configPath: string,
  credentialMasterKey: Buffer,
): Promise<{ worker: HomologationExchangeWorker; close(): Promise<void> }> {
  const config = configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')))
  const [trustAnchor, authorizers, documentArchive, consultationArchive] = await Promise.all([
    loadSefazTrustAnchor({
      certificatePath: config.trustAnchorPath,
      expectedFingerprint: config.trustAnchorFingerprint,
    }),
    loadAuthorizerOperations(config.authorizers),
    readFile(config.documentResponseSchemaPath),
    readFile(config.consultationResponseSchemaPath),
  ])
  const schemas = new SefazResponseSchemaValidator(
    {
      archive: documentArchive,
      digest: createHash('sha256').update(documentArchive).digest('hex'),
    },
    {
      archive: consultationArchive,
      digest: createHash('sha256').update(consultationArchive).digest('hex'),
    },
  )
  const ledger = new HomologationExchangeLedger(databaseUrl, artifacts)
  const credentials = new FiscalEstablishmentCredentials(databaseUrl, credentialMasterKey)
  return {
    worker: new HomologationExchangeWorker(ledger, async (tenantId, exchangeId) => {
      const [scope, credential] = await Promise.all([
        ledger.exchangeScope(tenantId, exchangeId),
        credentials.forExchange(tenantId, exchangeId),
      ])
      const runtime = authorizerRuntime(authorizers, scope.jurisdiction, trustAnchor)
      const adapter = new SefazNfe55HomologationAdapter(
        credential,
        runtime.operations,
        scope.jurisdiction,
      )
      const transport = new SefazHomologationTransport(
        SEFAZ_HOMOLOGATION_ENDPOINTS[adapter.authorizer],
        credential,
        runtime.trustAnchor,
      )
      return {
        runner: new HomologationExchangeRunner(ledger, transport, adapter, schemas),
        operations: runtime.operations,
      }
    }),
    close: async () => {
      await Promise.all([ledger.close(), credentials.close()])
    },
  }
}

function authorizerRuntime(
  authorizers: LoadedAuthorizers,
  uf: Parameters<typeof authorizerForUf>[0],
  sharedTrustAnchor: SefazTrustAnchor,
) {
  const loaded = authorizers[authorizerForUf(uf)]
  if (!loaded) throw new Error(`No reviewed SEFAZ operations for the ${uf} authorizer`)
  return { operations: loaded.operations, trustAnchor: loaded.trustAnchor ?? sharedTrustAnchor }
}
