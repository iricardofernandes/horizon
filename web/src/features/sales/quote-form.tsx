'use client'

import { Plus, Trash } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import type { CatalogItem } from '@/features/catalog/catalog-view'
import { minorUnits } from '@/lib/format'
import type { QuoteLine } from './types'

/** What the form is filled with: an empty offer, or the version being answered. */
export type QuoteDraft = {
  lines: readonly Pick<QuoteLine, 'itemId' | 'quantity'>[]
  discount: string
  freight: string
  carrier: string | null
  paymentTermDays: readonly number[]
  notes: string | null
}

export const EMPTY_DRAFT: QuoteDraft = {
  lines: [{ itemId: '', quantity: '1' }],
  discount: '0',
  freight: '0',
  carrier: null,
  paymentTermDays: [30],
  notes: null,
}

/**
 * The goods and the terms of one offer.
 *
 * A new offer and the answer to one are the same form, because a revision is not a
 * different kind of document: it is this offer said again, differently. Starting the
 * revision from what is on the table is what makes a negotiation a negotiation rather
 * than a series of unrelated quotes.
 */
export function QuoteFields({
  items,
  draft,
}: {
  items: readonly CatalogItem[]
  draft: QuoteDraft
}) {
  const t = useTranslations('sales')
  const [lines, setLines] = useState(() => draft.lines.map((line, index) => ({ ...line, index })))
  const [nextLine, setNextLine] = useState(draft.lines.length)
  const sellable = items.filter((item) => item.active)

  return (
    <>
      <div className="order-lines-heading">
        <strong>{t('quoteLines')}</strong>
        <Button
          disabled={lines.length >= 100}
          onClick={() => {
            setLines((current) => [...current, { itemId: '', quantity: '1', index: nextLine }])
            setNextLine((current) => current + 1)
          }}
          type="button"
          variant="secondary"
        >
          <Plus aria-hidden="true" size={15} />
          {t('addLine')}
        </Button>
      </div>
      <div className="order-lines">
        {lines.map((line, position) => (
          <div className="order-line" key={line.index}>
            <SelectField
              defaultValue={line.itemId || null}
              label={t('item', { index: position + 1 })}
              name="itemId"
              options={sellable.map((item) => ({
                label: `${item.name} · ${item.sku}`,
                value: item.id,
              }))}
              required
            />
            <TextField
              defaultValue={line.quantity}
              inputMode="decimal"
              label={t('quantity')}
              name="quantity"
              pattern="[0-9]+([.][0-9]{1,6})?"
              required
            />
            <Button
              aria-label={t('removeItem', { index: position + 1 })}
              className="remove-order-line"
              disabled={lines.length === 1}
              onClick={() =>
                setLines((current) => current.filter((row) => row.index !== line.index))
              }
              type="button"
            >
              <Trash aria-hidden="true" size={16} />
            </Button>
          </div>
        ))}
      </div>
      <div className="form-grid two-columns">
        <TextField
          defaultValue={majorUnits(draft.discount)}
          inputMode="decimal"
          label={t('discount')}
          name="discount"
          pattern="[0-9]+([.,][0-9]{1,2})?"
        />
        <TextField
          defaultValue={majorUnits(draft.freight)}
          inputMode="decimal"
          label={t('freight')}
          name="freight"
          pattern="[0-9]+([.,][0-9]{1,2})?"
        />
        <TextField defaultValue={draft.carrier ?? ''} label={t('carrier')} name="carrier" />
        <TextField
          defaultValue={draft.paymentTermDays.join(',')}
          label={t('paymentTerms')}
          name="paymentTermDays"
          pattern="[0-9]+([,][0-9]+)*"
          required
        />
      </div>
      <TextField defaultValue={draft.notes ?? ''} label={t('notes')} name="notes" />
    </>
  )
}

/** The offer these fields describe, in the shape Sales takes it. */
export function quoteBody(data: FormData): {
  lines: Array<{ lineId: string; itemId: string; quantity: string }>
  terms: Record<string, unknown>
} {
  const itemIds = data.getAll('itemId').map(String)
  const quantities = data.getAll('quantity').map(String)
  const text = (name: string) => String(data.get(name) ?? '').trim()
  const days = text('paymentTermDays')
    .split(',')
    .map((day) => Number(day.trim()))
    .filter((day) => Number.isInteger(day) && day >= 0)
  const carrier = text('carrier')
  const notes = text('notes')
  return {
    lines: itemIds.map((itemId, index) => ({
      lineId: crypto.randomUUID(),
      itemId,
      quantity: quantities[index] ?? '1',
    })),
    terms: {
      discount: minorUnits(text('discount') || '0') ?? '0',
      freight: minorUnits(text('freight') || '0') ?? '0',
      ...(carrier.length >= 2 ? { carrier } : {}),
      ...(days.length > 0 ? { paymentTermDays: days } : {}),
      ...(notes ? { notes } : {}),
    },
  }
}

/** Minor units back into what a person types, so a revision starts where the offer is. */
function majorUnits(amount: string): string {
  return (Number(amount) / 100).toFixed(2)
}
