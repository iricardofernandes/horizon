#!/usr/bin/env node
/**
 * Dead-letter queues, as they are (Phase 79). Until Phase 79 every consumer bound its DLQ to
 * the shared dead-letter exchange with `#`, so each dead letter was copied into every DLQ.
 * RabbitMQ stamps a dead letter with the queue it died in (`x-first-death-queue`), so a
 * copy is told apart exactly: it died somewhere else.
 *
 * Without flags it reports, per DLQ, how many messages died in it and how many are copies.
 * With `--purge-copies` it removes the copies and keeps every message that is the queue's
 * own. Nothing else is touched.
 *
 * With `--replay <queue>`, the queue's own dead letters go back to it, once its cause is
 * fixed: each is republished to the queue alone, then removed from the DLQ. Every consumer
 * claims an event in its inbox, so one already applied is not applied twice.
 *
 *   node scripts/dead-letters.mjs [--url amqp://horizon:horizon@localhost:5672]
 *     [--api http://localhost:15672] [--purge-copies] [--replay <queue>]
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// amqplib is a dependency of the modules, not of the repository: borrow one module's copy.
const amqp = createRequire(join(root, 'knowledge/package.json'))('amqplib')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const url = flag('url', 'amqp://horizon:horizon@localhost:5672')
const api = flag('api', 'http://localhost:15672').replace(/\/$/, '')
const purge = args.includes('--purge-copies')
const replay = flag('replay', undefined)

/** Every queue ending in `.dlq`, from the management API. */
async function deadLetterQueues() {
  const { username, password } = new URL(url)
  const response = await fetch(`${api}/api/queues`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${decodeURIComponent(username)}:${decodeURIComponent(password)}`).toString('base64')}`,
    },
  })
  if (!response.ok) throw new Error(`the management API answered ${response.status}`)
  const queues = await response.json()
  // The connection's virtual host only: the API lists every one.
  const vhost = decodeURIComponent(new URL(url).pathname.slice(1)) || '/'
  return queues
    .filter((queue) => queue.vhost === vhost && queue.name.endsWith('.dlq'))
    .map((queue) => queue.name)
    .sort()
}

/** The queue's own dead letters back into it, each removed only once the broker has it. */
async function replayInto(queue) {
  const channel = await connection.createConfirmChannel()
  let replayed = 0
  let copies = 0
  const held = []
  // Only what is there now: a replayed event that dies again returns to the DLQ, and must
  // not be taken again in the same run.
  const { messageCount } = await channel.checkQueue(`${queue}.dlq`)
  try {
    for (let taken = 0; taken < messageCount; taken++) {
      const message = await channel.get(`${queue}.dlq`, { noAck: false })
      if (!message) break
      const { headers = {}, ...properties } = message.properties
      if (headers['x-first-death-queue'] !== queue) {
        held.push(message)
        copies++
        continue
      }
      // The death stamps go: the event is new to the queue again, and may die again.
      const fresh = Object.fromEntries(
        Object.entries(headers).filter(([name]) => !name.startsWith('x-death') && !name.startsWith('x-first-death') && !name.startsWith('x-last-death')),
      )
      channel.sendToQueue(queue, message.content, { ...properties, headers: fresh })
      await channel.waitForConfirms()
      channel.ack(message)
      replayed++
    }
  } finally {
    for (const message of held) channel.nack(message, false, true)
    await channel.close()
  }
  console.log(`${queue}: ${replayed} replayed${copies ? `, ${copies} copies left untouched` : ''}`)
  console.log('A replayed event that fails again goes back to the DLQ: run the report to see what is left.')
}

const connection = await amqp.connect(url)
if (replay) {
  try {
    await replayInto(replay)
  } finally {
    await connection.close()
  }
  process.exit(0)
}
const report = []
try {
  for (const dlq of await deadLetterQueues()) {
    const owner = dlq.slice(0, -'.dlq'.length)
    const channel = await connection.createChannel()
    const own = []
    const copies = []
    const died = new Map()
    // Read every message without acknowledging it; decide once all are held.
    for (;;) {
      const message = await channel.get(dlq, { noAck: false })
      if (!message) break
      const where = String(message.properties.headers?.['x-first-death-queue'] ?? 'unknown')
      died.set(where, (died.get(where) ?? 0) + 1)
      ;(where === owner ? own : copies).push(message)
    }
    if (purge) for (const message of copies) channel.ack(message)
    for (const message of purge ? own : [...own, ...copies]) channel.nack(message, false, true)
    await channel.close()
    report.push({
      dlq,
      own: own.length,
      copies: copies.length,
      ...(purge ? { removed: copies.length } : {}),
      diedIn: Object.fromEntries([...died.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)),
    })
  }
} finally {
  await connection.close()
}
for (const row of report)
  console.log(
    `${row.dlq.padEnd(34)} own ${String(row.own).padStart(6)}  copies ${String(row.copies).padStart(6)}${purge ? `  removed ${row.removed}` : ''}  ${JSON.stringify(row.diedIn)}`,
  )
if (!purge && report.some((row) => row.copies > 0))
  console.log('\nCopies are other queues’ dead letters, from the old catch-all binding: --purge-copies removes them.')
