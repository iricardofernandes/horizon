'use client'

import { useTranslations } from 'next-intl'
import { useMemo } from 'react'
import { useSession } from '@/components/shell/workspace-context'
import { PageHeading, PanelHeading } from '@/components/ui/headings'
import { Notice } from '@/components/ui/state'
import {
  consistencyAccessOf,
  delegationModulesOf,
  lendingModulesOf,
  readsThresholds,
  setsThresholds,
} from '@/lib/controls'
import { ConsistencyPanel } from './consistency-panel'
import { DelegationsPanel } from './delegations-panel'
import { ThresholdsPanel } from './thresholds-panel'

const RETENTION_CLASSES = ['records', 'events', 'bookkeeping', 'exports', 'attachments'] as const

/**
 * The internal controls in one place (Phase 70): who may approve for whom, above which amounts
 * a second person is needed, whether the books agree, and what is kept for how long. Each
 * panel shows only what the person's roles reach; every module still decides for itself.
 */
export function ControlsView() {
  const t = useTranslations('controls')
  const session = useSession()
  const roles = session?.roles
  const access = useMemo(() => {
    const held = roles ?? []
    return {
      delegations: delegationModulesOf(held),
      lending: lendingModulesOf(held),
      thresholds: readsThresholds(held),
      setsThresholds: setsThresholds(held),
      consistency: consistencyAccessOf(held),
    }
  }, [roles])
  const nothing =
    !access.delegations.length && !access.thresholds.length && !access.consistency.read

  return (
    <section className="controls-screen">
      <PageHeading copy={t('copy')} eyebrow={t('eyebrow')} title={t('title')} />
      {nothing ? <Notice copy={t('noneReachable')} /> : null}
      {access.delegations.length ? (
        <DelegationsPanel lending={access.lending} readable={access.delegations} />
      ) : null}
      {access.thresholds.length ? (
        <ThresholdsPanel readable={access.thresholds} settable={access.setsThresholds} />
      ) : null}
      {access.consistency.read ? <ConsistencyPanel canRun={access.consistency.run} /> : null}
      <section className="panel">
        <PanelHeading copy={t('retentionCopy')} title={t('retentionTitle')} />
        <dl className="retention-list">
          {RETENTION_CLASSES.map((entry) => (
            <div className="retention-item" key={entry}>
              <dt>{t(`retention.${entry}.what`)}</dt>
              <dd>{t(`retention.${entry}.rule`)}</dd>
            </div>
          ))}
        </dl>
      </section>
    </section>
  )
}
