'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { readJson } from '@/lib/api'
import {
  Choose,
  type Common,
  common,
  dataOf,
  Editor,
  INVENTORY,
  list,
  Screen,
  Table,
  useAbilities,
  useDisplay,
  useInventoryAction,
  useNames,
  value,
} from './phase38'

type Tracking = { itemId: string; tracking: string; expiry: string }
type Lot = {
  itemId: string
  warehouseId: string
  warehouseName: string
  code: string
  onHand: string
  expiresOn: string | null
  expired: boolean
}
type Serial = {
  itemId: string
  serial: string
  status: string
  warehouseName: string | null
  receivedAt: string
}
type Trace = {
  steps: {
    occurredAt: string
    warehouseName: string
    kind: string
    direction: string
    quantity: string
    document: { type: string; id: string } | null
  }[]
}
type Data = Common & { tracking: Tracking[]; lots: Lot[]; serials: Serial[] }
async function load(): Promise<Data> {
  const [base, tracking, lots, serials] = await Promise.all([
    common(),
    readJson<Tracking[]>('inventory.tracking', `${INVENTORY}/item-tracking`),
    list<Lot>('stock-lots'),
    list<Serial>('stock-serials'),
  ])
  return { ...base, tracking, lots, serials }
}
export function TrackingPage() {
  const t = useTranslations('inventoryPhase')
  return (
    <Screen load={load} title={t('tracking')} description={t('trackingCopy')}>
      {(data, reload) => <TrackingScreen data={data} reload={reload} />}
    </Screen>
  )
}
function TrackingScreen({ data, reload }: { data: Data; reload: () => Promise<void> }) {
  const t = useTranslations('inventoryPhase')
  const abilities = useAbilities()
  const names = useNames(data)
  const display = useDisplay()
  const action = useInventoryAction(reload)
  const [section, setSection] = useState<'lots' | 'serials' | 'policy'>('lots')
  const [trace, setTrace] = useState<{ title: string; data: Trace } | null>(null)
  const [traceError, setTraceError] = useState('')
  async function showTrace(kind: 'stock-lots' | 'stock-serials', code: string, itemId: string) {
    try {
      setTraceError('')
      const result = await readJson<Trace>(
        'inventory.trace',
        `${INVENTORY}/${kind}/${encodeURIComponent(code)}/trace?itemId=${encodeURIComponent(itemId)}&limit=200`,
      )
      setTrace({ title: code, data: result })
    } catch {
      setTraceError(t('failed'))
    }
  }
  return (
    <>
      <nav className="inventory-phase-tabs" aria-label={t('sections')}>
        {(['lots', 'serials', 'policy'] as const).map((key) => (
          <Button
            key={key}
            variant={section === key ? 'secondary' : 'ghost'}
            onClick={() => {
              setSection(key)
              setTrace(null)
            }}
          >
            {t(key)}
          </Button>
        ))}
      </nav>
      {section === 'lots' && (
        <Table
          columns={[
            t('item'),
            t('warehouse'),
            t('lot'),
            t('onHand'),
            t('expiresOn'),
            t('status'),
            t('actions'),
          ]}
          empty={t('empty')}
          rows={data.lots.map((row) => [
            names.item(row.itemId),
            row.warehouseName,
            row.code,
            display.quantity(row.onHand),
            row.expiresOn ?? '—',
            row.expired ? t('expired') : t('active'),
            <Button
              key={`${row.itemId}:${row.code}`}
              onClick={() => void showTrace('stock-lots', row.code, row.itemId)}
            >
              {t('trace')}
            </Button>,
          ])}
        />
      )}
      {section === 'serials' && (
        <Table
          columns={[t('item'), t('serial'), t('warehouse'), t('status'), t('date'), t('actions')]}
          empty={t('empty')}
          rows={data.serials.map((row) => [
            names.item(row.itemId),
            row.serial,
            row.warehouseName ?? '—',
            row.status,
            display.date(row.receivedAt),
            <Button
              key={`${row.itemId}:${row.serial}`}
              onClick={() => void showTrace('stock-serials', row.serial, row.itemId)}
            >
              {t('trace')}
            </Button>,
          ])}
        />
      )}
      {section === 'policy' && (
        <>
          {abilities.manage && (
            <Editor
              title={t('setTracking')}
              action={t('save')}
              busy={action.busy}
              error={action.error}
              onSubmit={async (form) => {
                const d = dataOf(form)
                if (
                  await action.run('item-tracking', 'PUT', {
                    itemId: value(d, 'itemId'),
                    tracking: value(d, 'tracking'),
                    expiry: value(d, 'expiry'),
                  })
                )
                  form.reset()
              }}
            >
              <Choose label={t('item')} name="itemId" options={names.itemOptions} />
              <Choose
                label={t('tracking')}
                name="tracking"
                options={['none', 'lot', 'serial'].map((key) => ({ value: key, label: t(key) }))}
              />
              <Choose
                label={t('expiry')}
                name="expiry"
                options={['none', 'optional', 'required'].map((key) => ({
                  value: key,
                  label: t(key),
                }))}
              />
            </Editor>
          )}
          <Table
            columns={[t('item'), t('tracking'), t('expiry')]}
            empty={t('empty')}
            rows={data.tracking.map((row) => [
              names.item(row.itemId),
              t(row.tracking),
              t(row.expiry),
            ])}
          />
        </>
      )}
      {traceError && (
        <p role="alert" className="form-error">
          {traceError}
        </p>
      )}
      {trace && (
        <div className="inventory-phase-detail">
          <h2>
            {t('trace')} · {trace.title}
          </h2>
          <Table
            columns={[
              t('date'),
              t('warehouse'),
              t('movement'),
              t('direction'),
              t('quantity'),
              t('document'),
            ]}
            empty={t('empty')}
            rows={trace.data.steps.map((row) => [
              display.date(row.occurredAt),
              row.warehouseName,
              row.kind,
              t(row.direction),
              display.quantity(row.quantity),
              row.document ? `${row.document.type} · ${row.document.id}` : '—',
            ])}
          />
        </div>
      )}
    </>
  )
}
