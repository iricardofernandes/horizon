import { randomUUID } from 'node:crypto'
import {
  type FiscalCalculationInput,
  type FiscalCalculationOutcome,
  type FiscalCalculationResult,
  fiscalCalculationInputSchema,
  fiscalCalculationResultSchema,
} from '@horizon/contracts'
import postgres from 'postgres'
import { z } from 'zod'
import { appendAudit } from './audit'
import { calculateFiscal } from './calculation'
import { openCalculationInput, sealCalculationInput } from './calculation-crypto'
import { canonicalDigest, canonicalJson } from './canonical-json'
import type { FiscalRuleStore } from './rule-store'

export class FiscalCalculations {
  readonly #db: ReturnType<typeof postgres>

  constructor(
    databaseUrl: string,
    private readonly masterKey: Buffer,
    private readonly rules: Pick<FiscalRuleStore, 'resolve'>,
  ) {
    if (masterKey.length !== 32) throw new Error('Fiscal calculation key must be 32 bytes')
    this.#db = postgres(databaseUrl, { max: 10, connection: { statement_timeout: 10_000 } })
  }

  async close(): Promise<void> {
    await this.#db.end()
  }

  async preview(candidate: unknown): Promise<FiscalCalculationOutcome> {
    const parsed = fiscalCalculationInputSchema.safeParse(candidate)
    if (!parsed.success)
      return {
        schemaVersion: 1,
        supported: false,
        code: 'INVALID_FISCAL_INPUT',
        detail: 'Fiscal calculation input is invalid',
      }
    const scale = currencyScale(parsed.data.currency)
    if (scale === null)
      return {
        schemaVersion: 1,
        supported: false,
        code: 'INVALID_FISCAL_INPUT',
        detail: 'Currency minor-unit scale is unsupported',
        missingDimension: parsed.data.currency,
        inputDigest: canonicalDigest(normalizeInput(parsed.data)),
      }
    const resolution = await this.rules.resolve(parsed.data, scale)
    if (!resolution.supported)
      return {
        schemaVersion: 1,
        supported: false,
        code: resolution.code,
        detail: resolution.detail,
        ...(resolution.missingDimension ? { missingDimension: resolution.missingDimension } : {}),
        inputDigest: canonicalDigest(normalizeInput(parsed.data)),
      }
    return calculateFiscal(parsed.data, resolution.rules)
  }

