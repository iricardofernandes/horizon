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

type Transfer = {
  id: string
  sourceWarehouseId: string
  destinationWarehouseId: string
  movedAt: string
  note: string | null
  lines: { itemId: string; quantity: string }[]
}
type Adjustment = {
  id: string
  itemId: string
  warehouseId: string
  direction: string
  quantity: string
  reason: string
  status: string
  approvalState: string
  requestedAt: string
}
type Count = {
  id: string
  warehouseId: string
  status: string
  approvalState: string
  openedAt: string
}
type CountDetail = Count & {
  lines: {
    itemId: string
    lot: string | null
    serial: string | null
    expected: string
    counted: string | null
    variance: { direction: string; quantity: string } | null
  }[]
}
type Policy = { currency: string; threshold: string }
type Data = Common & {
  transfers: Transfer[]
  adjustments: Adjustment[]
  counts: Count[]
  policies: Policy[]
}
async function load(): Promise<Data> {
  const [base, transfers, adjustments, counts, policies] = await Promise.all([
    common(),
    list<Transfer>('stock-transfers'),
    list<Adjustment>('stock-adjustments'),
    list<Count>('stock-counts'),
    readJson<Policy[]>('inventory.adjustment-policies', `${INVENTORY}/adjustment-policies`),
  ])
  return { ...base, transfers, adjustments, counts, policies }
}

