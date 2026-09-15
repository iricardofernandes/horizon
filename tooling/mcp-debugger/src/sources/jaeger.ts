import { fetchJson } from '../http-client.js'

type JaegerTrace = {
  traceID: string
  spans?: Array<{ duration?: number; operationName?: string; [key: string]: unknown }>
}
type JaegerResponse = { data?: JaegerTrace[] }

export class JaegerSource {
  constructor(private readonly baseUrl: string) {}

  async getTrace(traceId: string): Promise<unknown> {
    const response = await fetchJson<JaegerResponse>(
      new URL(`/api/traces/${encodeURIComponent(traceId)}`, this.baseUrl),
    )
    const trace = response.data?.[0]
    if (!trace) throw new Error(`Trace ${traceId} was not found`)
    return trace
  }

  async findSlow(input: {
    service: string
    operation?: string | undefined
    minutes: number
    percentile: number
    limit: number
  }): Promise<unknown> {
    const url = new URL('/api/traces', this.baseUrl)
    url.searchParams.set('service', input.service)
    if (input.operation) url.searchParams.set('operation', input.operation)
    url.searchParams.set('start', String((Date.now() - input.minutes * 60_000) * 1_000))
    url.searchParams.set('end', String(Date.now() * 1_000))
    url.searchParams.set('limit', String(input.limit))
    const response = await fetchJson<JaegerResponse>(url)
    const traces = (response.data ?? []).map((trace) => ({
      traceId: trace.traceID,
      durationMicros: Math.max(0, ...(trace.spans ?? []).map((span) => span.duration ?? 0)),
      spans: trace.spans?.length ?? 0,
    }))
    const ordered = traces.map((trace) => trace.durationMicros).sort((a, b) => a - b)
    const threshold =
      ordered[Math.max(0, Math.ceil((input.percentile / 100) * ordered.length) - 1)] ?? 0
    return {
      percentile: input.percentile,
      thresholdMicros: threshold,
      traces: traces.filter((trace) => trace.durationMicros >= threshold),
    }
  }
}
