'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { SelectField } from '@/components/ui/select-field'
import {
  fiscalEstablishment,
  type TaxEstimate,
  TaxEstimatePanel,
} from '../fiscal/tax-estimate-panel'
import { type OrderDetail, PROCUREMENT_API } from './types'

const REGIMES = ['normal:lucro-real', 'normal:lucro-presumido', 'simples-nacional', 'mei'] as const

/**
 * Fiscal's estimate of what the supplier will charge (Phase 87, ADR 0073). Fiscal holds no
 * supplier regime and never infers one, so the buyer states it; the taxes charged on top of
 * the price then replace the order's typed tax while it is a draft.
 */
export function PurchaseEstimate({
  detail,
  canWrite,
  onRecorded,
}: {
  detail: OrderDetail
  canWrite: boolean
  onRecorded: () => Promise<void>
}) {
  const t = useTranslations('purchasing')
  const [regime, setRegime] = useState<(typeof REGIMES)[number]>('normal:lucro-real')
  const draft = detail.status === 'draft'
  const request = async () => {
    const establishmentId = await fiscalEstablishment()
    if (!establishmentId) return null
    const [crt, incomeTaxRegime] = regime.split(':')
    return {
      direction: 'purchase',
      establishmentId,
      supplierPartyId: detail.supplierId,
      supplier: { regime: crt, ...(incomeTaxRegime ? { incomeTaxRegime } : {}) },
      issueDate: new Date().toISOString().slice(0, 10),
      lines: detail.data.map((line) => ({
        itemId: line.itemId,
        quantity: line.quantity,
        unitPrice: { amount: line.unitPrice, currency: detail.currency },
        // What the buyer does with the goods decides the ICMS base (LC 87 art. 13 §2º).
        facts: { destinationUse: 'resale' },
      })),
    }
  }
  return (
    <>
      {draft && canWrite ? (
        <SelectField
          label={t('supplierRegime')}
          name="supplierRegime"
          onValueChange={(value) => setRegime(value as (typeof REGIMES)[number])}
          options={REGIMES.map((value) => ({
            value,
            label: t(`regime.${value.replace(':', '_')}`),
          }))}
          value={regime}
        />
      ) : null}
      <TaxEstimatePanel
        canEstimate={draft && canWrite}
        onRecorded={onRecorded}
        readStored={async () => (detail.taxEstimate as TaxEstimate | null) ?? null}
        recordedPath={`${PROCUREMENT_API}/orders/${detail.id}/tax-estimate`}
        request={request}
      />
    </>
  )
}
