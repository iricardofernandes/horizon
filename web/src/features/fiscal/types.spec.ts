import { describe, expect, it } from 'vitest'
import {
  actionBody,
  ageParts,
  allowedActions,
  buildPreviewInput,
  certificateStateOf,
  documentUrl,
  fiscalRoleOf,
  isUncertain,
  type PreviewForm,
  reconciliationFromProposals,
  simulationLabelKey,
  statusTone,
} from './types'

const simulated = { environment: 'simulation' as const }

describe('fiscal document rules', () => {
  it('never shows an uncertain or simulated document as a settled fiscal document', () => {
    expect(statusTone('authorized')).toBe('approved')
    expect(statusTone('unknown')).toBe('pending')
    expect(statusTone('cancellation_unknown')).toBe('pending')
    expect(isUncertain('unknown')).toBe(true)
    expect(isUncertain('authorized')).toBe(false)
    expect(simulationLabelKey({ simulated: true })).toBe('simulationLabel')
    expect(simulationLabelKey({ simulated: false })).toBe('homologationLabel')
  })

  it('offers actions only to roles and statuses that can take them', () => {
    expect(allowedActions('viewer', { ...simulated, model: '55', status: 'authorized' })).toEqual(
      [],
    )
    expect(allowedActions('reviewer', { ...simulated, model: '55', status: 'draft' })).toEqual([])
    expect(allowedActions(null, { ...simulated, model: '55', status: 'draft' })).toEqual([])
    expect(allowedActions('issuer', { ...simulated, model: '55', status: 'draft' })).toEqual([
      'validate',
    ])
    expect(allowedActions('issuer', { ...simulated, model: '65', status: 'ready' })).toEqual([
      'issue',
    ])
    expect(allowedActions('admin', { ...simulated, model: '55', status: 'authorized' })).toEqual([
      'cancel',
      'correctionLetter',
    ])
    expect(allowedActions('admin', { ...simulated, model: '65', status: 'authorized' })).toEqual([
      'cancel',
    ])
    expect(allowedActions('admin', { ...simulated, model: 'nfse', status: 'authorized' })).toEqual([
      'cancel',
      'substitute',
    ])
    expect(allowedActions('issuer', { ...simulated, model: '55', status: 'unknown' })).toEqual([
      'consult',
    ])
    // The NFS-e worker consults by DPS on its own; there is no manual consultation route.
    expect(allowedActions('issuer', { ...simulated, model: 'nfse', status: 'unknown' })).toEqual([])
    expect(
      allowedActions('issuer', { model: '55', status: 'authorized', environment: 'homologation' }),
    ).toEqual([])
    expect(allowedActions('admin', { ...simulated, model: '55', status: 'cancelled' })).toEqual([])
  })

  it('reads each model from its own route and each role from the fiscal module only', () => {
    expect(documentUrl({ id: 'a', model: 'nfse' })).toBe('/api/horizon/fiscal/service-documents/a')
    expect(documentUrl({ id: 'a', model: '65' })).toBe('/api/horizon/fiscal/documents/a')
    expect(
      fiscalRoleOf([
        { module: 'sales', role: 'admin' },
        { module: 'fiscal', role: 'reviewer' },
      ]),
    ).toBe('reviewer')
    expect(fiscalRoleOf([{ module: 'sales', role: 'admin' }])).toBeNull()
  })
})

describe('action bodies', () => {
  const fields = (values: Record<string, string>) => (name: string) => values[name] ?? ''

  it('sends each event with its own reason shape', () => {
    expect(
      actionBody('cancel', '55', fields({ reason: '  Pedido cancelado pelo cliente ' })),
    ).toEqual({
      reason: 'Pedido cancelado pelo cliente',
    })
    expect(
      actionBody('cancel', 'nfse', fields({ reasonCode: '2', reason: 'Serviço não prestado' })),
    ).toEqual({ reasonCode: '2', reason: 'Serviço não prestado' })
    expect(
      actionBody(
        'correctionLetter',
        '55',
        fields({ text: 'Corrige o endereço', attestation: 'on' }),
      ),
    ).toEqual({ text: 'Corrige o endereço', attestation: true })
    expect(
      actionBody('substitute', 'nfse', fields({ reasonCode: '01', serviceOriginId: 'o' })),
    ).toEqual({ reasonCode: '01', correctedOrigin: { serviceOriginId: 'o' } })
    expect(actionBody('issue', '55', fields({}))).toBeUndefined()
  })
})

