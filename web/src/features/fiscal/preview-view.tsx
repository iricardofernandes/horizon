'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/button'
import { PageHeading, PanelHeading } from '@/components/ui/headings'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { tracedFetch } from '@/lib/telemetry'
import {
  buildPreviewInput,
  type Capability,
  type DocumentModel,
  FISCAL_API,
  type PreviewForm,
} from './types'

/** The reviewed rule operations of each model; a preview outside them is refused. */
const OPERATIONS: readonly { model: DocumentModel; operation: string }[] = [
  { model: '55', operation: 'rtc-v0057-model55-normal-sale' },
  { model: '65', operation: 'rtc-v0057-model65-consumer-sale' },
  { model: 'nfse', operation: 'rtc-v0057-nfse-service-3550308' },
]

type PreviewResult =
  | { kind: 'supported'; text: string; digest: string | null }
  | { kind: 'refused'; code: string; detail: string }

function previewForm(
  selected: { model: DocumentModel; operation: string },
  read: (name: string) => string,
): PreviewForm {
  const text = (name: string) => read(name).trim()
  return {
    establishmentId: text('establishmentId'),
    model: selected.model,
    operation: selected.operation,
    issueDate: text('issueDate'),
    issuerRegime: 'normal',
    issuerState: text('issuerState'),
    issuerMunicipality: text('issuerMunicipality'),
    recipientState: text('recipientState'),
    recipientMunicipality: text('recipientMunicipality'),
    recipientTaxpayer: text('recipientTaxpayer') === 'yes',
    lineId: crypto.randomUUID(),
    itemId: crypto.randomUUID(),
    classification: text('classification'),
    quantity: text('quantity'),
    unitPrice: text('unitPrice'),
  }
}

function previewResult(
  ok: boolean,
  status: number,
  body: Record<string, unknown>,
  noDetail: string,
): PreviewResult {
  if (ok && body.supported === true) {
    const explanation = body.explanation as { text?: unknown } | undefined
    return {
      kind: 'supported',
      text:
        typeof explanation?.text === 'string' ? explanation.text : JSON.stringify(body, null, 2),
      digest: typeof body.resultDigest === 'string' ? body.resultDigest : null,
    }
  }
  return {
    kind: 'refused',
    code: typeof body.code === 'string' ? body.code : String(status),
    detail: typeof body.detail === 'string' ? body.detail : noDetail,
  }
}

/**
 * Explains a calculation before any document exists. The preview reads the same reviewed
 * rules a document locks, and never creates a document, a number or an effect.
 */
export function PreviewView({ capabilities }: { capabilities: Capability[] }) {
  const t = useTranslations('fiscal')
  const [choice, setChoice] = useState(OPERATIONS[0]?.operation ?? '')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [result, setResult] = useState<PreviewResult | null>(null)
  const selected = OPERATIONS.find((option) => option.operation === choice) ?? OPERATIONS[0]
  const establishments = [...new Set(capabilities.map((row) => row.establishmentId))]

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected) return
    setProblem('')
    setResult(null)
    const data = new FormData(event.currentTarget)
    const built = buildPreviewInput(previewForm(selected, (name) => String(data.get(name) ?? '')))
    if (!built.ok) {
      setProblem(t(`preview.${built.problem}`))
      return
    }
    setBusy(true)
    const response = await tracedFetch(
      'fiscal.calculation.preview',
      `${FISCAL_API}/calculations/preview`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(built.input),
      },
    )
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    setBusy(false)
    setResult(previewResult(response.ok, response.status, body, t('actions.noDetail')))
  }

  const today = new Date().toISOString().slice(0, 10)
  const service = selected?.model === 'nfse'
  return (
    <section className="fiscal-page">
      <PageHeading eyebrow={t('eyebrow')} title={t('preview.title')} copy={t('preview.copy')} />
      <div className="split-grid">
        <section className="panel form-panel">
          <PanelHeading title={t('preview.formTitle')} copy={t('preview.formCopy')} />
          <form className="dialog-form" onSubmit={submit}>
            <SelectField
              label={t('preview.operation')}
              name="operation"
              onValueChange={(value) => setChoice(value ?? '')}
              options={OPERATIONS.map((option) => ({
                value: option.operation,
                label: t('preview.operationLabel', {
                  model: t(`models.${option.model}`),
                  operation: option.operation,
                }),
              }))}
              value={choice}
            />
            {establishments.length ? (
              <SelectField
                label={t('preview.establishment')}
                name="establishmentId"
                options={establishments.map((id) => ({ value: id, label: id }))}
              />
            ) : (
              <TextField label={t('preview.establishment')} name="establishmentId" required />
            )}
            <TextField
              defaultValue={today}
              label={service ? t('preview.competence') : t('preview.issueDate')}
              name="issueDate"
              required
              type="date"
            />
            <div className="fiscal-form-row">
              <TextField
                defaultValue="35"
                label={t('preview.issuerState')}
                name="issuerState"
                required
              />
              <TextField
                defaultValue="3550308"
                label={t('preview.issuerMunicipality')}
                name="issuerMunicipality"
                required
              />
            </div>
            <div className="fiscal-form-row">
              <TextField
                defaultValue="35"
                label={t('preview.recipientState')}
                name="recipientState"
                required
              />
              <TextField
                defaultValue="3550308"
                label={t('preview.recipientMunicipality')}
                name="recipientMunicipality"
                required
              />
            </div>
            <SelectField
              label={t('preview.recipientTaxpayer')}
              name="recipientTaxpayer"
              options={[
                { value: 'yes', label: t('preview.taxpayerYes') },
                { value: 'no', label: t('preview.taxpayerNo') },
              ]}
            />
            <TextField
              description={service ? t('preview.serviceHint') : t('preview.ncmHint')}
              label={service ? t('preview.serviceCode') : t('preview.ncm')}
              name="classification"
              required
            />
            <div className="fiscal-form-row">
              <TextField defaultValue="1" label={t('preview.quantity')} name="quantity" required />
              <TextField
                defaultValue="100.00"
                label={t('preview.unitPrice')}
                name="unitPrice"
                required
              />
            </div>
            {problem ? (
              <p className="form-error" role="alert">
                {problem}
              </p>
            ) : null}
            <Button disabled={busy} type="submit" variant="primary">
              {busy ? t('preview.calculating') : t('preview.calculate')}
            </Button>
          </form>
        </section>
        <section aria-live="polite" className="panel quiet-panel">
          <PanelHeading title={t('preview.resultTitle')} copy={t('preview.resultCopy')} />
          {!result ? (
            <p className="empty">{t('preview.noResult')}</p>
          ) : result.kind === 'supported' ? (
            <div className="fiscal-explanation">
              <pre>{result.text}</pre>
              {result.digest ? (
                <p className="dialog-description">
                  {t('preview.resultDigest', { digest: result.digest.slice(0, 12) })}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="form-error" role="alert">
              {t('actions.refused', { code: result.code, detail: result.detail })}
            </p>
          )}
        </section>
      </div>
    </section>
  )
}
