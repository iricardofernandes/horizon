import { fetchJson } from '../http-client.js'

type LokiResponse = {
  data?: { result?: Array<{ stream?: Record<string, string>; values?: Array<[string, string]> }> }
}

export class LokiSource {
  constructor(private readonly baseUrl: string) {}

  async search(input: {
    module?: string | undefined
    level?: string | undefined
    traceId?: string | undefined
    text?: string | undefined
    minutes: number
    limit: number
  }): Promise<unknown[]> {
    const labels = [
      input.module ? `service_name=${quote(input.module)}` : '',
      input.level ? `level=${quote(input.level)}` : '',
    ]
      .filter(Boolean)
      .join(',')
    const filters = [input.traceId, input.text]
      .filter(Boolean)
      .map((value) => `|= ${quote(value as string)}`)
      .join(' ')
    const query = `{${labels || 'service_name=~".+"'}} ${filters}`.trim()
    const url = new URL('/loki/api/v1/query_range', this.baseUrl)
    url.searchParams.set('query', query)
    url.searchParams.set('start', String(BigInt(Date.now() - input.minutes * 60_000) * 1_000_000n))
    url.searchParams.set('end', String(BigInt(Date.now()) * 1_000_000n))
    url.searchParams.set('limit', String(input.limit))
    url.searchParams.set('direction', 'backward')
    const response = await fetchJson<LokiResponse>(url)
    return (response.data?.result ?? []).flatMap((stream) =>
      (stream.values ?? []).map(([timestamp, line]) => ({
        timestamp,
        labels: stream.stream ?? {},
        line: parseLine(line),
      })),
    )
  }

  async recentErrors(minutes: number, limit: number): Promise<unknown[]> {
    const entries = await this.search({ level: 'error', minutes, limit })
    const groups = new Map<string, { exceptionType: string; count: number; latest: unknown }>()
    for (const entry of entries) {
      const record = entry as { line?: Record<string, unknown> | string }
      const line = record.line
      const exceptionType =
        typeof line === 'object' && line
          ? String(line.exceptionType ?? line.exception_type ?? line.name ?? 'unknown')
          : 'unknown'
      const group = groups.get(exceptionType)
      if (group) group.count += 1
      else groups.set(exceptionType, { exceptionType, count: 1, latest: entry })
    }
    return [...groups.values()].sort((left, right) => right.count - left.count)
  }
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function parseLine(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
