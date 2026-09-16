'use client'

import { Tabs } from '@base-ui/react/tabs'
import { useTranslations } from 'next-intl'
import { PageHeading } from '@/components/ui/headings'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { PaymentTermsPanel } from './payment-terms-panel'
import { CreateDialog, EmptyRow, type MutationProps, StatusCell } from './registry-parts'
import { type Classifications, PAYMENT_METHOD_KINDS } from './types'

type PanelProps = { data: Classifications; canManage: boolean } & MutationProps

/**
 * The dimensions every title will be classified by (ADR 0041): what money is for, who it
 * is for, how it moves and when it falls due. Entries are deactivated, never deleted.
 */
export function ClassificationsView(props: PanelProps) {
  const t = useTranslations('classifications')
  return (
    <section>
      <PageHeading eyebrow={t('eyebrow')} title={t('title')} copy={t('copy')} />
      <Tabs.Root className="catalog-tabs" defaultValue="categories">
        <div className="catalog-toolbar">
          <Tabs.List aria-label={t('sections')} className="ui-tabs-list">
            <Tabs.Tab className="ui-tab" value="categories">
              {t('categories')} <span className="tab-count">{props.data.categories.length}</span>
            </Tabs.Tab>
            <Tabs.Tab className="ui-tab" value="dimensions">
              {t('dimensions')} <span className="tab-count">{props.data.dimensions.length}</span>
            </Tabs.Tab>
            <Tabs.Tab className="ui-tab" value="methods">
              {t('paymentMethods')}{' '}
              <span className="tab-count">{props.data.paymentMethods.length}</span>
            </Tabs.Tab>
            <Tabs.Tab className="ui-tab" value="terms">
              {t('paymentTerms')}{' '}
              <span className="tab-count">{props.data.paymentTerms.length}</span>
            </Tabs.Tab>
          </Tabs.List>
        </div>
        <Tabs.Panel className="ui-tab-panel" value="categories">
          <CategoriesPanel {...props} />
        </Tabs.Panel>
        <Tabs.Panel className="ui-tab-panel" value="dimensions">
          <DimensionsPanel {...props} />
        </Tabs.Panel>
        <Tabs.Panel className="ui-tab-panel" value="methods">
          <PaymentMethodsPanel {...props} />
        </Tabs.Panel>
        <Tabs.Panel className="ui-tab-panel" value="terms">
          <PaymentTermsPanel {...props} />
        </Tabs.Panel>
      </Tabs.Root>
    </section>
  )
}

