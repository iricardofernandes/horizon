'use client'

import { Tabs } from '@base-ui/react/tabs'
import { useTranslations } from 'next-intl'
import { type FormEvent, useState } from 'react'
import { useNotice } from '@/components/shell/workspace-context'
import { Button } from '@/components/ui/button'
import { SelectField } from '@/components/ui/select-field'
import { TextField } from '@/components/ui/text-field'
import { type CrmDirectory, newKey, send } from './crm-data'
import { type Contact, instantFromLocal, localInputOf, personLabel, type Subject } from './types'

const ACTIVITY_KINDS = ['call', 'meeting', 'email', 'visit'] as const

/**
 * Record what happened, plan what comes next, or write down what was said (Phase 57), on
 * an account, a contact or an opportunity. Each form clears itself once CRM accepted it.
 */
export function RecordForms({
  subject,
  contacts,
  directory,
  userId,
  canAssign,
  onRecorded,
}: {
  subject: Subject
  contacts: readonly Contact[]
  directory: CrmDirectory
  userId: string | null
  canAssign: boolean
  onRecorded: () => Promise<void>
}) {
  const t = useTranslations('crm')
  return (
    <Tabs.Root defaultValue="activity">
      <Tabs.List aria-label={t('records.sections')} className="ui-tabs-list">
        <Tabs.Tab className="ui-tab" value="activity">
          {t('records.activity')}
        </Tabs.Tab>
        <Tabs.Tab className="ui-tab" value="task">
          {t('records.task')}
        </Tabs.Tab>
        <Tabs.Tab className="ui-tab" value="note">
          {t('records.note')}
        </Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel className="crm-record-panel" value="activity">
        <ActivityForm contacts={contacts} onRecorded={onRecorded} subject={subject} />
      </Tabs.Panel>
      <Tabs.Panel className="crm-record-panel" value="task">
        <TaskForm
          canAssign={canAssign}
          directory={directory}
          onRecorded={onRecorded}
          subject={subject}
          userId={userId}
        />
      </Tabs.Panel>
      <Tabs.Panel className="crm-record-panel" value="note">
        <NoteForm onRecorded={onRecorded} subject={subject} />
      </Tabs.Panel>
    </Tabs.Root>
  )
}

/** Shared submit plumbing: busy state, the API's refusal, and a notice on success. */
function useSubmit(onRecorded: () => Promise<void>) {
  const setNotice = useNotice()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [round, setRound] = useState(0)
  async function run(action: () => ReturnType<typeof send>, done: string) {
    setBusy(true)
    setError('')
    const result = await action()
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setNotice(done)
    setRound((value) => value + 1)
    await onRecorded()
  }
  return { busy, error, round, run }
}

function FormError({ error }: { error: string }) {
  return error ? (
    <p className="form-error" role="alert">
      {error}
    </p>
  ) : null
}

function ActivityForm({
  subject,
  contacts,
  onRecorded,
}: {
  subject: Subject
  contacts: readonly Contact[]
  onRecorded: () => Promise<void>
}) {
  const t = useTranslations('crm')
  const { busy, error, round, run } = useSubmit(onRecorded)
  const live = contacts.filter((contact) => contact.status !== 'erased')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const occurredAt = instantFromLocal(String(form.get('occurredAt') ?? ''))
    await run(
      () =>
        send('crm.activity.record', 'POST', '/activities', {
          key: newKey(),
          fallback: t('records.failed'),
          body: {
            subject,
            kind: form.get('kind'),
            occurredAt,
            title: form.get('title'),
            summary: String(form.get('summary') ?? '') || null,
            contactIds: form.getAll('contactIds').map(String),
          },
        }),
      t('records.activityRecorded'),
    )
  }

  return (
    <form className="dialog-form" key={round} onSubmit={submit}>
      <div className="crm-form-row">
        <SelectField
          label={t('records.kind')}
          name="kind"
          options={ACTIVITY_KINDS.map((kind) => ({
            label: t(`activityKind.${kind}`),
            value: kind,
          }))}
        />
        <TextField
          defaultValue={localInputOf(new Date())}
          label={t('records.occurredAt')}
          name="occurredAt"
          required
          type="datetime-local"
        />
      </div>
      <TextField label={t('records.title')} maxLength={160} minLength={2} name="title" required />
      <label className="ui-field">
        <span className="ui-field-label">{t('records.summary')}</span>
        <textarea className="ui-input crm-textarea" maxLength={4000} name="summary" rows={3} />
      </label>
      {live.length ? (
        <fieldset className="crm-checks">
          <legend className="ui-field-label">{t('records.participants')}</legend>
          {live.map((contact) => (
            <label key={contact.id}>
              <input name="contactIds" type="checkbox" value={contact.id} /> {contact.name}
            </label>
          ))}
        </fieldset>
      ) : null}
      <FormError error={error} />
      <div className="dialog-actions">
        <Button disabled={busy} type="submit" variant="primary">
          {t('records.recordActivity')}
        </Button>
      </div>
    </form>
  )
}

