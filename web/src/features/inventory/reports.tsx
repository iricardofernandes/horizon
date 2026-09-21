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
  Field,
  INVENTORY,
  list,
  type Money,
  optional,
  Screen,
  Table,
  useAbilities,
  useDisplay,
  useInventoryAction,
  useNames,
  value,
} from './phase38'

type Position = {
  itemId: string
  warehouseId: string
  warehouseName: string
  onHand: string
  reserved: string
  expired: string
  available: string
  value: string | null
  unitCost: Money
  minimum: string | null
  maximum: string | null
  alert: string | null
}
type Alert = Position & { suggested: string | null; excess: string | null }
type Level = { itemId: string; warehouseId: string; minimum: string; maximum: string | null }
type ReportRow = {
  itemId: string
  warehouseId: string | null
  quantity: string
  value: string
  currency: string | null
  abcClass?: string
  share?: string
}
type Report = {
  from: string
  to: string
  rows: ReportRow[]
  totals: { currency: string; value: string }[]
}
type Valuation = { asOf: string; rows: ReportRow[]; totals: { currency: string; value: string }[] }
type Ledger = {
  opening: { quantity: string; value: string | null }
  closing: { quantity: string; value: string | null }
  lines: {
    occurredAt: string
    kind: string
    direction: string
    quantity: string
    value: string | null
    balance: string
    balanceValue: string | null
    reason: string | null
    document: { type: string; id: string } | null
    lots: { code: string; quantity: string }[]
    unitCost: Money
  }[]
}
type Data = Common & {
  position: Position[]
  alerts: Alert[]
  levels: Level[]
  valuation: Valuation
  cogs: Report
  abc: Report
}
async function load(): Promise<Data> {
  const [base, position, alerts, levels, valuation, cogs, abc] = await Promise.all([
    common(),
    list<Position>('stock-position'),
    list<Alert>('stock-alerts'),
    list<Level>('stock-levels'),
    readJson<Valuation>('inventory.valuation', `${INVENTORY}/stock-valuation`),
    readJson<Report>('inventory.cogs', `${INVENTORY}/cost-of-goods-sold`),
    readJson<Report>('inventory.abc', `${INVENTORY}/stock-abc`),
  ])
  return { ...base, position, alerts, levels, valuation, cogs, abc }
}
export function ReportsPage() {
  const t = useTranslations('inventoryPhase')
  return (
    <Screen load={load} title={t('reports')} description={t('reportsCopy')}>
      {(data, reload) => <Reports data={data} reload={reload} />}
    </Screen>
  )
}
function Reports({ data, reload }: { data: Data; reload: () => Promise<void> }) {
  const t = useTranslations('inventoryPhase')
  const abilities = useAbilities()
  const names = useNames(data)
  const display = useDisplay()
  const action = useInventoryAction(reload)
  const [section, setSection] = useState<'position' | 'kardex' | 'valuation' | 'cogs' | 'abc'>(
    'position',
  )
  const [ledger, setLedger] = useState<Ledger | null>(null)
  const [report, setReport] = useState<Report | Valuation | null>(null)
  const [readError, setReadError] = useState('')
  async function query(path: string, form: HTMLFormElement) {
    const d = dataOf(form)
    const params = new URLSearchParams()
    for (const key of ['itemId', 'warehouseId', 'from', 'to', 'asOf']) {
      const v = value(d, key)
      if (v) params.set(key, v)
    }
    try {
      setReadError('')
      if (section === 'kardex')
        setLedger(await readJson<Ledger>('inventory.kardex', `${INVENTORY}/${path}?${params}`))
      else
        setReport(
          await readJson<Report | Valuation>('inventory.report', `${INVENTORY}/${path}?${params}`),
        )
    } catch {
      setReadError(t('failed'))
    }
  }
  const reportData =
    report ?? (section === 'valuation' ? data.valuation : section === 'cogs' ? data.cogs : data.abc)
  return (
    <>
      <nav className="inventory-phase-tabs" aria-label={t('sections')}>
        {(['position', 'kardex', 'valuation', 'cogs', 'abc'] as const).map((key) => (
          <Button
            key={key}
            variant={section === key ? 'secondary' : 'ghost'}
            onClick={() => {
              setSection(key)
              setReport(null)
            }}
          >
            {t(key)}
          </Button>
        ))}
      </nav>
      {section === 'position' && (
        <>
          <h2>{t('alerts')}</h2>
          <Table
            columns={[
              t('item'),
              t('warehouse'),
              t('available'),
              t('minimum'),
              t('maximum'),
              t('suggested'),
              t('status'),
            ]}
            empty={t('empty')}
            rows={data.alerts.map((row) => [
              names.item(row.itemId),
              row.warehouseName,
              display.quantity(row.available),
              row.minimum ?? '—',
              row.maximum ?? '—',
              row.suggested ?? row.excess ?? '—',
              row.alert === 'below' ? t('below') : t('above'),
            ])}
          />
          <h2>{t('position')}</h2>
          <Table
            columns={[
              t('item'),
              t('warehouse'),
              t('onHand'),
              t('reserved'),
              t('expired'),
              t('available'),
              t('value'),
            ]}
            empty={t('empty')}
            rows={data.position.map((row) => [
              names.item(row.itemId),
              row.warehouseName,
              display.quantity(row.onHand),
              display.quantity(row.reserved),
              display.quantity(row.expired),
              display.quantity(row.available),
              row.value && row.unitCost ? display.minor(row.value, row.unitCost.currency) : '—',
            ])}
          />
          {abilities.manage && (
            <Editor
              title={t('setLevel')}
              action={t('save')}
              busy={action.busy}
              error={action.error}
              onSubmit={async (form) => {
                const d = dataOf(form)
                if (
                  await action.run('stock-levels', 'PUT', {
                    warehouseId: value(d, 'warehouseId'),
                    itemId: value(d, 'itemId'),
                    minimum: value(d, 'minimum'),
                    maximum: optional(value(d, 'maximum')),
                  })
                )
                  form.reset()
              }}
            >
              <Choose label={t('warehouse')} name="warehouseId" options={names.warehouseOptions} />
              <Choose label={t('item')} name="itemId" options={names.itemOptions} />
              <Field label={t('minimum')} name="minimum" type="number" min="0" step="0.000001" />
              <Field
                label={t('maximum')}
                name="maximum"
                type="number"
                min="0"
                step="0.000001"
                required={false}
              />
            </Editor>
          )}
          <Table
            columns={[t('item'), t('warehouse'), t('minimum'), t('maximum')]}
            empty={t('empty')}
            rows={data.levels.map((row) => [
              names.item(row.itemId),
              names.warehouse(row.warehouseId),
              display.quantity(row.minimum),
              row.maximum ? display.quantity(row.maximum) : '—',
            ])}
          />
        </>
      )}
      {section === 'kardex' && (
        <>
          <Editor
            title={t('kardex')}
            action={t('search')}
            busy={false}
            error={readError}
            onSubmit={(form) => query('stock-ledger', form)}
          >
            <Choose label={t('item')} name="itemId" options={names.itemOptions} />
            <Choose label={t('warehouse')} name="warehouseId" options={names.warehouseOptions} />
            <Field label={t('from')} name="from" type="date" required={false} />
            <Field label={t('to')} name="to" type="date" required={false} />
          </Editor>
          {ledger && (
            <>
              <p className="inventory-phase-summary">
                {t('opening')}: {display.quantity(ledger.opening.quantity)} · {t('closing')}:{' '}
                {display.quantity(ledger.closing.quantity)}
              </p>
              <Table
                columns={[
                  t('date'),
                  t('movement'),
                  t('direction'),
                  t('quantity'),
                  t('unitCost'),
                  t('value'),
                  t('balance'),
                  t('document'),
                  t('lot'),
                ]}
                empty={t('empty')}
                rows={ledger.lines.map((row) => [
                  display.date(row.occurredAt),
                  row.kind,
                  t(row.direction),
                  display.quantity(row.quantity),
                  display.money(row.unitCost),
                  row.value && row.unitCost ? display.minor(row.value, row.unitCost.currency) : '—',
                  display.quantity(row.balance),
                  row.document ? `${row.document.type} · ${row.document.id}` : '—',
                  row.lots.map((lot) => `${lot.code} (${lot.quantity})`).join(', ') || '—',
                ])}
              />
            </>
          )}
        </>
      )}
      {(section === 'valuation' || section === 'cogs' || section === 'abc') && (
        <>
          <Editor
            title={t(section)}
            action={t('search')}
            busy={false}
            error={readError}
            onSubmit={(form) =>
              query(
                section === 'valuation'
                  ? 'stock-valuation'
                  : section === 'cogs'
                    ? 'cost-of-goods-sold'
                    : 'stock-abc',
                form,
              )
            }
          >
            <Choose
              label={t('warehouse')}
              name="warehouseId"
              options={names.warehouseOptions}
              required={false}
            />
            {section === 'valuation' ? (
              <Field label={t('asOf')} name="asOf" type="date" required={false} />
            ) : (
              <>
                <Field label={t('from')} name="from" type="date" required={false} />
                <Field label={t('to')} name="to" type="date" required={false} />
              </>
            )}
          </Editor>
          <p className="inventory-phase-summary">
            {reportData.totals.map((row) => display.minor(row.value, row.currency)).join(' · ') ||
              '—'}
          </p>
          <Table
            columns={[
              t('item'),
              t('warehouse'),
              t('quantity'),
              t('value'),
              ...(section === 'abc' ? [t('class'), t('share')] : []),
            ]}
            empty={t('empty')}
            rows={reportData.rows.map((row) => [
              names.item(row.itemId),
              names.warehouse(row.warehouseId),
              display.quantity(row.quantity),
              display.minor(row.value, row.currency),
              ...(section === 'abc'
                ? [row.abcClass ?? '—', row.share ? `${row.share}%` : '—']
                : []),
            ])}
          />
        </>
      )}
    </>
  )
}
