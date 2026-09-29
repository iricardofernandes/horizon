import { metrics } from '@opentelemetry/api'
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
