import { describe, expect, it } from 'vitest'
import {
  type AssistantSource,
  type AssistantStatus,
  budgetPercent,
  readinessOf,
  refusalOf,
  sourcesBeside,
  turnOf,
} from './assistant'

const status = (overrides: Partial<AssistantStatus> = {}): AssistantStatus => ({
  enabled: true,
  available: true,
  provider: 'Anthropic',
  model: 'claude-opus-5-5',
  notice: { version: 'assistant-notice-v1', accepted: true, acceptedBy: 'u', acceptedAt: null },
  budget: { month: '2026-09-01', monthlyTokens: 1000, spentTokens: 250, questions: 2 },
  ...overrides,
})

describe('the assistant screen (Phase 76)', () => {
  it('says why a question cannot be asked before sending anything', () => {
    expect(readinessOf(status())).toBe('ready')
    expect(readinessOf(status({ enabled: false, available: false }))).toBe('off')
    expect(readinessOf(status({ available: false }))).toBe('unavailable')
    expect(
      readinessOf(
        status({ budget: { month: 'm', monthlyTokens: 10, spentTokens: 10, questions: 1 } }),
      ),
    ).toBe('budget-spent')
  })

  it('shows the share of the budget spent, capped', () => {
    expect(budgetPercent(status())).toBe(25)
    expect(
      budgetPercent(
        status({ budget: { month: 'm', monthlyTokens: 10, spentTokens: 30, questions: 1 } }),
      ),
    ).toBe(100)
  })

  it('maps the agent’s refusals to what the screen says', () => {
    expect(refusalOf('assistant-off')).toBe('off')
    expect(refusalOf('assistant-unavailable')).toBe('unavailable')
    expect(refusalOf('assistant-budget-spent')).toBe('budget-spent')
    expect(refusalOf(undefined)).toBe('failed')
  })

  it('shows cited sources first, and keeps a fresh answer as a turn', () => {
    const record = (id: string, cited: boolean): AssistantSource => ({
      id,
      kind: 'record',
      tool: 'list_parties',
      module: 'parties',
      screen: '/app/registrations/parties',
      rows: 1,
      cited,
    })
    expect(
      sourcesBeside([record('S1', false), record('S2', true)]).map((source) => source.id),
    ).toEqual(['S2', 'S1'])
    expect(
      turnOf(
        'Quem?',
        { conversationId: 'c', turn: 0, outcome: 'answered', statements: [], sources: [] },
        new Date('2026-09-29T12:00:00Z'),
      ),
    ).toEqual({
      question: 'Quem?',
      outcome: 'answered',
      statements: [],
      sources: [],
      askedAt: '2026-09-29T12:00:00.000Z',
    })
  })
})
