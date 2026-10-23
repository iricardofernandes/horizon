'use client'

import { ArrowRight } from '@phosphor-icons/react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { LanguageSwitcher } from '@/components/shell/language-switcher'
import { useSession } from '@/components/shell/workspace-context'
import { PageHeading, PanelHeading } from '@/components/ui/headings'

/**
 * The signed-in person's own settings: who they are on this account, the language they
 * read in (ADR 0044) and the way to their security.
 */
export function ProfileView() {
  const t = useTranslations('profile')
  const session = useSession()
  return (
    <section className="profile-view">
      <PageHeading copy={t('copy')} eyebrow={t('eyebrow')} title={t('title')} />
      <section className="panel">
        <PanelHeading copy={t('identityCopy')} title={t('identityTitle')} />
        <dl className="profile-facts">
          <div className="profile-fact">
            <dt>{t('name')}</dt>
            <dd>{session?.name ?? ''}</dd>
          </div>
          <div className="profile-fact">
            <dt>{t('email')}</dt>
            <dd>{session?.email ?? ''}</dd>
          </div>
        </dl>
      </section>
      <section className="panel">
        <PanelHeading copy={t('languageCopy')} title={t('languageTitle')} />
        <LanguageSwitcher />
      </section>
      <section className="panel">
        <PanelHeading copy={t('securityCopy')} title={t('securityTitle')} />
        <Link className="ui-button ui-button-secondary" href="/app/settings/security">
          {t('securityLink')}
          <ArrowRight aria-hidden="true" size={16} />
        </Link>
      </section>
    </section>
  )
}
