import { metrics } from '@opentelemetry/api'
import type { AssistantMetrics } from '@/application/assistant-ports'
import type { GenerationUsage } from '@/application/generation'
import type { CallMetrics, CallRecord } from '@/application/ports'

const meter = metrics.getMeter('agent')

/** Calls per tool and outcome, and how long an exchange takes (ADR 0065). No tenant label. */
export class OtelCallMetrics implements CallMetrics {
  readonly #calls = meter.createCounter('agent_tool_calls', {
    description: 'Tool calls by the tenant agents, by tool and outcome',
  })
  readonly #exchange = meter.createHistogram('agent_exchange_seconds', {
    description: 'Time to exchange an API key for a token through the gateway',
    unit: 's',
  })

  called(record: CallRecord): void {
    this.#calls.add(1, { tool: record.tool, outcome: record.outcome })
  }

  exchanged(seconds: number): void {
    this.#exchange.record(seconds)
  }
}

/** The assistant's questions, tokens and answer time (Phase 76). No tenant label. */
export class OtelAssistantMetrics implements AssistantMetrics {
  readonly #questions = meter.createCounter('assistant_questions', {
    description: 'Questions the assistant finished, by outcome',
  })
  readonly #tokens = meter.createCounter('assistant_tokens', {
    description: 'Tokens sent to and received from the model provider',
  })
  readonly #seconds = meter.createHistogram('assistant_answer_seconds', {
    description: 'Time to answer one question',
    unit: 's',
  })

  answered(outcome: string, seconds: number): void {
    this.#questions.add(1, { outcome })
    this.#seconds.record(seconds)
  }

  tokens(usage: GenerationUsage): void {
    this.#tokens.add(usage.inputTokens, { kind: 'input' })
    this.#tokens.add(usage.outputTokens, { kind: 'output' })
  }
}
