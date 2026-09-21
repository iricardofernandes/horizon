'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { readJson } from '@/lib/api'
import { minorUnits } from '@/lib/format'
import {
  Choose,
  type Common,
  common,
  dataOf,
  Editor,
  Field,
  INVENTORY,
  list,
  type Money,
  optional,
  Screen,
  Table,
  trackedPicks,
  useAbilities,
  useDisplay,
  useInventoryAction,
  useNames,
  value,
} from './phase38'

type Order = {
  id: string
  itemId: string
  warehouseId: string
  quantity: string
  produced: string
  status: string
  compositionVersion: number | null
  conversionCost: Money
  openedAt: string
  subcontractorPartyId: string | null
}
type Detail = Order & {
  components: {
    itemId: string
    expected: string
    issued: string
    scrapped: string
    issuedValue: Money
  }[]
  issuedValue: Money
  scrappedValue: Money
  outputValue: Money
  note: string | null
}
type Data = Common & { orders: Order[] }
async function load(): Promise<Data> {
  const [base, orders] = await Promise.all([common(), list<Order>('production-orders')])
  return { ...base, orders }
}
export function ProductionPage() {
  const t = useTranslations('inventoryPhase')
  return (
    <Screen load={load} title={t('production')} description={t('productionCopy')}>
      {(data, reload) => <Production data={data} reload={reload} />}
    </Screen>
  )
}
function Production({ data, reload }: { data: Data; reload: () => Promise<void> }) {
  const t = useTranslations('inventoryPhase')
  const abilities = useAbilities()
  const names = useNames(data)
  const display = useDisplay()
  const action = useInventoryAction(reload)
  const [selected, setSelected] = useState<Detail | null>(null)
  const [detailError, setDetailError] = useState('')
  async function open(id: string) {
    try {
      setDetailError('')
      setSelected(
        await readJson<Detail>(
          'inventory.production.detail',
          `${INVENTORY}/production-orders/${id}`,
        ),
      )
    } catch {
      setDetailError(t('failed'))
    }
  }
  async function command(path: string, method: 'POST' | 'PUT' | 'PATCH', body?: unknown) {
    if ((await action.run(`production-orders/${selected?.id}/${path}`, method, body)) && selected)
      void open(selected.id)
  }
  return (
    <>
      {abilities.manage && (
        <Editor
          title={t('newProduction')}
          action={t('openOrder')}
          busy={action.busy}
          error={action.error}
          onSubmit={async (form) => {
            const d = dataOf(form)
            if (
              await action.run('production-orders', 'POST', {
                itemId: value(d, 'itemId'),
                warehouseId: value(d, 'warehouseId'),
                quantity: value(d, 'quantity'),
                note: optional(value(d, 'note')),
              })
            )
              form.reset()
          }}
        >
          <Choose label={t('item')} name="itemId" options={names.itemOptions} />
          <Choose label={t('warehouse')} name="warehouseId" options={names.warehouseOptions} />
          <Field
            label={t('quantity')}
            name="quantity"
            type="number"
            min="0.000001"
            step="0.000001"
          />
          <Field label={t('note')} name="note" required={false} />
        </Editor>
      )}
      <Table
        columns={[
          t('date'),
          t('item'),
          t('warehouse'),
          t('quantity'),
          t('produced'),
          t('status'),
          t('actions'),
        ]}
        empty={t('empty')}
        rows={data.orders.map((row) => [
          display.date(row.openedAt),
          names.item(row.itemId),
          names.warehouse(row.warehouseId),
          display.quantity(row.quantity),
          display.quantity(row.produced),
          row.status,
          <Button key={row.id} onClick={() => void open(row.id)}>
            {t('openOrder')}
          </Button>,
        ])}
      />
      {detailError && (
        <p className="form-error" role="alert">
          {detailError}
        </p>
      )}
      {selected && (
        <div className="panel inventory-phase-detail">
          <h2>
            {names.item(selected.itemId)} · {selected.status}
          </h2>
          <p>
            {t('recipeVersion')}: {selected.compositionVersion ?? '—'} · {t('quantity')}:{' '}
            {display.quantity(selected.quantity)} · {t('produced')}:{' '}
            {display.quantity(selected.produced)}
          </p>
          <p>
            {t('issuedValue')}: {display.money(selected.issuedValue)} · {t('scrappedValue')}:{' '}
            {display.money(selected.scrappedValue)} · {t('outputValue')}:{' '}
            {display.money(selected.outputValue)}
          </p>
          <Table
            columns={[t('item'), t('expected'), t('issued'), t('scrapped'), t('value')]}
            empty={t('empty')}
            rows={selected.components.map((row) => [
              names.item(row.itemId),
              display.quantity(row.expected),
              display.quantity(row.issued),
              display.quantity(row.scrapped),
              display.money(row.issuedValue),
            ])}
          />
          {action.error && (
            <p role="alert" className="form-error">
              {action.error}
            </p>
          )}
          {abilities.manage && selected.status === 'planned' && (
            <div className="inventory-phase-actions">
              <Button disabled={action.busy} onClick={() => void command('release', 'PATCH', {})}>
                {t('release')}
              </Button>
            </div>
          )}
          {abilities.manage && selected.status === 'released' && (
            <>
              <Editor
                title={t('issueMaterial')}
                action={t('issueMaterial')}
                busy={action.busy}
                error=""
                onSubmit={async (form) => {
                  const d = dataOf(form)
                  await command('material', 'POST', {
                    itemId: value(d, 'itemId'),
                    quantity: value(d, 'quantity'),
                    ...trackedPicks(d),
                  })
                }}
              >
                <Choose
                  label={t('item')}
                  name="itemId"
                  options={selected.components.map((row) => ({
                    value: row.itemId,
                    label: names.item(row.itemId),
                  }))}
                />
                <Field
                  label={t('quantity')}
                  name="quantity"
                  type="number"
                  min="0.000001"
                  step="0.000001"
                />
                <Field label={t('lot')} name="lot" required={false} />
                <Field label={t('serialNumbers')} name="serials" required={false} />
              </Editor>
              <Editor
                title={t('scrapMaterial')}
                action={t('scrapMaterial')}
                busy={action.busy}
                error=""
                onSubmit={async (form) => {
                  const d = dataOf(form)
                  await command('scrap', 'POST', {
                    itemId: value(d, 'itemId'),
                    quantity: value(d, 'quantity'),
                  })
                }}
              >
                <Choose
                  label={t('item')}
                  name="itemId"
                  options={selected.components.map((row) => ({
                    value: row.itemId,
                    label: names.item(row.itemId),
                  }))}
                />
                <Field
                  label={t('quantity')}
                  name="quantity"
                  type="number"
                  min="0.000001"
                  step="0.000001"
                />
              </Editor>
              <Editor
                title={t('conversionCost')}
                action={t('save')}
                busy={action.busy}
                error=""
                onSubmit={async (form) => {
                  const d = dataOf(form)
                  const amount = minorUnits(value(d, 'amount'))
                  if (!amount) return
                  await command('charge', 'PUT', {
                    amount,
                    currency: value(d, 'currency').toUpperCase(),
                    subcontractorPartyId: optional(value(d, 'subcontractorPartyId')),
                  })
                }}
              >
                <Field label={t('amount')} name="amount" type="number" min="0" step="0.01" />
                <Field label={t('currency')} name="currency" defaultValue="BRL" />
                <Field
                  label={t('subcontractorPartyId')}
                  name="subcontractorPartyId"
                  required={false}
                />
              </Editor>
              <Editor
                title={t('finish')}
                action={t('finish')}
                busy={action.busy}
                error=""
                onSubmit={async (form) => {
                  const d = dataOf(form)
                  const lot = value(d, 'lot')
                  const serials = value(d, 'serials')
                    .split(',')
                    .map((serial) => serial.trim())
                    .filter(Boolean)
                  await command('finish', 'PATCH', {
                    produced: value(d, 'produced'),
                    ...(lot
                      ? {
                          lots: [
                            {
                              code: lot,
                              quantity: value(d, 'produced'),
                              ...(value(d, 'expiresOn')
                                ? { expiresOn: value(d, 'expiresOn') }
                                : {}),
                            },
                          ],
                        }
                      : {}),
                    ...(serials.length ? { serials } : {}),
                  })
                }}
              >
                <Field
                  label={t('produced')}
                  name="produced"
                  type="number"
                  min="0"
                  step="0.000001"
                />
                <Field label={t('lot')} name="lot" required={false} />
                <Field label={t('expiresOn')} name="expiresOn" type="date" required={false} />
                <Field label={t('serialNumbers')} name="serials" required={false} />
              </Editor>
            </>
          )}
          {abilities.manage && selected.status === 'planned' && (
            <Editor
              title={t('cancelOrder')}
              action={t('cancelOrder')}
              busy={action.busy}
              error=""
              onSubmit={async (form) => {
                const d = dataOf(form)
                await command('cancel', 'PATCH', { reason: value(d, 'reason') })
              }}
            >
              <Field label={t('reason')} name="reason" />
            </Editor>
          )}
        </div>
      )}
    </>
  )
}
