import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import postgres from 'postgres'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { EncryptedFiscalArtifactStore, LocalObjectStore } from '../src/artifact-store'
import { FiscalArtifacts } from '../src/artifacts'
import { FiscalCalculations } from '../src/calculations'
import { FiscalCancellation } from '../src/cancellation'
import { FiscalCapabilities } from '../src/capabilities'
import { FiscalDispatch } from '../src/dispatch'
import { FiscalDocuments } from '../src/documents'
import { FiscalIssuance } from '../src/issuance'
import { FiscalIssueWorker } from '../src/issue-worker'
import { FiscalManualOrigins } from '../src/manual-origins'
import { DeterministicNfe55Simulator } from '../src/nfe55/simulator'
import { approvedPhase41Source, PHASE41_FIXTURE_ID } from '../src/phase41-approved-scenario'
import { FiscalProjections } from '../src/projections'
import { FiscalReadiness } from '../src/readiness'
import { FiscalRuleStore } from '../src/rule-store'

const documentSchemaDigest = 'b8589490a58a09a993a80e6ac4d7ed10f20892061ecfc56719337098d4b95998'
const eventSchemaDigest = '45ceefe4dfbbfec93958283b650a2f1e1734784f4770d070b9907754de081d9b'
const lineId = '00000000-0000-4000-8000-000000000041'
let container: StartedPostgreSqlContainer
let restoredContainer: StartedPostgreSqlContainer | undefined
let admin: ReturnType<typeof postgres>
let url: string
let directory: string
let restoredDirectory: string

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('horizon_phase42_flow_test')
    .withUsername('postgres')
    .withPassword('test')
    .start()
  admin = postgres(container.getConnectionUri(), { max: 1 })
  await admin.unsafe(
    `CREATE ROLE horizon_owner LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     CREATE ROLE horizon_app LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     REVOKE ALL ON SCHEMA public FROM PUBLIC;
     GRANT USAGE ON SCHEMA public TO horizon_app;
     GRANT USAGE, CREATE ON SCHEMA public TO horizon_owner;`,
    [],
    { prepare: false },
  )
  const migrationUrl = container.getConnectionUri().replace('postgres:test@', 'horizon_owner:test@')
  url = container.getConnectionUri().replace('postgres:test@', 'horizon_app:test@')
  await promisify(execFile)(process.execPath, ['scripts/migrate.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_MIGRATION_URL: migrationUrl },
  })
  directory = await mkdtemp(join(tmpdir(), 'horizon-phase42-flow-'))
  await promisify(execFile)(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '1',
      '-subj',
      '/CN=Horizon Phase 42 Flow Simulation Only',
      '-keyout',
      join(directory, 'simulation-only.key.pem'),
      '-out',
      join(directory, 'simulation-only.cert.pem'),
    ],
    { windowsHide: true },
  )
}, 120_000)

afterAll(async () => {
  await Promise.allSettled([admin?.end(), container?.stop(), restoredContainer?.stop()])
  if (directory) await rm(directory, { recursive: true, force: true })
  if (restoredDirectory) await rm(restoredDirectory, { recursive: true, force: true })
})

