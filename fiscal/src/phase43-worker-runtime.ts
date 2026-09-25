import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { FiscalArtifacts } from './artifacts'
import { FiscalEstablishmentCredentials } from './establishment-credentials'
import { HomologationExchangeLedger } from './homologation-exchange-ledger'
import { HomologationExchangeRunner } from './homologation-exchange-runner'
import { HomologationExchangeWorker } from './homologation-exchange-worker'
import { SefazNfe55HomologationAdapter, type SefazOperationMap } from './nfe55/sefaz-adapter'
import { SefazResponseSchemaValidator } from './nfe55/sefaz-response-schema'
import { SefazHomologationTransport } from './nfe55/sefaz-transport'
import { loadSefazTrustAnchor } from './nfe55/sefaz-trust-anchor'
import { digestSchema, endpointsSchema, operationsSchema } from './phase43-runtime-input'

const path = z.string().min(1)
const configSchema = z.strictObject({
  trustAnchorPath: path,
  trustAnchorFingerprint: digestSchema,
  operationsPath: path,
  endpointsPath: path,
  documentResponseSchemaPath: path,
  consultationResponseSchemaPath: path,
})

/** Shared SEFAZ sources are mounted; each exchange resolves its own encrypted credential. */
export async function loadPhase43WorkerRuntime(
  databaseUrl: string,
  artifacts: FiscalArtifacts,
  configPath: string,
  credentialMasterKey: Buffer,
): Promise<{ worker: HomologationExchangeWorker; close(): Promise<void> }> {
  const config = configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')))
  const [trustAnchor, operations, endpoints, documentArchive, consultationArchive] =
    await Promise.all([
      loadSefazTrustAnchor({
        certificatePath: config.trustAnchorPath,
        expectedFingerprint: config.trustAnchorFingerprint,
      }),
      readFile(config.operationsPath, 'utf8').then(
        (bytes) => operationsSchema.parse(JSON.parse(bytes)) as SefazOperationMap,
      ),
      readFile(config.endpointsPath, 'utf8').then((bytes) =>
        endpointsSchema.parse(JSON.parse(bytes)),
      ),
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
    worker: new HomologationExchangeWorker(
      ledger,
      async (tenantId, exchangeId) => {
        const credential = await credentials.forExchange(tenantId, exchangeId)
        const adapter = new SefazNfe55HomologationAdapter(credential, operations)
        const transport = new SefazHomologationTransport(endpoints, credential, trustAnchor)
        return new HomologationExchangeRunner(ledger, transport, adapter, schemas)
      },
      operations,
    ),
    close: async () => {
      await Promise.all([ledger.close(), credentials.close()])
    },
  }
}
