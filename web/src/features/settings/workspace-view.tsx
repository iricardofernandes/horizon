'use client'

import { useTranslations } from 'next-intl'
import { PageHeading } from '@/components/ui/headings'

type SessionUser = { id: string; name: string; email: string }

export function WorkspaceView({
  user,
  workspaceName,
}: {
  user: SessionUser | null
  workspaceName: string
}) {
  const t = useTranslations('workspaceSettings')
  return (
    <section>
      <PageHeading eyebrow={t('eyebrow')} title={t('title')} copy={t('copy')} />
      <div className="settings-layout">
        <section className="panel workspace-settings-card">
          <header>
            <div className="brand-mark">{workspaceName.slice(0, 1).toUpperCase()}</div>
            <div>
              <h2>{workspaceName}</h2>
              <p className="settings-card-caption">{t('currentWorkspace')}</p>
            </div>
          </header>
          <dl>
            <div>
              <dt>{t('signedInAs')}</dt>
              <dd>{user?.name ?? t('none')}</dd>
            </div>
            <div>
              <dt>{t('account')}</dt>
              <dd>{user?.email ?? t('none')}</dd>
            </div>
          </dl>
          <a className="ui-button ui-button-secondary settings-link" href="/workspaces">
            {t('switchWorkspace')}
          </a>
        </section>
      </div>
    </section>
  )
}