function TaskForm({
  subject,
  directory,
  userId,
  canAssign,
  onRecorded,
}: {
  subject: Subject
  directory: CrmDirectory
  userId: string | null
  canAssign: boolean
  onRecorded: () => Promise<void>
}) {
  const t = useTranslations('crm')
  const { busy, error, round, run } = useSubmit(onRecorded)
  const tomorrow = new Date(Date.now() + 86_400_000)
  // Without `assign`, a person may give a task only to themselves.
  const assignees = directory.owners
    .filter((owner) => owner.active && (canAssign || owner.userId === userId))
    .map((owner) => ({
      label: personLabel(directory.names, owner.userId, t('noOwner')),
      value: owner.userId,
    }))

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    await run(
      () =>
        send('crm.task.create', 'POST', '/tasks', {
          key: newKey(),
          fallback: t('records.failed'),
          body: {
            subject,
            assigneeId: form.get('assigneeId'),
            title: form.get('title'),
            dueAt: instantFromLocal(String(form.get('dueAt') ?? '')),
            remindAt: instantFromLocal(String(form.get('remindAt') ?? '')),
          },
        }),
      t('records.taskCreated'),
    )
  }

  return (
    <form className="dialog-form" key={round} onSubmit={submit}>
      <TextField label={t('records.title')} maxLength={160} minLength={2} name="title" required />
      <div className="crm-form-row">
        <TextField
          defaultValue={localInputOf(tomorrow)}
          label={t('records.dueAt')}
          name="dueAt"
          required
          type="datetime-local"
        />
        <TextField label={t('records.remindAt')} name="remindAt" type="datetime-local" />
      </div>
      <SelectField
        defaultValue={userId && assignees.some((row) => row.value === userId) ? userId : null}
        label={t('records.assignee')}
        name="assigneeId"
        options={assignees}
        required
      />
      <FormError error={error} />
      <div className="dialog-actions">
        <Button disabled={busy || assignees.length === 0} type="submit" variant="primary">
          {t('records.createTask')}
        </Button>
      </div>
    </form>
  )
}

function NoteForm({ subject, onRecorded }: { subject: Subject; onRecorded: () => Promise<void> }) {
  const t = useTranslations('crm')
  const { busy, error, round, run } = useSubmit(onRecorded)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    await run(
      () =>
        send('crm.note.write', 'POST', '/notes', {
          key: newKey(),
          fallback: t('records.failed'),
          body: { subject, body: form.get('body') },
        }),
      t('records.noteWritten'),
    )
  }

  return (
    <form className="dialog-form" key={round} onSubmit={submit}>
      <label className="ui-field">
        <span className="ui-field-label">{t('records.noteBody')}</span>
        <textarea
          className="ui-input crm-textarea"
          maxLength={10000}
          name="body"
          required
          rows={4}
        />
      </label>
      <FormError error={error} />
      <div className="dialog-actions">
        <Button disabled={busy} type="submit" variant="primary">
          {t('records.writeNote')}
        </Button>
      </div>
    </form>
  )
}