function CategoriesPanel({ data, canManage, onChanged, setNotice }: PanelProps) {
  const t = useTranslations('classifications')
  const common = useTranslations('common')
  const natures = [
    { label: t('natureExpense'), value: 'expense' },
    { label: t('natureRevenue'), value: 'revenue' },
  ]
  const parents = [
    { label: t('noParent'), value: '' },
    ...data.categories
      .filter((category) => category.active && category.depth < 4)
      .map((category) => ({ label: `${category.code} · ${category.name}`, value: category.id })),
  ]
  return (
    <div className="panel table-panel">
      <header className="inventory-table-heading">
        <div>
          <h2>{t('categories')}</h2>
          <p className="inventory-table-copy">{t('categoriesCopy')}</p>
        </div>
        <CreateDialog
          build={(form) => {
            const parentId = String(form.get('parentId') ?? '')
            return {
              code: String(form.get('code') ?? ''),
              name: String(form.get('name') ?? ''),
              nature: String(form.get('nature') ?? 'expense'),
              ...(parentId ? { parentId } : {}),
            }
          }}
          canManage={canManage}
          description={t('newCategoryCopy')}
          onChanged={onChanged}
          registry="categories"
          setNotice={setNotice}
          title={t('newCategory')}
          trigger={t('newCategory')}
        >
          <div className="form-grid two-columns">
            <TextField label={t('code')} maxLength={20} name="code" placeholder="2.01" required />
            <SelectField label={t('nature')} name="nature" options={natures} required />
          </div>
          <TextField label={t('name')} maxLength={120} name="name" required />
          <SelectField label={t('parent')} name="parentId" options={parents} />
        </CreateDialog>
      </header>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('code')}</th>
              <th>{t('name')}</th>
              <th>{t('nature')}</th>
              <th aria-label={common('actions')} />
            </tr>
          </thead>
          <tbody>
            {data.categories.map((category) => (
              <tr key={category.id}>
                <td>
                  <code className="table-code">{category.code}</code>
                </td>
                <td style={{ paddingInlineStart: `${category.depth * 12}px` }}>{category.name}</td>
                <td>{category.nature === 'revenue' ? t('natureRevenue') : t('natureExpense')}</td>
                <td>
                  <StatusCell
                    active={category.active}
                    canManage={canManage}
                    id={category.id}
                    label={category.name}
                    onChanged={onChanged}
                    registry="categories"
                    setNotice={setNotice}
                  />
                </td>
              </tr>
            ))}
            {!data.categories.length ? <EmptyRow columns={4} copy={t('emptyCategories')} /> : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function DimensionsPanel({ data, canManage, onChanged, setNotice }: PanelProps) {
  const t = useTranslations('classifications')
  const common = useTranslations('common')
  const kinds = [
    { label: t('kindDepartment'), value: 'department' },
    { label: t('kindProject'), value: 'project' },
  ]
  return (
    <div className="panel table-panel">
      <header className="inventory-table-heading">
        <div>
          <h2>{t('dimensions')}</h2>
          <p className="inventory-table-copy">{t('dimensionsCopy')}</p>
        </div>
        <CreateDialog
          build={(form) => ({
            kind: String(form.get('kind') ?? 'department'),
            code: String(form.get('code') ?? ''),
            name: String(form.get('name') ?? ''),
          })}
          canManage={canManage}
          description={t('newDimensionCopy')}
          onChanged={onChanged}
          registry="dimensions"
          setNotice={setNotice}
          title={t('newDimension')}
          trigger={t('newDimension')}
        >
          <div className="form-grid two-columns">
            <SelectField label={t('kind')} name="kind" options={kinds} required />
            <TextField
              label={t('code')}
              maxLength={20}
              name="code"
              placeholder={t('dimensionCodeExample')}
              required
            />
          </div>
          <TextField label={t('name')} maxLength={120} name="name" required />
        </CreateDialog>
      </header>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('kind')}</th>
              <th>{t('code')}</th>
              <th>{t('name')}</th>
              <th aria-label={common('actions')} />
            </tr>
          </thead>
          <tbody>
            {data.dimensions.map((dimension) => (
              <tr key={dimension.id}>
                <td>{dimension.kind === 'project' ? t('kindProject') : t('kindDepartment')}</td>
                <td>
                  <code className="table-code">{dimension.code}</code>
                </td>
                <td>{dimension.name}</td>
                <td>
                  <StatusCell
                    active={dimension.active}
                    canManage={canManage}
                    id={dimension.id}
                    label={dimension.name}
                    onChanged={onChanged}
                    registry="dimensions"
                    setNotice={setNotice}
                  />
                </td>
              </tr>
            ))}
            {!data.dimensions.length ? <EmptyRow columns={4} copy={t('emptyDimensions')} /> : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PaymentMethodsPanel({ data, canManage, onChanged, setNotice }: PanelProps) {
  const t = useTranslations('classifications')
  const methodKind = useTranslations('paymentMethodKinds')
  const common = useTranslations('common')
  const kinds = PAYMENT_METHOD_KINDS.map((kind) => ({ label: methodKind(kind), value: kind }))
  return (
    <div className="panel table-panel">
      <header className="inventory-table-heading">
        <div>
          <h2>{t('paymentMethods')}</h2>
          <p className="inventory-table-copy">{t('paymentMethodsCopy')}</p>
        </div>
        <CreateDialog
          build={(form) => ({
            kind: String(form.get('kind') ?? 'pix'),
            code: String(form.get('code') ?? ''),
            name: String(form.get('name') ?? ''),
          })}
          canManage={canManage}
          description={t('newPaymentMethodCopy')}
          onChanged={onChanged}
          registry="payment-methods"
          setNotice={setNotice}
          title={t('newPaymentMethod')}
          trigger={t('newPaymentMethod')}
        >
          <div className="form-grid two-columns">
            <SelectField label={t('kind')} name="kind" options={kinds} required />
            <TextField
              label={t('code')}
              maxLength={20}
              name="code"
              placeholder={t('methodCodeExample')}
              required
            />
          </div>
          <TextField label={t('name')} maxLength={120} name="name" required />
        </CreateDialog>
      </header>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('code')}</th>
              <th>{t('name')}</th>
              <th>{t('kind')}</th>
              <th aria-label={common('actions')} />
            </tr>
          </thead>
          <tbody>
            {data.paymentMethods.map((method) => (
              <tr key={method.id}>
                <td>
                  <code className="table-code">{method.code}</code>
                </td>
                <td>{method.name}</td>
                <td>{methodKind(method.kind)}</td>
                <td>
                  <StatusCell
                    active={method.active}
                    canManage={canManage}
                    id={method.id}
                    label={method.name}
                    onChanged={onChanged}
                    registry="payment-methods"
                    setNotice={setNotice}
                  />
                </td>
              </tr>
            ))}
            {!data.paymentMethods.length ? (
              <EmptyRow columns={4} copy={t('emptyPaymentMethods')} />
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}
