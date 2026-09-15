import { z } from 'zod'

const integer = (minimum: number) => z.coerce.number().int().min(minimum)

export const environmentSchema = z.object({
  PORT: integer(1).max(65535).default(3005),
  DATABASE_URL: z.url(),
  DATABASE_RELAY_URL: z.url(),
  RABBITMQ_URL: z.url(),
  JWKS_URL: z.url(),
  ACCESS_TOKEN_MAX_AGE_SECONDS: integer(1).max(900).default(900),
  AMQP_PREFETCH: integer(1).max(1000).default(20),
  WEBHOOK_SECRET_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
  WEBHOOK_MAX_ATTEMPTS: integer(1).max(100).default(8),
  WEBHOOK_BACKOFF_BASE_MS: integer(1).default(1000),
  WEBHOOK_BACKOFF_MAX_MS: integer(1).default(3_600_000),
  WEBHOOK_BACKOFF_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.3),
  WEBHOOK_DELIVERY_TIMEOUT_MS: integer(1).default(10_000),
  WEBHOOK_QUEUE_DEPTH_ALERT: integer(1).default(10_000),
  OUTBOX_BATCH_SIZE: integer(1).max(1000).default(100),
  OUTBOX_POLL_INTERVAL_MS: integer(100).default(250),
})

export type WebhookEnvironment = z.infer<typeof environmentSchema>
