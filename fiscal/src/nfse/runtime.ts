import type { FiscalArtifacts } from '../artifacts'
import type { OwnerFiscalClient } from '../backfill'
import type { FiscalCalculations } from '../calculations'
import type { FiscalCapabilities } from '../capabilities'
import type { FiscalDispatch } from '../dispatch'
import type { FiscalDocuments } from '../documents'
import type { Nfe55IssuanceProfile } from '../nfe55/issuance-profile'
import type { SimulationCredential } from '../nfe55/signature'
import type { SimulatorScenario } from '../nfe55/simulator'
import { PHASE47_IBS_CBS_RATES, PHASE47_MUNICIPAL_PARAMETERS } from '../phase47-approved-scenario'
import type { FiscalProjections } from '../projections'
import type { ServiceDependencies } from './api'
import { FiscalServiceCancellation } from './cancellation'
import { FiscalServiceDocuments } from './documents'
import { FiscalServiceIssuance } from './issuance'
import { NfseDispatchProcessor, NfseProcessingFacts } from './processor'
import { FiscalServiceReadiness } from './readiness'
import { FiscalNfseRegistry } from './registry'
import { FiscalServiceOrigins } from './service-origins'
import { FiscalServiceProfiles } from './service-profiles'
import { DeterministicNfseSimulator } from './simulator'
import { FiscalServiceSubstitutions } from './substitution'

/**
 * The national NFS-e services of one Fiscal process. Profiles, the registry, origins,
 * drafts and readiness always run; issuance, events and the simulated national system
 * need the reviewed `service` profile block, a signing credential and the pinned XSD.
 */
export function createServiceRuntime(input: {
  databaseUrl: string
  masterKey: Buffer
  projections: FiscalProjections
  capabilities: FiscalCapabilities
  calculations: FiscalCalculations
  documents: FiscalDocuments
  artifacts: FiscalArtifacts
  dispatch: FiscalDispatch
  ownerForTenant: (tenantId: string) => Pick<OwnerFiscalClient, 'catalogItem'>
  issuance?: {
    profile: Nfe55IssuanceProfile
    credential: SimulationCredential
    schemaZip: Buffer
    scenario?: SimulatorScenario
    retryDelayMilliseconds: number
  }
}) {
  const registry = new FiscalNfseRegistry(input.databaseUrl)
  const profiles = new FiscalServiceProfiles(input.databaseUrl, input.ownerForTenant)
  const origins = new FiscalServiceOrigins(
    input.databaseUrl,
    input.masterKey,
    input.projections,
    input.capabilities,
    profiles,
    registry,
    input.ownerForTenant,
  )
  const documents = new FiscalServiceDocuments(input.databaseUrl, input.masterKey, origins)
  const readiness = new FiscalServiceReadiness(
    input.documents,
    input.projections,
    input.capabilities,
    profiles,
    registry,
    input.calculations,
  )
  const closeables: Array<{ close(): Promise<void> }> = [registry, profiles, origins, documents]
  const dependencies: ServiceDependencies = {
    profiles,
    registry,
    origins,
    documents,
    readiness,
    dispatch: input.dispatch,
  }
  let processor: NfseDispatchProcessor | undefined
  const service = input.issuance?.profile.service
  if (input.issuance && service) {
    const { credential, schemaZip, scenario } = input.issuance
    const issuance = new FiscalServiceIssuance(
      input.databaseUrl,
      input.documents,
      input.projections,
      input.calculations,
      input.artifacts,
      input.dispatch,
      registry,
      service,
      credential,
      schemaZip,
    )
    const cancellation = new FiscalServiceCancellation(
      input.databaseUrl,
      input.documents,
      input.artifacts,
      input.dispatch,
      service,
      credential,
      schemaZip,
    )
    const substitutions = new FiscalServiceSubstitutions(
      input.databaseUrl,
      documents,
      origins,
      service,
    )
    const facts = new NfseProcessingFacts(
      input.databaseUrl,
      input.projections,
      input.calculations,
      input.artifacts,
      input.issuance.profile.issuerAddress,
    )
    processor = new NfseDispatchProcessor(
      input.dispatch,
      input.artifacts,
      new DeterministicNfseSimulator(
        PHASE47_MUNICIPAL_PARAMETERS,
        PHASE47_IBS_CBS_RATES,
        credential,
        scenario ? () => scenario : undefined,
      ),
      facts,
      input.issuance.retryDelayMilliseconds,
    )
    Object.assign(dependencies, { issuance, cancellation, substitutions })
    closeables.push(issuance, cancellation, substitutions, facts)
  }
  return {
    dependencies,
    processor,
    close: async () => {
      await Promise.all(closeables.map((closeable) => closeable.close()))
    },
  }
}
