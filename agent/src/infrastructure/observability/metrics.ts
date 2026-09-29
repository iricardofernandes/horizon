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
    // Seconds, not OpenTelemetry's default millisecond bounds (Phase 78).
    advice: {
      explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
    },
  })

  readonly #callSeconds = meter.createHistogram('agent_tool_call_seconds', {
    description: 'Time from a tools/call to its audited answer, by outcome (Phase 78)',
    unit: 's',
    advice: {
      explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
    },
  })

  called(record: CallRecord): void {
    this.#calls.add(1, { tool: record.tool, outcome: record.outcome })
    if (record.seconds !== undefined)
      this.#callSeconds.record(record.seconds, { outcome: record.outcome })
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
    // Seconds, not OpenTelemetry's default millisecond bounds (Phase 78).
    advice: { explicitBucketBoundaries: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300] },
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