  async validateDocument(input: {
    tenantId: string
    documentId: string
    actorId: string
    calculationInput: FiscalCalculationInput
  }): Promise<FiscalCalculationOutcome> {
    const command = z
      .object({ tenantId: z.uuid(), documentId: z.uuid(), actorId: z.string().min(1).max(200) })
      .parse(input)
    const calculationInput = fiscalCalculationInputSchema.parse(input.calculationInput)
    if (calculationInput.tenantId !== command.tenantId)
      throw new Error('Calculation input tenant does not match command tenant')
    const scale = currencyScale(calculationInput.currency)
    if (scale === null)
      return {
        schemaVersion: 1,
        supported: false,
        code: 'INVALID_FISCAL_INPUT',
        detail: 'Currency minor-unit scale is unsupported',
        missingDimension: calculationInput.currency,
        inputDigest: canonicalDigest(normalizeInput(calculationInput)),
      }
    const resolution = await this.rules.resolve(calculationInput, scale)
    if (!resolution.supported)
      return {
        schemaVersion: 1,
        supported: false,
        code: resolution.code,
        detail: resolution.detail,
        ...(resolution.missingDimension ? { missingDimension: resolution.missingDimension } : {}),
        inputDigest: canonicalDigest(normalizeInput(calculationInput)),
      }
    const result = calculateFiscal(calculationInput, resolution.rules)
    if (!result.supported) return result
    const normalizedInput = normalizeInput(calculationInput)
    const inputBytes = canonicalJson(normalizedInput)
    const resultBytes = canonicalJson(result)
    return this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${command.tenantId}, true)`
      const [document] = await tx`select status, model, environment, establishment_id
        from fiscal_documents where tenant_id = ${command.tenantId}
          and id = ${command.documentId} for update`
      if (!document) throw new Error('Fiscal document not found')
      const [binding] = await tx`select calculation.id, calculation.input_digest,
        calculation.result_bytes from fiscal_document_calculation_bindings binding
        join fiscal_calculations calculation on calculation.tenant_id = binding.tenant_id
          and calculation.id = binding.calculation_id
        where binding.tenant_id = ${command.tenantId} and binding.document_id = ${command.documentId}`
      if (binding) {
        if (binding.input_digest !== result.inputDigest)
          throw new Error('Conflicting calculation for validated Fiscal document')
        return parseStoredResult(binding.result_bytes)
      }
      if (document.status !== 'draft') throw new Error('Fiscal document is not a draft')
      if (
        document.model !== calculationInput.model ||
        document.environment !== calculationInput.environment ||
        document.establishment_id !== calculationInput.issuerEstablishmentId
      )
        throw new Error('Calculation input does not match Fiscal document facts')
      const calculationId = randomUUID()
      const ruleVersionIds = Object.values(resolution.rules.lines)
        .flat()
        .map((rule) => rule.rule.id)
        .sort()
      const packageDigests = [
        ...new Set(
          Object.values(resolution.rules.lines)
            .flat()
            .map((rule) => rule.source.digest),
        ),
      ].sort()
      await tx`insert into fiscal_calculations (
        id, tenant_id, document_id, input_ciphertext, input_digest, resolved_rules,
        rules_digest, result_bytes, result_digest, explanation_template_version,
        explanation_text, rule_version_ids, package_digests, supported, actor_id
      ) values (
        ${calculationId}, ${command.tenantId}, ${command.documentId},
        ${sealCalculationInput(this.masterKey, command.tenantId, calculationId, inputBytes)},
        ${result.inputDigest}, ${tx.json(resolution.rules)}, ${result.rulesDigest},
        ${Buffer.from(resultBytes)}, ${result.resultDigest}, ${result.explanation.templateVersion},
        ${result.explanation.text}, ${ruleVersionIds}, ${packageDigests}, true, ${command.actorId}
      )`
      await tx`insert into fiscal_document_calculation_bindings (
        tenant_id, document_id, calculation_id
      ) values (${command.tenantId}, ${command.documentId}, ${calculationId})`
      await tx`update fiscal_documents set status = 'validated'
        where tenant_id = ${command.tenantId} and id = ${command.documentId}`
      await tx`insert into fiscal_transitions (id, tenant_id, document_id, kind, detail)
        values (${randomUUID()}, ${command.tenantId}, ${command.documentId}, 'validated',
          ${JSON.stringify({ calculationId, resultDigest: result.resultDigest })}::jsonb)`
      await appendAudit(tx, {
        tenantId: command.tenantId,
        actorId: command.actorId,
        action: 'document.calculation-locked',
        resourceId: command.documentId,
        detail: {
          calculationId,
          inputDigest: result.inputDigest,
          resultDigest: result.resultDigest,
        },
      })
      return result
    })
  }

  async get(tenantId: string, documentId: string): Promise<FiscalCalculationResult | null> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select calculation.result_bytes from fiscal_document_calculation_bindings binding
        join fiscal_calculations calculation on calculation.tenant_id = binding.tenant_id
          and calculation.id = binding.calculation_id
        where binding.tenant_id = ${tenantId} and binding.document_id = ${documentId}`
    })
    if (!row) return null
    return parseStoredResult(row.result_bytes)
  }

  async replay(tenantId: string, documentId: string): Promise<FiscalCalculationResult> {
    z.uuid().parse(tenantId)
    z.uuid().parse(documentId)
    const [row] = await this.#db.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${tenantId}, true)`
      return tx`select calculation.* from fiscal_document_calculation_bindings binding
        join fiscal_calculations calculation on calculation.tenant_id = binding.tenant_id
          and calculation.id = binding.calculation_id
        where binding.tenant_id = ${tenantId} and binding.document_id = ${documentId}`
    })
    if (!row) throw new Error('Fiscal calculation not found')
    const inputBytes = openCalculationInput(
      this.masterKey,
      tenantId,
      String(row.id),
      Buffer.from(row.input_ciphertext),
    )
    if (canonicalDigest(JSON.parse(inputBytes)) !== row.input_digest)
      throw new Error('Fiscal calculation input integrity failure')
    const replayed = calculateFiscal(JSON.parse(inputBytes), row.resolved_rules)
    if (!replayed.supported || canonicalJson(replayed) !== Buffer.from(row.result_bytes).toString())
      throw new Error('Fiscal calculation replay integrity failure')
    return replayed
  }
}

function normalizeInput(input: FiscalCalculationInput): FiscalCalculationInput {
  return {
    ...input,
    lines: [...input.lines].sort((left, right) => left.id.localeCompare(right.id)),
  }
}

function currencyScale(currency: string): number | null {
  if (currency === 'BRL' || currency === 'USD' || currency === 'EUR') return 2
  return null
}

function parseStoredResult(bytes: unknown): FiscalCalculationResult {
  const result = fiscalCalculationResultSchema.parse(
    JSON.parse(Buffer.from(bytes as Uint8Array).toString()),
  )
  const { resultDigest, ...covered } = result
  if (canonicalDigest(covered) !== resultDigest)
    throw new Error('Fiscal calculation result integrity failure')
  return result
}
