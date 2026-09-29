'use client'

import { Check, Lightbulb, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
import { jsonHeaders } from '@/lib/http'
import {
  type Suggestion,
  type SuggestionAnswer,
  type SuggestionKind,
  shownSuggestions,
  suggestionPath,
} from '@/lib/suggestions'
import { tracedFetch } from '@/lib/telemetry'

const QUIET_MS = 400

/**
 * Asks for suggestions once the person stops typing. A failure or an answer with
 * suggestions off leaves the form as it is: nothing is shown, and nothing blocks saving.
 */
export function useSuggestions(
  kind: SuggestionKind,
  text: string,
  partyId?: string,
): SuggestionAnswer | null {
  const [answer, setAnswer] = useState<SuggestionAnswer | null>(null)
  useEffect(() => {
    const path = suggestionPath(kind, text, partyId)
    if (!path) {
      setAnswer(null)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const response = await tracedFetch(`knowledge.suggest.${kind}`, path, {
          signal: controller.signal,
          cache: 'no-store',
        })
        setAnswer(response.ok ? ((await response.json()) as SuggestionAnswer) : null)
      } catch {
        // A cancelled or failed ask shows no suggestion.
      }
    }, QUIET_MS)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [kind, text, partyId])
  return answer
}

/** Counted by `knowledge` as a metric, and nothing more: never a training set. */
function decide(kind: SuggestionKind, decision: 'accepted' | 'rejected', rank: number) {
  void tracedFetch('knowledge.suggest.decision', '/api/horizon/knowledge/suggestions/decisions', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ kind, decision, rank }),
  }).catch(() => undefined)
}

/**
 * The suggestions for one field, each with its reason: the workspace's own records it came
 * from, or the official table. Accepting fills the field; the person still saves the form.
 */
export function SuggestionChips({
  kind,
  answer,
  current,
  labelOf,
  onAccept,
}: {
  kind: SuggestionKind
  answer: SuggestionAnswer | null
  current: string | null
  /** The value as the field shows it, or null when the form does not know it. */
  labelOf: (suggestion: Suggestion) => string | null
  onAccept: (value: string) => void
}) {
  const t = useTranslations('suggestions')
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const shown = shownSuggestions(answer, {
    known: (value) => labelOf({ value } as Suggestion) !== null,
    current,
    dismissed,
  })
  if (!shown.length) return null
  return (
    <ul aria-label={t('title')} className="suggestion-chips">
      {shown.map((suggestion, index) => {
        const rank = index + 1
        const examples = suggestion.reason.examples
        return (
          <li key={suggestion.value}>
            <Lightbulb aria-hidden="true" size={15} />
            <span className="suggestion-text">
              <strong>{labelOf(suggestion)}</strong>
              <small>
                {examples.length
                  ? t('fromExamples', {
                      count: examples.length,
                      examples: examples.map((example) => example.reference).join('; '),
                    })
                  : t('fromTable')}
              </small>
            </span>
            <button
              aria-label={t('accept', { value: labelOf(suggestion) ?? suggestion.value })}
              className="ui-button ui-button-ghost"
              onClick={() => {
                decide(kind, 'accepted', rank)
                onAccept(suggestion.value)
              }}
              type="button"
            >
              <Check aria-hidden="true" size={14} /> {t('use')}
            </button>
            <button
              aria-label={t('reject', { value: labelOf(suggestion) ?? suggestion.value })}
              className="ui-button ui-button-ghost"
              onClick={() => {
                decide(kind, 'rejected', rank)
                setDismissed((current) => new Set([...current, suggestion.value]))
              }}
              type="button"
            >
              <X aria-hidden="true" size={14} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