it('runs the approved manual tuple through signed XML, restart consultation and cancellation', async () => {
  const tenantId = randomUUID()
  const establishmentId = randomUUID()
  const recipientPartyId = randomUUID()
  const itemId = randomUUID()
  const masterKey = randomBytes(32)
  await admin`insert into tenants (id) values (${tenantId})`
  const store = new FiscalRuleStore(url)
  const calculations = new FiscalCalculations(url, masterKey, store)
  const capabilities = new FiscalCapabilities(url)
  const projections = new FiscalProjections(url)
  const documents = new FiscalDocuments(url, masterKey)
  const dispatch = new FiscalDispatch(url)
  const artifacts = new FiscalArtifacts(
    url,
    new EncryptedFiscalArtifactStore(new LocalObjectStore(directory), masterKey),
  )
  const manual = new FiscalManualOrigins(url, masterKey, projections, capabilities, () => ({
    async catalogItem(id) {
      return { id, kind: 'product', name: 'Café torrado em grãos', active: true }
    },
  }))
  const readiness = new FiscalReadiness(documents, projections, capabilities, calculations)
  const credential = {
    privateKey: await readFile(join(directory, 'simulation-only.key.pem')),
    certificate: await readFile(join(directory, 'simulation-only.cert.pem')),
  }
  let issuance: FiscalIssuance | undefined
  let cancellation: FiscalCancellation | undefined
  let recoveredArtifacts: FiscalArtifacts | undefined
  try {
    const imported = await store.importSource(
      approvedPhase41Source(tenantId, {
        byteSize: 1,
        storageUri: 'file:///test-only/rtc-v0057.zip',
      }),
    )
    await store.reviewPackage({
      tenantId,
      packageId: imported.packageId,
      approved: true,
      reviewedBy: 'reviewer:integration-test',
      reviewedAt: '2026-09-22T15:00:00.000Z',
      interpretation: 'Approved only inside the isolated Phase 42 integration test.',
      fixtureIds: [PHASE41_FIXTURE_ID],
    })
    for (const ruleId of imported.ruleIds)
      await store.activateRule({
        tenantId,
        ruleId,
        action: 'activate',
        actorId: 'test:phase42',
        reason: 'Isolated Phase 42 integration fixture',
      })
    const definition = await capabilities.register({
      tenantId,
      model: '55',
      environment: 'simulation',
      establishmentId,
      jurisdictionKind: 'uf',
      jurisdictionCode: 'SP',
      operation: 'normal-sale',
      adapterVersion: 'nfe55-simulator-v1',
      sourceManifestDigest: '6'.repeat(64),
      schemaPackageDigest: documentSchemaDigest,
      calculationFixtureId: PHASE41_FIXTURE_ID,
      createdBy: 'test:phase42',
    })
    await capabilities.review({
      tenantId,
      capabilityId: definition.id,
      approved: true,
      reviewedBy: 'reviewer:integration-test',
      interpretation: 'Test-only authorization of the exact Phase 42 simulation fixture.',
      reviewedAt: '2026-09-22T15:00:00.000Z',
    })
    await capabilities.change({
      tenantId,
      capabilityId: definition.id,
      action: 'activate_simulated',
      evidenceDigest: '9'.repeat(64),
      actorId: 'test:phase42',
      reason: 'Activate only the isolated Phase 42 test fixture.',
      occurredAt: '2026-09-22T15:01:00.000Z',
    })
    await projections.storeIssuer(tenantId, 1, {
      tenantId,
      revision: 1,
      effectiveFrom: '2026-01-01',
      timezone: 'America/Sao_Paulo',
      company: {
        legalName: 'Emissora Exemplo',
        tradeName: null,
        taxId: '00000000E08G12',
        stateRegistration: '123456789',
        municipalRegistration: null,
        address: {
          line: 'Rua Um, 1',
          city: 'São Paulo',
          municipalityCode: '3550308',
          state: 'SP',
          postalCode: '01001000',
          country: 'BR',
        },
        baseCurrency: 'BRL',
        fiscalRegime: 'lucro-real',
      },
    })
    await projections.storeParty(tenantId, recipientPartyId, 1, {
      tenantId,
      partyId: recipientPartyId,
      kind: 'organization',
      legalName: 'Destinatária Exemplo',
      tradeName: null,
      taxId: '12345678000195',
      revision: 1,
      profile: {
        effectiveFrom: '2026-01-01',
        stateRegistration: '987654321',
        municipalRegistration: null,
        taxpayerIndicator: 'contributor',
        finalConsumer: false,
        address: {
          street: 'Rua Dois',
          number: '2',
          complement: null,
          district: 'Centro',
          city: 'São Paulo',
          municipalityCode: '3550308',
          state: 'SP',
          postalCode: '01001000',
          country: 'BR',
        },
      },
    })
    await projections.storeClassification(tenantId, itemId, 1, {
      tenantId,
      itemId,
      revision: 1,
      effectiveFrom: '2026-01-01',
      ncm: '09012100',
    })
    const manualRequest = {
      tenantId,
      establishmentId,
      issuerProfileRevision: 1,
      recipientPartyId,
      recipientProfileRevision: 1,
      issueDate: '2026-09-22',
      operation: 'normal-sale' as const,
      purpose: 'normal' as const,
      reason: 'Simulação completa do cenário aprovado para teste isolado',
      lines: [
        {
          lineId,
          itemId,
          catalogRevision: 1,
          quantity: '1',
          unitPrice: { amount: '10000', currency: 'BRL' },
        },
      ],
      idempotencyKey: randomUUID(),
      actorId: 'test:issuer',
    }
    const origin = await manual.create(manualRequest)
    const draft = await documents.createManualDraft({
      tenantId,
      manualOriginId: origin.id,
      establishmentId,
      series: 1,
      idempotencyKey: randomUUID(),
      actorId: 'test:issuer',
    })
    const ready = await readiness.validate({
      tenantId,
      documentId: draft.id,
      actorId: 'test:issuer',
    })
    expect(ready.supported, JSON.stringify(ready)).toBe(true)
    expect((await documents.get(tenantId, draft.id))?.status).toBe('ready')
    issuance = new FiscalIssuance(
      url,
      documents,
      projections,
      calculations,
      artifacts,
      dispatch,
      {
        capabilityId: definition.id,
        issuerAddress: { street: 'Rua Um', number: '1', complement: null, district: 'Centro' },
        lineFacts: {
          [itemId]: {
            productCode: 'CAFE',
            cfop: '5102',
            unit: 'UN',
            ibsCbsCst: '000',
            ibsCbsClassification: '000001',
          },
        },
      },
      credential,
      await readFile(new URL('../fixtures/official/pl-010f-v1.04.zip', import.meta.url)),
      documentSchemaDigest,
    )
    const issueCommand = {
      tenantId,
      documentId: draft.id,
      idempotencyKey: randomUUID(),
      actorId: 'test:issuer',
    }
    const [issued, concurrentRetry] = await Promise.all([
      issuance.issue(issueCommand),
      issuance.issue(issueCommand),
    ])
    expect(issued.status).toBe('queued')
    expect(concurrentRetry.commandId).toBe(issued.commandId)
    const simulator = new DeterministicNfe55Simulator(() => 'timeout-after-accept')
    const firstSubmit = vi.spyOn(simulator, 'submit')
    const firstWorker = new FiscalIssueWorker(dispatch, artifacts, simulator, 0)
    await firstWorker.processOne(tenantId, 'worker:first')
    expect(firstSubmit).toHaveBeenCalledOnce()
    expect((await documents.get(tenantId, draft.id))?.status).toBe('unknown')
    recoveredArtifacts = new FiscalArtifacts(
      url,
      new EncryptedFiscalArtifactStore(new LocalObjectStore(directory), masterKey),
    )
    const restartedSimulator = new DeterministicNfe55Simulator(() => 'timeout-after-accept')
    const restartedSubmit = vi.spyOn(restartedSimulator, 'submit')
    const restartedConsult = vi.spyOn(restartedSimulator, 'consult')
    const restartedWorker = new FiscalIssueWorker(
      dispatch,
      recoveredArtifacts,
      restartedSimulator,
      0,
    )
    await restartedWorker.processOne(tenantId, 'worker:restarted')
    expect(restartedConsult).toHaveBeenCalledOnce()
    expect(restartedSubmit).not.toHaveBeenCalled()
    expect((await documents.get(tenantId, draft.id))?.status).toBe('authorized')
    const listed = await recoveredArtifacts.list(tenantId, draft.id)
    expect(listed?.artifacts.map((item) => item.kind)).toContain('danfe')
    expect(listed?.artifacts.map((item) => item.kind)).toContain('authorization_protocol')
    for (const item of listed?.artifacts ?? []) {
      const loaded = await recoveredArtifacts.get(
        tenantId,
        draft.id,
        item.kind as 'danfe',
        item.digest,
      )
      expect(loaded.bytes.length).toBe(item.byteSize)
    }
    expect(await recoveredArtifacts.list(randomUUID(), draft.id)).toBeNull()
    cancellation = new FiscalCancellation(
      url,
      documents,
      recoveredArtifacts,
      dispatch,
      credential,
      await readFile(new URL('../fixtures/official/pl-010d-v1.03.zip', import.meta.url)),
      eventSchemaDigest,
    )
    const cancelCommand = {
      tenantId,
      documentId: draft.id,
      idempotencyKey: randomUUID(),
      actorId: 'test:issuer',
      reason: 'Cancelamento solicitado no teste isolado da simulação',
    }
    const cancellationService = cancellation
    const cancellations = await Promise.all(
      Array.from({ length: 6 }, () => cancellationService.request(cancelCommand)),
    )
    expect(new Set(cancellations.map((item) => item.commandId)).size).toBe(1)
    await expect(
      cancellation.request({ ...cancelCommand, idempotencyKey: randomUUID() }),
    ).rejects.toThrow('Fiscal cancellation is not allowed')
    const [cancellationRequests] = await admin`select count(*)::integer as count
      from fiscal_artifacts where document_id = ${draft.id} and kind = 'cancellation_request'`
    expect(cancellationRequests?.count).toBe(1)
    await new FiscalIssueWorker(
      dispatch,
      recoveredArtifacts,
      new DeterministicNfe55Simulator(() => 'authorized'),
      0,
    ).processOne(tenantId, 'worker:cancellation')
    expect((await documents.get(tenantId, draft.id))?.status).toBe('cancelled')
    expect(
      (await recoveredArtifacts.list(tenantId, draft.id))?.artifacts.map((item) => item.kind),
    ).toContain('cancellation_protocol')
    const [counts] = await admin`select
      (select count(*)::integer from fiscal_number_reservations where document_id = ${draft.id}) as numbers,
      (select count(*)::integer from fiscal_document_issuance_bindings where document_id = ${draft.id}) as bindings`
    expect(counts).toMatchObject({ numbers: 1, bindings: 1 })

    const rejectedOrigin = await manual.create({
      ...manualRequest,
      idempotencyKey: randomUUID(),
    })
    const rejectedDraft = await documents.createManualDraft({
      tenantId,
      manualOriginId: rejectedOrigin.id,
      establishmentId,
      series: 1,
      idempotencyKey: randomUUID(),
      actorId: 'test:issuer',
    })
    expect(
      (await readiness.validate({ tenantId, documentId: rejectedDraft.id, actorId: 'test:issuer' }))
        .supported,
    ).toBe(true)
    await issuance.issue({
      tenantId,
      documentId: rejectedDraft.id,
      idempotencyKey: randomUUID(),
      actorId: 'test:issuer',
    })
    await new FiscalIssueWorker(
      dispatch,
      recoveredArtifacts,
      new DeterministicNfe55Simulator(() => 'rejected'),
      0,
    ).processOne(tenantId, 'worker:rejected')
    const rejectedDocument = await documents.get(tenantId, rejectedDraft.id)
    expect(rejectedDocument?.status).toBe('rejected')
    const correctedOrigin = await manual.create({
      ...manualRequest,
      reason: 'Origem manual corrigida após rejeição simulada',
      lines: [
        {
          lineId,
          itemId,
          catalogRevision: 1,
          quantity: '1',
          unitPrice: { amount: '11000', currency: 'BRL' },
        },
      ],
      idempotencyKey: randomUUID(),
    })
    const correction = await documents.createManualSuccessor({
      tenantId,
      documentId: rejectedDraft.id,
      correctedManualOriginId: correctedOrigin.id,
      idempotencyKey: randomUUID(),
      actorId: 'test:issuer',
      reason: 'Corrigir o valor comercial da origem manual rejeitada',
    })
    expect(correction).toMatchObject({
      rootDocumentId: rejectedDraft.id,
      predecessorDocumentId: rejectedDraft.id,
      revision: 2,
    })
    expect(
      (await readiness.validate({ tenantId, documentId: correction.id, actorId: 'test:issuer' }))
        .supported,
    ).toBe(true)
    await issuance.issue({
      tenantId,
      documentId: correction.id,
      idempotencyKey: randomUUID(),
      actorId: 'test:issuer',
    })
    await new FiscalIssueWorker(
      dispatch,
      recoveredArtifacts,
      new DeterministicNfe55Simulator(() => 'authorized'),
      0,
    ).processOne(tenantId, 'worker:corrected')
    expect((await documents.get(tenantId, correction.id))?.status).toBe('authorized')
    expect((await documents.get(tenantId, rejectedDraft.id))?.status).toBe('rejected')
    expect((await documents.get(tenantId, correction.id))?.number).not.toBe(
      rejectedDocument?.number,
    )
    const [correctionBindings] = await admin`select count(*)::integer as count
      from fiscal_document_issuance_bindings
      where document_id in (${rejectedDraft.id}, ${correction.id})`
    expect(correctionBindings?.count).toBe(2)

    // Restore the database and encrypted object bytes into a clean PostgreSQL instance.
    const backupPath = '/tmp/fiscal-backup.dump'
    const backup = await container.exec(
      [
        'pg_dump',
        '--format=custom',
        '--no-owner',
        '--file',
        backupPath,
        '-U',
        'postgres',
        '-d',
        'horizon_phase42_flow_test',
      ],
      { env: { PGPASSWORD: 'test' } },
    )
    if (backup.exitCode !== 0) throw new Error(`pg_dump failed: ${backup.stderr}`)
    restoredDirectory = await mkdtemp(join(tmpdir(), 'horizon-phase42-restored-'))
    const restoredObjects = join(restoredDirectory, 'objects')
    await cp(directory, restoredObjects, { recursive: true })
    restoredContainer = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('horizon_phase42_restored_test')
      .withUsername('postgres')
      .withPassword('test')
      .start()
    await restoredContainer.copyArchiveToContainer(
      (await container.copyArchiveFromContainer(backupPath)) as Readable,
      '/tmp',
    )
    const restoredAdmin = postgres(restoredContainer.getConnectionUri(), { max: 1 })
    try {
      await restoredAdmin.unsafe(
        `CREATE ROLE horizon_owner LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
         CREATE ROLE horizon_app LOGIN PASSWORD 'test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;`,
        [],
        { prepare: false },
      )
      const restore = await restoredContainer.exec(
        [
          'pg_restore',
          '--no-owner',
          '-U',
          'postgres',
          '-d',
          'horizon_phase42_restored_test',
          backupPath,
        ],
        { env: { PGPASSWORD: 'test' } },
      )
      if (restore.exitCode !== 0) throw new Error(`pg_restore failed: ${restore.stderr}`)
      const restoredUrl = restoredContainer
        .getConnectionUri()
        .replace('postgres:test@', 'horizon_app:test@')
      const restored = new FiscalArtifacts(
        restoredUrl,
        new EncryptedFiscalArtifactStore(new LocalObjectStore(restoredObjects), masterKey),
      )
      try {
        const restoredList = await restored.list(tenantId, draft.id)
        expect(restoredList?.artifacts.map((item) => [item.kind, item.digest])).toEqual(
          (await recoveredArtifacts.list(tenantId, draft.id))?.artifacts.map((item) => [
            item.kind,
            item.digest,
          ]),
        )
        for (const item of restoredList?.artifacts ?? []) {
          const loaded = await restored.get(tenantId, draft.id, item.kind as 'danfe', item.digest)
          expect(loaded.bytes.length).toBe(item.byteSize)
        }
        expect(await restored.list(randomUUID(), draft.id)).toBeNull()
      } finally {
        await restored.close()
      }
    } finally {
      await restoredAdmin.end()
    }

    const artifactDigests = (await recoveredArtifacts.list(tenantId, draft.id))?.artifacts.map(
      (item) => item.digest,
    )
    const uncertainOrigin = await manual.create({
      ...manualRequest,
      idempotencyKey: randomUUID(),
    })
    const uncertainDraft = await documents.createManualDraft({
      tenantId,
      manualOriginId: uncertainOrigin.id,
      establishmentId,
      series: 1,
      idempotencyKey: randomUUID(),
      actorId: 'test:issuer',
    })
    expect(
      (
        await readiness.validate({
          tenantId,
          documentId: uncertainDraft.id,
          actorId: 'test:issuer',
        })
      ).supported,
    ).toBe(true)
    await issuance.issue({
      tenantId,
      documentId: uncertainDraft.id,
      idempotencyKey: randomUUID(),
      actorId: 'test:issuer',
    })
    const rollbackSimulator = new DeterministicNfe55Simulator(() => 'timeout-after-accept')
    const rollbackSubmit = vi.spyOn(rollbackSimulator, 'submit')
    const rollbackConsult = vi.spyOn(rollbackSimulator, 'consult')
    const rollbackWorker = new FiscalIssueWorker(dispatch, recoveredArtifacts, rollbackSimulator, 0)
    await rollbackWorker.processOne(tenantId, 'worker:before-rollback')
    expect((await documents.get(tenantId, uncertainDraft.id))?.status).toBe('unknown')
    expect(rollbackSubmit).toHaveBeenCalledOnce()
    const pendingOrigin = await manual.create({
      ...manualRequest,
      idempotencyKey: randomUUID(),
    })
    const pendingDraft = await documents.createManualDraft({
      tenantId,
      manualOriginId: pendingOrigin.id,
      establishmentId,
      series: 1,
      idempotencyKey: randomUUID(),
      actorId: 'test:issuer',
    })
    expect(
      (await readiness.validate({ tenantId, documentId: pendingDraft.id, actorId: 'test:issuer' }))
        .supported,
    ).toBe(true)
    await issuance.issue({
      tenantId,
      documentId: pendingDraft.id,
      idempotencyKey: randomUUID(),
      actorId: 'test:issuer',
    })
    expect((await documents.get(tenantId, pendingDraft.id))?.status).toBe('queued')
    const unissuedOrigin = await manual.create({
      ...manualRequest,
      idempotencyKey: randomUUID(),
    })
    const unissuedDraft = await documents.createManualDraft({
      tenantId,
      manualOriginId: unissuedOrigin.id,
      establishmentId,
      series: 1,
      idempotencyKey: randomUUID(),
      actorId: 'test:issuer',
    })
    expect(
      (await readiness.validate({ tenantId, documentId: unissuedDraft.id, actorId: 'test:issuer' }))
        .supported,
    ).toBe(true)
    await capabilities.change({
      tenantId,
      capabilityId: definition.id,
      action: 'deactivate',
      evidenceDigest: '8'.repeat(64),
      actorId: 'test:phase42',
      reason: 'Rollback the isolated Phase 42 simulation capability.',
      occurredAt: '2026-09-22T15:02:00.000Z',
    })
    expect(await capabilities.listActive(tenantId)).toEqual([])
    await rollbackWorker.processOne(tenantId, 'worker:drain-after-rollback')
    expect((await documents.get(tenantId, uncertainDraft.id))?.status).toBe('authorized')
    expect(rollbackConsult).toHaveBeenCalledOnce()
    expect(rollbackSubmit).toHaveBeenCalledOnce()
    expect(await dispatch.claim({ tenantId, workerId: 'worker:after-rollback' })).toBeNull()
    expect((await documents.get(tenantId, pendingDraft.id))?.status).toBe('queued')
    await expect(
      issuance.issue({
        tenantId,
        documentId: unissuedDraft.id,
        idempotencyKey: randomUUID(),
        actorId: 'test:issuer',
      }),
    ).rejects.toThrow('capability is inactive')
    const [unissuedNumber] = await admin`select count(*)::integer as count
      from fiscal_number_reservations where document_id = ${unissuedDraft.id}`
    expect(unissuedNumber?.count).toBe(0)
    expect((await documents.get(tenantId, draft.id))?.status).toBe('cancelled')
    expect(
      (await recoveredArtifacts.list(tenantId, draft.id))?.artifacts.map((item) => item.digest),
    ).toEqual(artifactDigests)
  } finally {
    await Promise.allSettled([
      issuance?.close(),
      cancellation?.close(),
      recoveredArtifacts?.close(),
      manual.close(),
      artifacts.close(),
      dispatch.close(),
      documents.close(),
      projections.close(),
      capabilities.close(),
      calculations.close(),
      store.close(),
    ])
  }
}, 120_000)
