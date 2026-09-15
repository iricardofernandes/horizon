import type { WebhookHttpClient } from '@/application/webhook-service'

export class FetchWebhookClient implements WebhookHttpClient {
  async post(input: {
    url: string
    body: string
    headers: Readonly<Record<string, string>>
    timeoutMs: number
  }): Promise<{ status: number }> {
    const response = await fetch(input.url, {
      method: 'POST',
      headers: input.headers,
      body: input.body,
      signal: AbortSignal.timeout(input.timeoutMs),
      redirect: 'error',
    })
    await response.body?.cancel()
    return { status: response.status }
  }
}
