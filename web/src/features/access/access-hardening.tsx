'use client'

import { Dialog } from '@base-ui/react/dialog'
import { DeviceMobile, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PanelHeading } from '@/components/ui/headings'
import { Empty } from '@/components/ui/state'
import type { InvitationView, SessionView } from '@/lib/access'
import { apiError } from '@/lib/api'
import { tracedFetch } from '@/lib/telemetry'
import { useDateTime } from '@/lib/use-format'
import type { StepUpProps, WorkspaceUser } from './access-view'

const IDENTITY = '/api/horizon/identity'

/** Pending and past invitations (Phase 67): resend a link, or revoke one not yet used. */
export function InvitationsPanel({ setNotice }: { setNotice: (value: string) => void }) {
  const t = useTranslations('access.invitations')
  const statusLabel = useTranslations('access.invitationStatus')
  const dateTime = useDateTime()
  const [invitations, setInvitations] = useState<InvitationView[] | null>(null)

  const load = useCallback(async () => {
    const response = await tracedFetch('identity.invitations', `${IDENTITY}/invitations`)
    if (response.ok) setInvitations(((await response.json()) as { data: InvitationView[] }).data)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function act(invitation: InvitationView, action: 'resend' | 'revoke') {
    const response = await tracedFetch(
      `identity.invitation.${action}`,
      `${IDENTITY}/invitations/${invitation.id}/${action}`,
      {
        method: 'POST',
      },
    )
    setNotice(
      response.ok
        ? t(action === 'resend' ? 'resent' : 'revoked')
        : await apiError(response, t('failed')),
    )
    await load()
  }

  return (
    <section className="panel table-panel table-scroll">
      <PanelHeading copy={t('copy')} title={t('title')} />
      {!invitations || invitations.length === 0 ? (
        <Empty copy={t('empty')} />
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('person')}</th>
              <th>{t('status')}</th>
              <th>{t('expires')}</th>
              <th aria-label={t('actions')} />
            </tr>
          </thead>
          <tbody>
            {invitations.map((invitation) => (
              <tr key={invitation.id}>
                <td>
                  <strong>{invitation.name}</strong>
                  <small> {invitation.email}</small>
                </td>
                <td>
                  <Badge label={statusLabel(invitation.status)} status={invitation.status} />
                </td>
                <td>{dateTime(invitation.expiresAt)}</td>
                <td>
                  {invitation.status === 'pending' || invitation.status === 'expired' ? (
                    <div className="row-actions">
                      <Button
                        onClick={() => void act(invitation, 'resend')}
                        type="button"
                        variant="ghost"
                      >
                        {t('resend')}
                      </Button>
                      {invitation.status === 'pending' ? (
                        <Button
                          onClick={() => void act(invitation, 'revoke')}
                          type="button"
                          variant="ghost"
                        >
                          {t('revoke')}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** A user's sessions, which an administrator can end all at once (with step-up). */
export function UserSessionsDialog({
  user,
  run,
  setNotice,
}: StepUpProps & { user: WorkspaceUser; setNotice: (value: string) => void }) {
  const t = useTranslations('access.sessions')
  const common = useTranslations('common')
  const dateTime = useDateTime()
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionView[] | null>(null)

  const load = useCallback(async () => {
    const response = await tracedFetch(
      'identity.user.sessions',
      `${IDENTITY}/users/${user.id}/sessions`,
    )
    if (response.ok) setSessions(((await response.json()) as { data: SessionView[] }).data)
  }, [user.id])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  async function endAll() {
    const response = await run(() =>
      tracedFetch('identity.user.sessions.end', `${IDENTITY}/users/${user.id}/sessions`, {
        method: 'DELETE',
      }),
    )
    setNotice(response.ok ? t('ended', { name: user.name }) : await apiError(response, t('failed')))
    await load()
  }

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger className="ui-button ui-button-ghost row-action-button">
        <DeviceMobile aria-hidden="true" size={16} />
        {t('open')}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup">
          <div className="dialog-heading">
            <Dialog.Title>{t('title', { name: user.name })}</Dialog.Title>
            <Dialog.Description className="dialog-description">{t('copy')}</Dialog.Description>
          </div>
          <Dialog.Close aria-label={common('closeDialog')} className="ui-dialog-close">
            <X aria-hidden="true" size={18} />
          </Dialog.Close>
          {!sessions || sessions.length === 0 ? (
            <Empty copy={t('empty')} />
          ) : (
            <ul className="security-list">
              {sessions.map((session) => (
                <li key={session.id}>
                  <strong>{session.device}</strong>
                  <small>
                    {t('meta', {
                      network: session.ipPrefix ?? '—',
                      last: dateTime(session.lastUsedAt),
                    })}
                  </small>
                </li>
              ))}
            </ul>
          )}
          {sessions && sessions.length > 0 ? (
            <div className="dialog-actions">
              <Button onClick={() => void endAll()} type="button" variant="danger">
                {t('endAll')}
              </Button>
            </div>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
