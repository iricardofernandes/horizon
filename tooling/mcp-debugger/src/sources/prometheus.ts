import { fetchJson } from '../http-client.js'

type PrometheusResponse = { data?: { result?: unknown[] }; status?: string }

export class PrometheusSource {
  constructor(private readonly baseUrl: string) {}

  async health(service: string, minutes: number): Promise<unknown> {
    const window = `${minutes}m`
    const queries = {
      requestRate: `sum(rate(http_server_duration_milliseconds_count{service_name=${JSON.stringify(service)}}[${window}]))`,
      errorRate: `sum(rate(http_server_duration_milliseconds_count{service_name=${JSON.stringify(service)},http_response_status_code=~"5.."}[${window}]))`,
      p95LatencyMs: `histogram_quantile(0.95, sum by (le) (rate(http_server_duration_milliseconds_bucket{service_name=${JSON.stringify(service)}}[${window}])))`,
      cpuSecondsPerSecond: `sum(rate(process_cpu_time_seconds_total{service_name=${JSON.stringify(service)}}[${window}]))`,
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(queries).map(async ([key, query]) => [key, await this.query(query)]),
      ),
    )
  }

  private async query(query: string): Promise<unknown[]> {
    const url = new URL('/api/v1/query', this.baseUrl)
    url.searchParams.set('query', query)
    const response = await fetchJson<PrometheusResponse>(url)
    if (response.status !== 'success') throw new Error('Prometheus query failed')
    return response.data?.result ?? []
  }
}
