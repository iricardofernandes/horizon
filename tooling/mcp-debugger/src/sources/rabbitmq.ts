import { fetchJson } from '../http-client.js'

type Queue = {
  name: string
  vhost: string
  messages: number
  messages_ready: number
  messages_unacknowledged: number
  consumers: number
  state?: string
  arguments?: Record<string, unknown>
}

export class RabbitMqSource {
  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string,
  ) {}

  async listDlqs(): Promise<unknown> {
    const queues = await fetchJson<Queue[]>(new URL('/api/queues', this.baseUrl), {
      headers: {
        authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
      },
    })
    return {
      queues: queues.filter(isDlq).map((queue) => ({
        name: queue.name,
        vhost: queue.vhost,
        messages: queue.messages,
        ready: queue.messages_ready,
        unacknowledged: queue.messages_unacknowledged,
        consumers: queue.consumers,
        state: queue.state ?? 'unknown',
        deadLetterExchange: queue.arguments?.['x-dead-letter-exchange'],
      })),
      messageBodiesAvailable: false,
      notice:
        'RabbitMQ exposes message samples only through a dequeue/requeue operation; this read-only debugger intentionally does not call it.',
    }
  }
}

function isDlq(queue: Queue): boolean {
  const name = queue.name.toLowerCase()
  return name.includes('dlq') || name.includes('dead-letter') || name.endsWith('.dead')
}