describe('rule preview input', () => {
  const form: PreviewForm = {
    establishmentId: '01a0c5f8-798b-721e-912e-9b505406e614',
    model: '55',
    operation: 'normal-sale',
    issueDate: '2026-09-26',
    issuerRegime: 'normal',
    issuerState: '35',
    issuerMunicipality: '3550308',
    recipientState: '33',
    recipientMunicipality: '3304557',
    recipientTaxpayer: true,
    lineId: '6b8f2c5e-8f0e-4c55-9d7f-7a2f1f0c9a11',
    itemId: '3f1d2c4b-5a6e-4f70-8a9b-0c1d2e3f4a5b',
    classification: '09012100',
    quantity: '2',
    unitPrice: '10.50',
  }

  it('builds one goods line with origin and destination from the parties', () => {
    const built = buildPreviewInput(form)
    if (!built.ok) throw new Error(built.problem)
    expect(built.input).toMatchObject({
      schemaVersion: 1,
      model: '55',
      environment: 'simulation',
      purpose: 'normal',
      origin: { countryCode: '1058', stateCode: '35', municipalityCode: '3550308' },
      destination: { countryCode: '1058', stateCode: '33', municipalityCode: '3304557' },
      lines: [{ itemId: form.itemId, classifications: { ncm: '09012100' } }],
    })
    expect(built.input).not.toHaveProperty('competenceDate')
  })

  it('builds a service line with its competence date', () => {
    const built = buildPreviewInput({ ...form, model: 'nfse', classification: '010101' })
    if (!built.ok) throw new Error(built.problem)
    expect(built.input).toMatchObject({
      competenceDate: '2026-09-26',
      lines: [{ serviceId: form.itemId, classifications: { service: '010101' } }],
    })
  })

  it('names the malformed field instead of sending a request', () => {
    expect(buildPreviewInput({ ...form, issuerState: 'SP' })).toEqual({
      ok: false,
      problem: 'previewStateInvalid',
    })
    expect(buildPreviewInput({ ...form, recipientMunicipality: '33' })).toEqual({
      ok: false,
      problem: 'previewMunicipalityInvalid',
    })
    expect(buildPreviewInput({ ...form, unitPrice: '10,50' })).toEqual({
      ok: false,
      problem: 'previewAmountInvalid',
    })
    expect(buildPreviewInput({ ...form, classification: '0901' })).toEqual({
      ok: false,
      problem: 'previewNcmInvalid',
    })
    expect(buildPreviewInput({ ...form, model: 'nfse', classification: ' ' })).toEqual({
      ok: false,
      problem: 'previewServiceInvalid',
    })
  })
})

describe('supplier import review', () => {
  it('accepts every proposed allocation and leaves the rest unmatched', () => {
    const request = reconciliationFromProposals(
      {
        lines: [{ number: 1 }, { number: 2 }] as never,
        proposals: [
          {
            lineNumber: 1,
            basis: 'mapping',
            allocations: [{ receiptId: 'r', receiptLineId: 'l', quantity: '6' }],
          },
          { lineNumber: 2, basis: 'none', allocations: [] },
        ],
      },
      'supplier',
      '  ',
    )
    expect(request).toEqual({
      supplierPartyId: 'supplier',
      lines: [{ receiptId: 'r', receiptLineId: 'l', quantity: '6', lineNumber: 1 }],
      unmatchedLines: [2],
      rememberMappings: true,
    })
  })
})

describe('ages', () => {
  it('reads seconds as the largest whole unit', () => {
    expect(ageParts(12)).toEqual({ value: 12, unit: 'second' })
    expect(ageParts(600)).toEqual({ value: 10, unit: 'minute' })
    expect(ageParts(7200)).toEqual({ value: 2, unit: 'hour' })
    expect(ageParts(3 * 86_400 + 5)).toEqual({ value: 3, unit: 'day' })
  })
})

describe('certificate expiry', () => {
  it('warns 30 days ahead and marks an expired certificate', () => {
    const now = new Date('2026-09-26T12:00:00.000Z')
    const at = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString()
    expect(certificateStateOf(at(31), now)).toBe('valid')
    expect(certificateStateOf(at(30), now)).toBe('expiring')
    expect(certificateStateOf(at(0), now)).toBe('expired')
    expect(certificateStateOf(at(-3), now)).toBe('expired')
  })
})