export function OperationsPage() {
  const t = useTranslations('inventoryPhase')
  return (
    <Screen load={load} title={t('operations')} description={t('operationsCopy')}>
      {(data, reload) => <Operations data={data} reload={reload} />}
    </Screen>
  )
}
function Operations({ data, reload }: { data: Data; reload: () => Promise<void> }) {
  const t = useTranslations('inventoryPhase')
  const abilities = useAbilities()
  const names = useNames(data)
  const display = useDisplay()
  const action = useInventoryAction(reload)
  const [section, setSection] = useState<'transfers' | 'adjustments' | 'counts'>('transfers')
  const [selectedCount, setSelectedCount] = useState<CountDetail | null>(null)
  const [reason, setReason] = useState('')
  async function openCount(id: string) {
    try {
      setSelectedCount(
        await readJson<CountDetail>('inventory.count.detail', `${INVENTORY}/stock-counts/${id}`),
      )
    } catch {
      action.clear()
    }
  }
  async function decide(path: string, body?: unknown) {
    if (await action.run(path, 'PATCH', body)) {
      setReason('')
      if (selectedCount) void openCount(selectedCount.id)
    }
  }
  return (
    <>
      <nav className="inventory-phase-tabs" aria-label={t('sections')}>
        <Button
          variant={section === 'transfers' ? 'secondary' : 'ghost'}
          onClick={() => setSection('transfers')}
        >
          {t('transfers')}
        </Button>
        <Button
          variant={section === 'adjustments' ? 'secondary' : 'ghost'}
          onClick={() => setSection('adjustments')}
        >
          {t('adjustments')}
        </Button>
        <Button
          variant={section === 'counts' ? 'secondary' : 'ghost'}
          onClick={() => setSection('counts')}
        >
          {t('counts')}
        </Button>
      </nav>
      {section === 'transfers' && (
        <>
          {abilities.manage && (
            <Editor
              title={t('newTransfer')}
              action={t('transfer')}
              busy={action.busy}
              error={action.error}
              onSubmit={async (form) => {
                const d = dataOf(form)
                if (
                  await action.run('stock-transfers', 'POST', {
                    sourceWarehouseId: value(d, 'sourceWarehouseId'),
                    destinationWarehouseId: value(d, 'destinationWarehouseId'),
                    lines: [
                      {
                        itemId: value(d, 'itemId'),
                        quantity: value(d, 'quantity'),
                        ...trackedPicks(d),
                      },
                    ],
                    note: optional(value(d, 'note')),
                  })
                )
                  form.reset()
              }}
            >
              <Choose
                label={t('source')}
                name="sourceWarehouseId"
                options={names.warehouseOptions}
              />
              <Choose
                label={t('destination')}
                name="destinationWarehouseId"
                options={names.warehouseOptions}
              />
              <Choose label={t('item')} name="itemId" options={names.itemOptions} />
              <Field
                label={t('quantity')}
                name="quantity"
                type="number"
                min="0.000001"
                step="0.000001"
              />
              <Field label={t('lot')} name="lot" required={false} />
              <Field label={t('serialNumbers')} name="serials" required={false} />
              <Field label={t('note')} name="note" required={false} />
            </Editor>
          )}
          <Table
            columns={[
              t('date'),
              t('source'),
              t('destination'),
              t('item'),
              t('quantity'),
              t('note'),
            ]}
            empty={t('empty')}
            rows={data.transfers.flatMap((row) =>
              row.lines.map((line) => [
                display.date(row.movedAt),
                names.warehouse(row.sourceWarehouseId),
                names.warehouse(row.destinationWarehouseId),
                names.item(line.itemId),
                display.quantity(line.quantity),
                row.note ?? '—',
              ]),
            )}
          />
        </>
      )}
      {section === 'adjustments' && (
        <>
          {abilities.manage && (
            <Editor
              title={t('newAdjustment')}
              action={t('requestAdjustment')}
              busy={action.busy}
              error={action.error}
              onSubmit={async (form) => {
                const d = dataOf(form)
                const body = {
                  warehouseId: value(d, 'warehouseId'),
                  itemId: value(d, 'itemId'),
                  direction: value(d, 'direction'),
                  quantity: value(d, 'quantity'),
                  reason: value(d, 'reason'),
                  note: optional(value(d, 'note')),
                  ...(value(d, 'lot') ? { lot: value(d, 'lot') } : {}),
                  ...(value(d, 'serials')
                    ? {
                        serials: value(d, 'serials')
                          .split(',')
                          .map((serial) => serial.trim())
                          .filter(Boolean),
                      }
                    : {}),
                  ...(value(d, 'unitCost')
                    ? {
                        unitCost: {
                          amount: minorUnits(value(d, 'unitCost')),
                          currency: value(d, 'currency').toUpperCase(),
                        },
                      }
                    : {}),
                }
                if (await action.run('stock-adjustments', 'POST', body)) form.reset()
              }}
            >
              <Choose label={t('warehouse')} name="warehouseId" options={names.warehouseOptions} />
              <Choose label={t('item')} name="itemId" options={names.itemOptions} />
              <Choose
                label={t('direction')}
                name="direction"
                options={[
                  { value: 'in', label: t('in') },
                  { value: 'out', label: t('out') },
                ]}
              />
              <Field
                label={t('quantity')}
                name="quantity"
                type="number"
                min="0.000001"
                step="0.000001"
              />
              <Choose
                label={t('reason')}
                name="reason"
                options={['breakage', 'loss', 'theft', 'expiry', 'found', 'correction'].map(
                  (key) => ({ value: key, label: t(key) }),
                )}
              />
              <Field label={t('lot')} name="lot" required={false} />
              <Field label={t('serialNumbers')} name="serials" required={false} />
              <Field
                label={t('unitCost')}
                name="unitCost"
                type="number"
                min="0"
                step="0.01"
                required={false}
              />
              <Field label={t('currency')} name="currency" defaultValue="BRL" />
              <Field label={t('note')} name="note" required={false} />
            </Editor>
          )}
          {abilities.approve && (
            <Editor
              title={t('adjustmentPolicy')}
              action={t('save')}
              busy={action.busy}
              error={action.error}
              onSubmit={async (form) => {
                const d = dataOf(form)
                const threshold = minorUnits(value(d, 'threshold'))
                if (!threshold) return
                await action.run('adjustment-policies', 'PUT', {
                  currency: value(d, 'currency').toUpperCase(),
                  threshold,
                })
              }}
            >
              <Field label={t('currency')} name="currency" defaultValue="BRL" />
              <Field
                label={t('approvalThreshold')}
                name="threshold"
                type="number"
                min="0"
                step="0.01"
              />
            </Editor>
          )}
          <Table
            columns={[t('currency'), t('approvalThreshold')]}
            empty={t('empty')}
            rows={data.policies.map((row) => [
              row.currency,
              display.minor(row.threshold, row.currency),
            ])}
          />
          {abilities.approve && (
            <label className="ui-field inventory-phase-reason">
              <span className="ui-field-label">{t('rejectionReason')}</span>
              <input
                className="ui-input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          )}
          <Table
            columns={[
              t('date'),
              t('item'),
              t('warehouse'),
              t('direction'),
              t('quantity'),
              t('reason'),
              t('status'),
              t('actions'),
            ]}
            empty={t('empty')}
            rows={data.adjustments.map((row) => [
              display.date(row.requestedAt),
              names.item(row.itemId),
              names.warehouse(row.warehouseId),
              t(row.direction),
              display.quantity(row.quantity),
              t(row.reason),
              row.status,
              abilities.approve && row.approvalState === 'pending' ? (
                <div className="inventory-phase-actions" key={row.id}>
                  <Button
                    disabled={action.busy}
                    onClick={() => void decide(`stock-adjustments/${row.id}/approve`)}
                  >
                    {t('approve')}
                  </Button>
                  <Button
                    disabled={action.busy || !reason.trim()}
                    onClick={() => void decide(`stock-adjustments/${row.id}/reject`, { reason })}
                  >
                    {t('reject')}
                  </Button>
                </div>
              ) : (
                '—'
              ),
            ])}
          />
        </>
      )}
      {section === 'counts' && (
        <>
          {abilities.manage && (
            <Editor
              title={t('newCount')}
              action={t('openCount')}
              busy={action.busy}
              error={action.error}
              onSubmit={async (form) => {
                const d = dataOf(form)
                if (
                  await action.run('stock-counts', 'POST', {
                    warehouseId: value(d, 'warehouseId'),
                    note: optional(value(d, 'note')),
                  })
                )
                  form.reset()
              }}
            >
              <Choose label={t('warehouse')} name="warehouseId" options={names.warehouseOptions} />
              <Field label={t('note')} name="note" required={false} />
            </Editor>
          )}
          <Table
            columns={[t('date'), t('warehouse'), t('status'), t('actions')]}
            empty={t('empty')}
            rows={data.counts.map((row) => [
              display.date(row.openedAt),
              names.warehouse(row.warehouseId),
              row.status,
              <Button key={row.id} onClick={() => void openCount(row.id)}>
                {t('openSheet')}
              </Button>,
            ])}
          />
          {selectedCount && (
            <div className="panel inventory-phase-detail">
              <h2>
                {t('countSheet')} · {names.warehouse(selectedCount.warehouseId)}
              </h2>
              <p>{selectedCount.status}</p>
              {action.error && (
                <p role="alert" className="form-error">
                  {action.error}
                </p>
              )}
              <Table
                columns={[
                  t('item'),
                  t('lot'),
                  t('serial'),
                  t('expected'),
                  t('counted'),
                  t('difference'),
                ]}
                empty={t('empty')}
                rows={selectedCount.lines.map((line) => [
                  names.item(line.itemId),
                  line.lot ?? '—',
                  line.serial ?? '—',
                  display.quantity(line.expected),
                  line.counted === null ? '—' : display.quantity(line.counted),
                  line.variance
                    ? `${line.variance.direction === 'in' ? '+' : '−'}${display.quantity(line.variance.quantity)}`
                    : '—',
                ])}
              />
              {abilities.manage && selectedCount.status === 'open' && (
                <Editor
                  title={t('recordFigure')}
                  action={t('recordFigure')}
                  busy={action.busy}
                  error=""
                  onSubmit={async (form) => {
                    const d = dataOf(form)
                    const line = selectedCount.lines[Number(value(d, 'line'))]
                    if (!line) return
                    const figure = {
                      itemId: line.itemId,
                      ...(line.lot ? { lot: line.lot } : {}),
                      ...(line.serial ? { serial: line.serial } : {}),
                      counted: value(d, 'counted'),
                    }
                    if (
                      await action.run(`stock-counts/${selectedCount.id}/figures`, 'PATCH', {
                        counts: [figure],
                      })
                    )
                      void openCount(selectedCount.id)
                  }}
                >
                  <Choose
                    label={t('item')}
                    name="line"
                    options={selectedCount.lines.map((line, index) => ({
                      value: String(index),
                      label: `${names.item(line.itemId)}${line.lot ? ` · ${line.lot}` : ''}${line.serial ? ` · ${line.serial}` : ''}`,
                    }))}
                  />
                  <Field
                    label={t('counted')}
                    name="counted"
                    type="number"
                    min="0"
                    step="0.000001"
                  />
                </Editor>
              )}
              <div className="inventory-phase-actions">
                {abilities.manage && selectedCount.status === 'open' && (
                  <Button
                    disabled={action.busy}
                    onClick={() => void decide(`stock-counts/${selectedCount.id}/close`)}
                  >
                    {t('closeCount')}
                  </Button>
                )}
                {abilities.approve && selectedCount.approvalState === 'pending' && (
                  <>
                    <Button
                      disabled={action.busy}
                      onClick={() => void decide(`stock-counts/${selectedCount.id}/approve`)}
                    >
                      {t('approve')}
                    </Button>
                    <input
                      className="ui-input"
                      aria-label={t('rejectionReason')}
                      placeholder={t('rejectionReason')}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                    <Button
                      disabled={action.busy || !reason.trim()}
                      onClick={() =>
                        void decide(`stock-counts/${selectedCount.id}/reject`, { reason })
                      }
                    >
                      {t('reject')}
                    </Button>
                  </>
                )}
                {abilities.manage && selectedCount.status === 'open' && (
                  <Button
                    disabled={action.busy || !reason.trim()}
                    onClick={() =>
                      void decide(`stock-counts/${selectedCount.id}/cancel`, { reason })
                    }
                  >
                    {t('cancelCount')}
                  </Button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
}
