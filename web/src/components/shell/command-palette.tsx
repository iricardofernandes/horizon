'use client'

import { Dialog } from '@base-ui/react/dialog'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type KeyboardEvent, useEffect, useId, useMemo, useState } from 'react'
import { useSession } from '@/components/shell/workspace-context'
import type { SearchResult, SourceReport } from '@/lib/federation'
import {
  allowedActions,
  matches,
  nextIndex,
  type PaletteOption,
  paletteScreens,
} from '@/lib/palette'
import { tracedFetch } from '@/lib/telemetry'

const hostedDemo = process.env.NEXT_PUBLIC_HORIZON_HOSTED_DEMO === 'true'
const QUIET_MS = 250

type Found = { results: SearchResult[]; sources: SourceReport[] }

/** Asks the federated search once the person stops typing. */
function useSearch(query: string, enabled: boolean): Found | null {
  const [found, setFound] = useState<Found | null>(null)
  useEffect(() => {
    if (!enabled || query.trim().length < 2) {
      setFound(null)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const response = await tracedFetch(
          'search.federated',
          `/api/search?q=${encodeURIComponent(query.trim())}`,
          { signal: controller.signal },
        )
        if (response.ok) setFound((await response.json()) as Found)
      } catch {
        // A cancelled or failed search leaves the screens and actions offered.
      }
    }, QUIET_MS)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query, enabled])
  return found
}

/**
 * Ctrl/⌘ K (Phase 66): the screens and actions the roles allow, and search results from
 * every module the person can read. A combobox over a listbox: arrows move, Enter opens,
 * Esc closes and gives focus back.
 */
export function CommandPalette() {
  const t = useTranslations('palette')
  const navigation = useTranslations('navigation')
  const router = useRouter()
  const session = useSession()
  const roles = session?.roles ?? []
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  const listId = useId()
  const found = useSearch(query, open)

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const options = useMemo<PaletteOption[]>(() => {
    const screens = paletteScreens(roles, hostedDemo)
      .map((entry) => ({
        group: 'screens' as const,
        key: `screen:${entry.href}`,
        label: navigation(`items.${entry.labelKey}`),
        href: entry.href,
        entry,
      }))
      .filter((option) => matches(option.label, query))
    const actions = allowedActions(roles)
      .map((action) => ({
        group: 'actions' as const,
        key: `action:${action.id}`,
        label: t(`actions.${action.labelKey}`),
        href: action.href,
      }))
      .filter((option) => matches(option.label, query))
    const results = (found?.results ?? []).map((result) => ({
      group: 'results' as const,
      key: `result:${result.source}:${result.id}`,
      label: result.title,
      detail: result.subtitle,
      href: result.href,
    }))
    return [...screens.slice(0, 8), ...actions, ...results]
  }, [roles, query, found, navigation, t])

  useEffect(() => {
    setActive(options.length > 0 ? 0 : -1)
  }, [options.length])

  function go(option: PaletteOption | undefined) {
    if (!option) return
    setOpen(false)
    setQuery('')
    router.push(option.href)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      setActive((current) =>
        nextIndex(current, options.length, event.key as 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'),
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      go(options[active])
    }
  }

  const silent = (found?.sources ?? []).filter((source) => source.status !== 'ok')
  const optionId = (index: number) => `${listId}-option-${index}`

  return (
    <Dialog.Root onOpenChange={setOpen} open={open}>
      <Dialog.Trigger aria-label={t('open')} className="ui-button ui-button-ghost palette-trigger">
        <MagnifyingGlass aria-hidden="true" size={16} />
        <span>{t('open')}</span>
        <kbd>{t('shortcut')}</kbd>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog-backdrop" />
        <Dialog.Popup className="ui-dialog-popup palette-popup">
          <Dialog.Title className="sr-only">{t('title')}</Dialog.Title>
          <input
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded={options.length > 0}
            aria-label={t('input')}
            autoComplete="off"
            className="ui-input palette-input"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('placeholder')}
            role="combobox"
            value={query}
          />
          <div aria-label={t('title')} className="palette-list" id={listId} role="listbox">
            {options.map((option, index) => (
              <div
                aria-selected={index === active}
                className={index === active ? 'palette-option active' : 'palette-option'}
                id={optionId(index)}
                key={option.key}
                onClick={() => go(option)}
                onKeyDown={() => undefined}
                onMouseEnter={() => setActive(index)}
                role="option"
                tabIndex={-1}
              >
                <span className="palette-group">{t(`groups.${option.group}`)}</span>
                <span>{option.label}</span>
                {option.group === 'results' && option.detail ? (
                  <small>{option.detail}</small>
                ) : null}
              </div>
            ))}
          </div>
          {options.length === 0 ? <p className="muted">{t('empty')}</p> : null}
          {silent.length > 0 ? (
            <p className="muted" role="status">
              {t('silent', { modules: silent.map((source) => source.module).join(', ') })}
            </p>
          ) : null}
          <p className="muted palette-hint">{t('hint')}</p>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
