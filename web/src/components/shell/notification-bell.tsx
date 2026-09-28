'use client'

import { Popover } from '@base-ui/react/popover'
import { Bell } from '@phosphor-icons/react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { type NotificationItem, paramsOf } from '@/lib/notifications'
import { tracedFetch } from '@/lib/telemetry'

const BASE = '/api/horizon/reporting/notifications'
const POLL_MS = 30_000

/**
 * The bell (Phase 66): what needs the person, from any module, told once. It counts what is
 * unread, lists the latest, opens each one's record and marks it read. A button that opens a
 * popover, so it works from the keyboard like any other.
 */
export function NotificationBell() {
  const t = useTranslations('notifications')
  const format = useFormatter()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [items, setItems] = useState<NotificationItem[] | null>(null)
  const [failed, setFailed] = useState(false)

  const count = useCallback(async () => {
    try {
      const response = await tracedFetch('notifications.unread', `${BASE}/unread-count`)
      if (response.ok) setUnread(((await response.json()) as { unread: number }).unread)
    } catch {
      // The count waits for the next poll.
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const response = await tracedFetch('notifications.list', `${BASE}?limit=20`)
      if (!response.ok) throw new Error('unavailable')
      setItems(((await response.json()) as { data: NotificationItem[] }).data)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void count()
    const timer = setInterval(() => void count(), POLL_MS)
    return () => clearInterval(timer)
  }, [count])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  async function markRead(item: NotificationItem) {
    if (!item.read)
      await tracedFetch('notifications.read', `${BASE}/${item.id}/read`, { method: 'POST' })
    await count()
  }

  async function openItem(item: NotificationItem) {
    await markRead(item)
    setOpen(false)
    if (item.link) router.push(item.link)
  }

  async function readAll() {
    await tracedFetch('notifications.read-all', `${BASE}/read-all`, { method: 'POST' })
    await Promise.all([count(), load()])
  }

  const label = unread > 0 ? t('bellUnread', { count: unread }) : t('bell')

  return (
    <Popover.Root onOpenChange={setOpen} open={open}>
      <Popover.Trigger
        aria-label={label}
        className="ui-button ui-button-ghost bell-trigger"
        title={label}
      >
        <Bell aria-hidden="true" size={18} />
        {unread > 0 ? (
          <span aria-hidden="true" className="bell-count">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={8}>
          <Popover.Popup className="bell-popup">
            <div className="bell-heading">
              <Popover.Title>{t('title')}</Popover.Title>
              {unread > 0 ? (
                <Button onClick={() => void readAll()} type="button" variant="ghost">
                  {t('readAll')}
                </Button>
              ) : null}
            </div>
            {failed ? <p role="alert">{t('failed')}</p> : null}
            {items && items.length === 0 ? <p className="muted">{t('empty')}</p> : null}
            <ul className="bell-list">
              {(items ?? []).map((item) => (
                <li className={item.read ? 'bell-item' : 'bell-item unread'} key={item.id}>
                  <button
                    className="bell-item-button"
                    onClick={() => void openItem(item)}
                    type="button"
                  >
                    <span>{t(`kinds.${item.kind}`, paramsOf(item))}</span>
                    <small>
                      {format.dateTime(new Date(item.createdAt), {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                      {item.read ? '' : ` · ${t('unread')}`}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
