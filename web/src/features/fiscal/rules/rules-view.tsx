'use client'

import { Dialog } from '@base-ui/react/dialog'
import { Tabs } from '@base-ui/react/tabs'
import { X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { useSession } from '@/components/shell/workspace-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading } from '@/components/ui/headings'
import { Empty, LoadingState, Notice } from '@/components/ui/state'
import { tracedFetch } from '@/lib/telemetry'
import { useDate, useDateTime } from '@/lib/use-format'
import { FISCAL_API } from '../types'
import { ChangeDialog, STATUS_TONE } from './change-dialog'
import { DiffView } from './diff-view'
import { RequestDialog, type RequestTarget } from './request-dialog'
import {
  type CatalogPackage,
  percentOf,
  type RuleAbilities,
  type RuleDiff,
  type RulesData,
  ruleAbilitiesOf,
} from './types'

const ADOPTION_TONE = { adopted: 'approved', withdrawn: 'rejected', never: 'draft' } as const

/**
 * Governing the tax rules (Phase 88): the requests waiting for a second person, the catalogue
 * and what the workspace adopted, its own rows, and the scenarios with evidence.
 */
export function RulesView({ data, reload }: { data: RulesData; reload: () => Promise<void> }) {
  const t = useTranslations('fiscal.rules')
  const session = useSession()
  const abilities = ruleAbilitiesOf(session?.roles ?? [])
  const [open, setOpen] = useState<string | null>(null)
  const [asking, setAsking] = useState<RequestTarget | null>(null)
  const [diffOf, setDiffOf] = useState<CatalogPackage | null>(null)
  const pending = data.changes.filter((change) => change.status === 'pending').length

  async function requested(changeId: string) {
    setAsking(null)
    await reload()
    setOpen(changeId)
  }

  return (
    <>
      <PageHeading copy={t('copy')} eyebrow={t('eyebrow')} title={t('title')} />
      <Tabs.Root defaultValue="changes">
        <Tabs.List aria-label={t('sections')} className="ui-tabs-list">
          <Tabs.Tab className="ui-tab" value="changes">
            {t('tabs.changes', { pending })}
          </Tabs.Tab>
          <Tabs.Tab className="ui-tab" value="catalog">
            {t('tabs.catalog')}
          </Tabs.Tab>
          <Tabs.Tab className="ui-tab" value="rules">
            {t('tabs.rules')}
          </Tabs.Tab>
          <Tabs.Tab className="ui-tab" value="matrix">
            {t('tabs.matrix')}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel className="fiscal-tab" value="changes">
          <ChangesPanel data={data} onOpen={setOpen} />
        </Tabs.Panel>
        <Tabs.Panel className="fiscal-tab" value="catalog">
          <CatalogPanel abilities={abilities} data={data} onAsk={setAsking} onDiff={setDiffOf} />
        </Tabs.Panel>
        <Tabs.Panel className="fiscal-tab" value="rules">
          <OwnRulesPanel abilities={abilities} data={data} onAsk={setAsking} />
        </Tabs.Panel>
        <Tabs.Panel className="fiscal-tab" value="matrix">
          <MatrixPanel data={data} />
        </Tabs.Panel>
      </Tabs.Root>
      {open ? (
        <ChangeDialog
          abilities={abilities}
          changeId={open}
          onChanged={reload}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {asking ? (
        <RequestDialog onClose={() => setAsking(null)} onRequested={requested} target={asking} />
      ) : null}
      {diffOf ? <PackageDiffDialog onClose={() => setDiffOf(null)} pack={diffOf} /> : null}
    </>
  )
}

function ChangesPanel({ data, onOpen }: { data: RulesData; onOpen: (id: string) => void }) {
  const t = useTranslations('fiscal.rules')
  const dateTime = useDateTime()
  if (data.changes.length === 0) return <Empty copy={t('noChanges')} />
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t('kind')}</th>
            <th>{t('status')}</th>
            <th>{t('requestedBy')}</th>
            <th>{t('diffTitle')}</th>
            <th>{t('impactTitle')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.changes.map((change) => (
            <tr key={change.id}>
              <td>{t(`kinds.${change.kind}`)}</td>
              <td>
                <Badge label={t(`statuses.${change.status}`)} status={STATUS_TONE[change.status]} />
              </td>
              <td>
                {change.requestedBy}
                <br />
                <small>{dateTime(change.requestedAt)}</small>
              </td>
              <td>{t('diffCounts', change.counts)}</td>
              <td>
                {t('impactShort', {
                  changed: change.changedDocuments,
                  unsupported: change.unsupportedDocuments,
                })}
              </td>
              <td>
                <Button onClick={() => onOpen(change.id)} variant="secondary">
                  {t('open')}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CatalogPanel({
  data,
  abilities,
  onAsk,
  onDiff,
}: {
  data: RulesData
  abilities: RuleAbilities
  onAsk: (target: RequestTarget) => void
  onDiff: (pack: CatalogPackage) => void
}) {
  const t = useTranslations('fiscal.rules')
  const date = useDate()
  if (data.packages.length === 0) return <Empty copy={t('noPackages')} />
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t('package')}</th>
            <th>{t('components')}</th>
            <th>{t('adoption')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.packages.map((pack) => {
            const label = `${pack.authority} · ${pack.packageDigest.slice(0, 12)}`
            return (
              <tr key={pack.id}>
                <td>
                  {pack.authority}
                  <br />
                  <small>
                    {t('packageFacts', {
                      published: date(pack.publishedAt),
                      rules: pack.ruleCount,
                      references: pack.referenceCount,
                    })}
                  </small>
                </td>
                <td>{pack.components.join(', ')}</td>
                <td>
                  <Badge
                    label={t(`adoptionStates.${pack.adoption.state}`)}
                    status={ADOPTION_TONE[pack.adoption.state]}
                  />
                  {pack.adoption.effectiveFrom ? (
                    <small> {t('since', { date: date(pack.adoption.effectiveFrom) })}</small>
                  ) : null}
                  {pack.pendingChangeId ? <small> · {t('pendingRequest')}</small> : null}
                </td>
                <td className="row-actions">
                  <Button onClick={() => onDiff(pack)} variant="secondary">
                    {t('viewDiff')}
                  </Button>
                  {abilities.canRequest && !pack.pendingChangeId ? (
                    <Button
                      onClick={() =>
                        onAsk({
                          kind:
                            pack.adoption.state === 'adopted'
                              ? 'withdraw-package'
                              : 'adopt-package',
                          packageId: pack.id,
                          label,
                        })
                      }
                      variant="secondary"
                    >
                      {pack.adoption.state === 'adopted'
                        ? t('requestWithdrawal')
                        : t('requestAdoption')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function OwnRulesPanel({
  data,
  abilities,
  onAsk,
}: {
  data: RulesData
  abilities: RuleAbilities
  onAsk: (target: RequestTarget) => void
}) {
  const t = useTranslations('fiscal.rules')
  const date = useDate()
  return (
    <>
      {abilities.canRequest ? (
        <Button onClick={() => onAsk({ kind: 'add-rule' })}>{t('requestRule')}</Button>
      ) : null}
      {data.rules.length === 0 ? (
        <Empty copy={t('noRules')} />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t('ruleKey')}</th>
                <th>{t('component')}</th>
                <th>{t('rate')}</th>
                <th>{t('scope')}</th>
                <th>{t('window')}</th>
                <th>{t('status')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.rules.map((rule) => (
                <tr key={rule.id}>
                  <td>
                    <code className="table-code">{rule.ruleKey}</code> v{rule.version}
                  </td>
                  <td>{rule.code}</td>
                  <td>{percentOf(rule.rate)}</td>
                  <td>
                    {rule.precedence}/{rule.priority}
                    <br />
                    <small>
                      {Object.entries(rule.scope)
                        .map(([key, value]) => `${key}=${value}`)
                        .join(', ')}
                    </small>
                  </td>
                  <td>
                    {date(rule.effectiveFrom)}
                    {rule.effectiveTo ? ` → ${date(rule.effectiveTo)}` : ''}
                  </td>
                  <td>
                    <Badge
                      label={rule.active ? t('active') : t('inactive')}
                      status={rule.active ? 'approved' : 'draft'}
                    />
                  </td>
                  <td>
                    {abilities.canRequest && rule.active ? (
                      <Button
                        onClick={() =>
                          onAsk({ kind: 'retire-rule', ruleId: rule.id, label: rule.ruleKey })
                        }
                        variant="secondary"
                      >
                        {t('requestRetirement')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function MatrixPanel({ data }: { data: RulesData }) {
  const t = useTranslations('fiscal.rules')
  if (data.matrix.length === 0) return <Empty copy={t('noMatrix')} />
  return (
    <>
      <p className="document-note">{t('matrixNote', { rows: data.matrix.length })}</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t('scenario')}</th>
              <th>{t('taxes')}</th>
              <th>{t('window')}</th>
              <th>{t('dimensions')}</th>
              <th>{t('evidence')}</th>
            </tr>
          </thead>
          <tbody>
            {data.matrix.map((row) => (
              <tr key={row.id}>
                <td>
                  <code className="table-code">{row.id}</code>
                  <br />
                  <small>
                    {row.model} · {row.environment}
                  </small>
                </td>
                <td>{row.taxes.join(', ')}</td>
                <td>
                  {row.from} → {row.until}
                </td>
                <td>
                  <small>
                    {Object.entries(row.dimensions)
                      .map(
                        ([key, value]) =>
                          `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
                      )
                      .join(', ')}
                  </small>
                </td>
                <td>{t(`evidenceKinds.${row.evidence.kind}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/** A package against the rules the workspace calculates with today. */
function PackageDiffDialog({ pack, onClose }: { pack: CatalogPackage; onClose: () => void }) {
  const t = useTranslations('fiscal.rules')
  const common = useTranslations('common')
  const [diff, setDiff] = useState<RuleDiff | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    void tracedFetch('fiscal.catalog.diff', `${FISCAL_API}/catalog/packages/${pack.id}/diff`, {
      cache: 'no-store',
    }).then(async (response) => {
      if (!response.ok) return setFailed(true)
      setDiff((await response.json()) as RuleDiff)
    })
  }, [pack.id])
  return (
    <Dialog.Root onOpenChange={(open) => (open ? undefined : onClose())} open>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup document-dialog">
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          <Dialog.Title>{t('packageDiffTitle', { authority: pack.authority })}</Dialog.Title>
          <p className="document-note">{t('packageDiffNote')}</p>
          {failed ? <Notice copy={t('diffUnavailable')} /> : null}
          {!failed && !diff ? <LoadingState /> : null}
          {diff ? <DiffView diff={diff} showUnchanged /> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
