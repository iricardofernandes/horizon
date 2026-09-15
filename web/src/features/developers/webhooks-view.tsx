'use client'

import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Trash } from '@phosphor-icons/react'
import { type FormEvent, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeading, PanelHeading } from '@/components/ui/headings'
import { Empty } from '@/components/ui/state'
import { TextField } from '@/components/ui/text-field'
import { jsonHeaders } from '@/lib/http'
import { tracedFetch } from '@/lib/telemetry'

export type Subscription = {
  id: string
  endpointUrl: string
  eventTypes: string[]
  active: boolean
  createdAt?: string
}

export function WebhooksView({
  subscriptions,
  onChanged,
  setNotice,
}: {
  subscriptions: Subscription[]
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    const data = new FormData(event.currentTarget)
    const response = await tracedFetch(
      'webhook.create',
      '/api/horizon/webhooks/webhook-subscriptions',
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          endpointUrl: data.get('endpointUrl'),
          eventTypes: String(data.get('eventTypes') ?? '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      },
    )
    if (!response.ok) {
      setNotice('The endpoint could not be registered. Use HTTPS outside local development.')
      setBusy(false)
      return
    }
    const created = await response.json()
    setSecret(created.secret)
    setNotice('Endpoint registered. Copy the signing secret now; it will not be shown again.')
    await onChanged()
    setBusy(false)
  }

  return (
    <section>
      <PageHeading
        eyebrow="Developer operations"
        title="Webhooks"
        copy="Deliver order events to the systems that depend on them."
      />
      <div className="split-grid">
        <form className="panel form-panel" onSubmit={submit}>
          <PanelHeading title="Add endpoint" copy="Select one or more event types" />
          <TextField
            label="Endpoint URL"
            name="endpointUrl"
            placeholder="https://example.com/horizon"
            required
            type="url"
          />
          <TextField
            defaultValue="sales.order.confirmed"
            description="Separate multiple event types with commas."
            label="Event types"
            name="eventTypes"
            required
          />
          <Button disabled={busy} type="submit" variant="primary">
            {busy ? 'Creating…' : 'Create subscription'}
          </Button>
          {secret ? (
            <div className="secret-box">
              <small>Signing secret · shown once</small>
              <code>{secret}</code>
            </div>
          ) : null}
        </form>
        <section className="panel">
          <PanelHeading
            title="Subscriptions"
            copy={`${subscriptions.filter((row) => row.active).length} active`}
          />
          <div className="stack-list">
            {subscriptions.length ? (
              subscriptions.map((row) => (
                <div className="stack-row" key={row.id}>
                  <div className="stack-copy">
                    <strong>{row.endpointUrl}</strong>
                    <small>{row.eventTypes.join(', ')}</small>
                  </div>
                  <div className="row-actions">
                    <Badge status={row.active ? 'active' : 'inactive'} />
                    {row.active ? (
                      <DeleteSubscriptionDialog
                        subscription={row}
                        onChanged={onChanged}
                        setNotice={setNotice}
                      />
                    ) : null}
                  </div>
                </div>
              ))
            ) : (
              <Empty copy="No endpoints registered yet." />
            )}
          </div>
        </section>
      </div>
    </section>
  )
}

function DeleteSubscriptionDialog({
  subscription,
  onChanged,
  setNotice,
}: {
  subscription: Subscription
  onChanged: () => Promise<void>
  setNotice: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function remove() {
    setBusy(true)
    setError('')
    const response = await tracedFetch(
      'webhook.subscription.delete',
      `/api/horizon/webhooks/webhook-subscriptions/${subscription.id}`,
      { method: 'DELETE' },
    )
    if (!response.ok) {
      setError('The subscription could not be deactivated.')
      setBusy(false)
      return
    }
    setNotice('Webhook subscription deactivated.')
    await onChanged()
    setOpen(false)
    setBusy(false)
  }
  return (
    <AlertDialog.Root onOpenChange={setOpen} open={open}>
      <AlertDialog.Trigger
        aria-label={`Deactivate ${subscription.endpointUrl}`}
        className="ui-button ui-button-ghost icon-action danger-action"
      >
        <Trash aria-hidden="true" size={15} />
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="ui-dialog-backdrop" />
        <AlertDialog.Popup className="ui-dialog-popup ui-alert-popup">
          <div className="dialog-heading">
            <AlertDialog.Title>Deactivate this endpoint?</AlertDialog.Title>
            <AlertDialog.Description className="dialog-description">
              New matching events will no longer be delivered to {subscription.endpointUrl}.
            </AlertDialog.Description>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <AlertDialog.Close className="ui-button ui-button-secondary">Cancel</AlertDialog.Close>
            <Button disabled={busy} onClick={remove} type="button" variant="danger">
              {busy ? 'Deactivating…' : 'Deactivate endpoint'}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
