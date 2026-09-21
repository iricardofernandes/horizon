'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { useSession } from '@/components/shell/workspace-context'
import { Button } from '@/components/ui/button'
import { readJson } from '@/lib/api'
import { tracedFetch } from '@/lib/telemetry'
import {
  CATALOG,
  Choose,
  catalogPage,
  dataOf,
  Editor,
  Field,
  type Item,
  Screen,
  Table,
  useInventoryAction,
  value,
} from './phase38'

type Family = { id: string; name: string; attributes: string[]; active: boolean }
type Variant = {
  itemId: string
  sku: string
  name: string
  values: { attribute: string; value: string }[]
}
type Component = {
  componentItemId: string
  sku: string
  name: string
  quantity: string
  depth?: number
}
type Composition = {
  version: number
  realisation: string
  effectiveFrom: string
  components: Component[]
}
type Data = { items: Item[]; families: Family[] }
async function load(): Promise<Data> {
  const [items, families] = await Promise.all([
    catalogPage<Item>('items'),
    catalogPage<Family>('families'),
  ])
  return { items, families }
}
export function StructurePage() {
  const t = useTranslations('inventoryPhase')
  return (
    <Screen load={load} title={t('structure')} description={t('structureCopy')}>
      {(data, reload) => <Structure data={data} reload={reload} />}
    </Screen>
  )
}
function Structure({ data, reload }: { data: Data; reload: () => Promise<void> }) {
  const t = useTranslations('inventoryPhase')
  const session = useSession()
  const canEdit =
    session?.roles.some(
      (role) => role.module === 'catalog' && ['admin', 'editor'].includes(role.role),
    ) ?? false
  const action = useInventoryAction(reload)
  const [familyId, setFamilyId] = useState(data.families[0]?.id ?? '')
  const [itemId, setItemId] = useState(data.items.find((item) => item.kind === 'product')?.id ?? '')
  const [variants, setVariants] = useState<Variant[]>([])
  const [composition, setComposition] = useState<Composition | null>(null)
  const [explosion, setExplosion] = useState<Component[]>([])
  const [error, setError] = useState('')
  const [lines, setLines] = useState(['first'])
  const family = data.families.find((row) => row.id === familyId)
  const items = data.items
    .filter((item) => item.kind === 'product')
    .map((item) => ({ value: item.id, label: `${item.sku} · ${item.name}` }))
  async function showFamily(id: string) {
    setFamilyId(id)
    try {
      setError('')
      setVariants(
        (
          await readJson<{ data: Variant[] }>(
            'catalog.variants',
            `${CATALOG}/families/${id}/variants?limit=200`,
          )
        ).data,
      )
    } catch {
      setError(t('failed'))
    }
  }
  async function showRecipe(id: string) {
    setItemId(id)
    try {
      setError('')
      const response = await tracedFetch(
        'catalog.composition',
        `${CATALOG}/items/${id}/composition`,
        { cache: 'no-store' },
      )
      if (response.status === 404) setComposition(null)
      else if (response.ok) setComposition((await response.json()) as Composition)
      else setError(t('failed'))
      setExplosion(
        await readJson<Component[]>(
          'catalog.explosion',
          `${CATALOG}/items/${id}/composition/explosion`,
        ),
      )
    } catch {
      setError(t('failed'))
    }
  }
  return (
    <>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {canEdit && (
        <Editor
          title={t('newFamily')}
          action={t('createFamily')}
          busy={action.busy}
          error={action.error}
          onSubmit={async (form) => {
            const d = dataOf(form)
            if (
              await action.run(
                'families',
                'POST',
                {
                  name: value(d, 'name'),
                  attributes: value(d, 'attributes')
                    .split(',')
                    .map((part) => part.trim())
                    .filter(Boolean),
                },
                true,
              )
            )
              form.reset()
          }}
        >
          <Field label={t('name')} name="name" />
          <Field label={t('attributes')} name="attributes" placeholder={t('attributesHint')} />
        </Editor>
      )}
      <h2>{t('families')}</h2>
      <Table
        columns={[t('name'), t('attributes'), t('status'), t('actions')]}
        empty={t('empty')}
        rows={data.families.map((row) => [
          row.name,
          row.attributes.join(' · '),
          row.active ? t('active') : t('inactive'),
          <Button key={row.id} onClick={() => void showFamily(row.id)}>
            {t('variants')}
          </Button>,
        ])}
      />
      {family && (
        <div className="inventory-phase-detail">
          <h2>
            {family.name} · {t('variants')}
          </h2>
          <Table
            columns={[t('item'), ...family.attributes]}
            empty={t('empty')}
            rows={variants.map((row) => [
              row.name,
              ...family.attributes.map(
                (attribute) => row.values.find((v) => v.attribute === attribute)?.value ?? '—',
              ),
            ])}
          />
          {canEdit && (
            <Editor
              title={t('assignVariant')}
              action={t('save')}
              busy={action.busy}
              error={action.error}
              onSubmit={async (form) => {
                const d = dataOf(form)
                const assigned = family.attributes.map((attribute) => ({
                  attribute,
                  value: value(d, attribute),
                }))
                if (
                  await action.run(
                    `families/variants/${value(d, 'itemId')}`,
                    'PUT',
                    { familyId: family.id, values: assigned },
                    true,
                  )
                )
                  void showFamily(family.id)
              }}
            >
              <Choose label={t('item')} name="itemId" options={items} />
              {family.attributes.map((attribute) => (
                <Field key={attribute} label={attribute} name={attribute} />
              ))}
            </Editor>
          )}
        </div>
      )}
      <div className="inventory-phase-detail">
        <h2>{t('recipes')}</h2>
        <Choose
          label={t('item')}
          name="recipeItem"
          options={items}
          value={itemId}
          onChange={(id) => {
            setItemId(id)
            setComposition(null)
            setExplosion([])
          }}
        />
        <Button onClick={() => void showRecipe(itemId)}>{t('viewRecipe')}</Button>
        {composition && (
          <p>
            {t('recipeVersion')}: {composition.version} · {composition.realisation} ·{' '}
            {composition.effectiveFrom}
          </p>
        )}
        <Table
          columns={[t('item'), t('quantity')]}
          empty={t('empty')}
          rows={composition?.components.map((row) => [row.name, row.quantity]) ?? []}
        />
        <h3>{t('explosion')}</h3>
        <Table
          columns={[t('item'), t('quantity'), t('depth')]}
          empty={t('empty')}
          rows={explosion.map((row) => [row.name, row.quantity, row.depth ?? '—'])}
        />
        {canEdit && (
          <Editor
            title={t('newRecipe')}
            action={t('publishRecipe')}
            busy={action.busy}
            error={action.error}
            onSubmit={async (form) => {
              const d = dataOf(form)
              const recipeLines = lines.map((_, i) => ({
                componentItemId: value(d, `component${i}`),
                quantity: value(d, `quantity${i}`),
              }))
              if (
                await action.run(
                  `items/${itemId}/composition`,
                  'POST',
                  {
                    realisation: value(d, 'realisation'),
                    effectiveFrom: value(d, 'effectiveFrom'),
                    lines: recipeLines,
                  },
                  true,
                )
              )
                void showRecipe(itemId)
            }}
          >
            <Choose
              label={t('realisation')}
              name="realisation"
              options={[
                { value: 'assembled', label: t('assembled') },
                { value: 'exploded', label: t('bundle') },
              ]}
            />
            <Field
              label={t('effectiveFrom')}
              name="effectiveFrom"
              type="date"
              defaultValue={new Date().toISOString().slice(0, 10)}
            />
            {lines.map((id, i) => (
              <div className="inventory-phase-line" key={id}>
                <Choose
                  label={`${t('component')} ${i + 1}`}
                  name={`component${i}`}
                  options={items.filter((row) => row.value !== itemId)}
                />
                <Field
                  label={t('quantity')}
                  name={`quantity${i}`}
                  type="number"
                  min="0.000001"
                  step="0.000001"
                />
              </div>
            ))}
            <Button
              type="button"
              onClick={() =>
                setLines((current) =>
                  current.length < 200 ? [...current, crypto.randomUUID()] : current,
                )
              }
            >
              {t('addComponent')}
            </Button>
          </Editor>
        )}
      </div>
    </>
  )
}
