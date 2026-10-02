#!/usr/bin/env node
/**
 * One broker identity per module (Phase 90, ADR 0075).
 *
 * Each module connects to RabbitMQ as a user of its own, which may:
 * - declare, bind and read only names that start with `<module>.` (its queues and their
 *   dead-letter exchanges);
 * - declare and read the shared `horizon.events` exchange, and publish to it only under
 *   routing keys `<module>.*`, when it publishes at all;
 * - publish journal resends and seals to `horizon.journal`, again only as `<module>.*`.
 *
 * Nobody but the operator may write to the default exchange, which reaches any queue by
 * name. Consumers then refuse a message whose routing key is not the event its body claims.
 *
 * Locally, `--write <path>` renders the definitions RabbitMQ imports at boot. On a broker
 * that already runs (Amazon MQ), `--apply <management-url>` creates the same module users and
 * permissions through the management API, as the administrator named by
 * `RABBITMQ_ADMIN_USER` and `RABBITMQ_ADMIN_PASSWORD`; it creates no administrator and no
 * monitor, and refuses to run until every module has a password of its own in the
 * environment. Locally, passwords come from the environment, then from `infra/.env`, then
 * from defaults that are for development only.
 *
 * On AWS the administrator and every module password come from one secret, read on standard
 * input so no value lands in a shell variable or on disk (infra/terraform/README.md).
 *
 *   node infra/scripts/broker-definitions.mjs --write infra/generated/rabbitmq-definitions.json
 *   node infra/scripts/broker-definitions.mjs --apply https://<broker>:443 [--check]
 *     [--environment-json -|<path>]
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** What each module does on the bus. Identity and Parties publish and consume nothing. */
export const MODULES = Object.freeze({
  identity: { publishes: true },
  catalog: { publishes: true, consumes: true },
  inventory: { publishes: true, consumes: true, journals: true },
  sales: { publishes: true, consumes: true, journals: true },
  webhooks: { consumes: true },
  parties: { publishes: true },
  financial: { publishes: true, consumes: true, journals: true },
  treasury: { publishes: true, consumes: true, journals: true },
  ledger: { publishes: true, consumes: true, journals: true },
  procurement: { publishes: true, consumes: true, journals: true },
  fiscal: { publishes: true, consumes: true },
  crm: { publishes: true, consumes: true, journals: true },
  reporting: { consumes: true, readsJournal: true },
  files: { publishes: true, consumes: true },
  agent: { consumes: true },
  knowledge: { consumes: true },
})

export const EVENTS_EXCHANGE = 'horizon.events'
export const JOURNAL_EXCHANGE = 'horizon.journal'
export const ADMIN_USER = 'horizon'
/** The MCP debugger reads queue depths through the management API, and nothing else. */
export const MONITOR_USER = 'mcp-debugger'

/**
 * The shared exchanges exist before any module does: a topic permission names its exchange,
 * and RabbitMQ refuses one whose exchange is missing. Each module declares them the same way.
 */
export const SHARED_EXCHANGES = Object.freeze(
  [EVENTS_EXCHANGE, JOURNAL_EXCHANGE].map((name) => ({
    name,
    vhost: '/',
    type: 'topic',
    durable: true,
    auto_delete: false,
    internal: false,
    arguments: {},
  })),
)

const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const anyOf = (names) => `^(${names.join('|')})$`

/** The permissions and topic permissions of one module's user. */
export function permissionsOf(module) {
  const role = MODULES[module]
  if (!role) throw new Error(`Unknown module: ${module}`)
  const own = `${escape(module)}\\..*`
  const events = escape(EVENTS_EXCHANGE)
  const journal = escape(JOURNAL_EXCHANGE)
  const configure = [own, events, ...(role.journals || role.readsJournal ? [journal] : [])]
  const write = [own, ...(role.publishes ? [events] : []), ...(role.journals ? [journal] : [])]
  // Only a consumer reads the shared exchange: reading it is what binding a queue to it takes.
  const read = [own, ...(role.consumes ? [events] : []), ...(role.readsJournal ? [journal] : [])]
  const topics = []
  if (role.publishes || role.consumes)
    topics.push({
      exchange: EVENTS_EXCHANGE,
      // A module that does not publish has no write on the exchange at all; the pattern only
      // narrows what a publisher may send.
      write: role.publishes ? `^${escape(module)}\\.` : '^$',
      read: role.consumes ? '.*' : '^$',
    })
  if (role.journals || role.readsJournal)
    topics.push({
      exchange: JOURNAL_EXCHANGE,
      write: role.journals ? `^${escape(module)}\\.` : '^$',
      read: role.readsJournal ? '.*' : '^$',
    })
  return {
    configure: anyOf(configure),
    write: anyOf(write),
    read: anyOf(read),
    topics,
  }
}

/** RabbitMQ's `rabbit_password_hashing_sha256`: base64(salt ‖ sha256(salt ‖ password)). */
export function passwordHash(password, salt = randomBytes(4)) {
  const digest = createHash('sha256').update(Buffer.concat([salt, Buffer.from(password, 'utf8')])).digest()
  return Buffer.concat([salt, digest]).toString('base64')
}

/** The shortest password `--apply` accepts for a module on a broker that is not local. */
export const MIN_PASSWORD_LENGTH = 16

export const passwordKey = (name) =>
  `HORIZON_RABBITMQ_PASSWORD_${name.toUpperCase().replace(/-/g, '_')}`

/** `HORIZON_RABBITMQ_PASSWORD_<NAME>`, from the environment, then `infra/.env`. */
export function passwordFor(name, environment) {
  return environment[passwordKey(name)] || `${name}-local`
}

/** The password variables a broker that is not local still lacks: names only, never values. */
export function missingPasswords(environment) {
  return Object.keys(MODULES)
    .map(passwordKey)
    .filter((key) => (environment[key] ?? '').length < MIN_PASSWORD_LENGTH)
}

export function adminPassword(environment) {
  return environment.HORIZON_RABBITMQ_ADMIN_PASSWORD || 'horizon'
}

/**
 * Everything the broker needs to know about its users, as RabbitMQ definitions. With
 * `modulesOnly`, the module users alone: what `--apply` creates on a broker whose
 * administrator already exists.
 */
export function definitionsOf(environment, { modulesOnly = false } = {}) {
  const users = modulesOnly
    ? []
    : [
        {
          name: ADMIN_USER,
          password_hash: passwordHash(adminPassword(environment)),
          hashing_algorithm: 'rabbit_password_hashing_sha256',
          tags: ['administrator'],
          limits: {},
        },
        {
          name: MONITOR_USER,
          password_hash: passwordHash(passwordFor(MONITOR_USER, environment)),
          hashing_algorithm: 'rabbit_password_hashing_sha256',
          tags: ['monitoring'],
          limits: {},
        },
      ]
  const permissions = modulesOnly
    ? []
    : [
        { user: ADMIN_USER, vhost: '/', configure: '.*', write: '.*', read: '.*' },
        // Access to the virtual host, so its queues can be listed, and no right on any of them.
        { user: MONITOR_USER, vhost: '/', configure: '^$', write: '^$', read: '^$' },
      ]
  const topicPermissions = []
  for (const module of Object.keys(MODULES)) {
    const granted = permissionsOf(module)
    users.push({
      name: module,
      password_hash: passwordHash(passwordFor(module, environment)),
      hashing_algorithm: 'rabbit_password_hashing_sha256',
      tags: [],
      limits: {},
    })
    permissions.push({
      user: module,
      vhost: '/',
      configure: granted.configure,
      write: granted.write,
      read: granted.read,
    })
    for (const topic of granted.topics) topicPermissions.push({ user: module, vhost: '/', ...topic })
  }
  return {
    users,
    vhosts: [{ name: '/' }],
    permissions,
    topic_permissions: topicPermissions,
    parameters: [],
    global_parameters: [],
    policies: [],
    queues: [],
    exchanges: [...SHARED_EXCHANGES],
    bindings: [],
  }
}

/** `KEY=VALUE` lines of `infra/.env`, under the process environment. */
export function environmentFrom(path) {
  const fromFile = {}
  if (existsSync(path))
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
      if (match) fromFile[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  return { ...fromFile, ...process.env }
}

/** A JSON object of string values, from a file or `-` for standard input. */
export async function environmentJson(source) {
  let text = ''
  if (source === '-') for await (const chunk of process.stdin) text += chunk
  else text = readFileSync(source, 'utf8')
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('--environment-json takes a JSON object')
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string'))
}

/** Creates or updates every module user and its permissions on a running broker. */
async function apply(base, environment, checkOnly) {
  const admin = environment.RABBITMQ_ADMIN_USER
  const password = environment.RABBITMQ_ADMIN_PASSWORD
  if (!admin || !password)
    throw new Error('Set RABBITMQ_ADMIN_USER and RABBITMQ_ADMIN_PASSWORD to the broker administrator')
  if (Object.hasOwn(MODULES, admin)) throw new Error('The administrator must not be a module user')
  const authorization = `Basic ${Buffer.from(`${admin}:${password}`).toString('base64')}`
  const call = async (method, path, body) => {
    const response = await fetch(`${base.replace(/\/$/, '')}/api${path}`, {
      method,
      headers: { authorization, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}`)
    return response.status === 204 ? null : response.json().catch(() => null)
  }
  if (checkOnly) {
    const users = new Set((await call('GET', '/users')).map((user) => user.name))
    const missing = Object.keys(MODULES).filter((name) => !users.has(name))
    process.stdout.write(`${JSON.stringify({ missing })}\n`)
    if (missing.length > 0) process.exitCode = 1
    return
  }
  // A broker that is not local takes no default password: each module brings its own.
  const unset = missingPasswords(environment)
  if (unset.length > 0)
    throw new Error(
      `Set each to a password of at least ${MIN_PASSWORD_LENGTH} characters: ${unset.join(', ')}`,
    )
  const definitions = definitionsOf(environment, { modulesOnly: true })
  for (const exchange of definitions.exchanges)
    await call('PUT', `/exchanges/%2F/${encodeURIComponent(exchange.name)}`, {
      type: exchange.type,
      durable: exchange.durable,
      auto_delete: exchange.auto_delete,
      internal: exchange.internal,
      arguments: exchange.arguments,
    })
  for (const user of definitions.users)
    await call('PUT', `/users/${encodeURIComponent(user.name)}`, {
      password_hash: user.password_hash,
      hashing_algorithm: user.hashing_algorithm,
      tags: user.tags.join(','),
    })
  for (const granted of definitions.permissions)
    await call('PUT', `/permissions/%2F/${encodeURIComponent(granted.user)}`, {
      configure: granted.configure,
      write: granted.write,
      read: granted.read,
    })
  for (const topic of definitions.topic_permissions)
    await call('PUT', `/topic-permissions/%2F/${encodeURIComponent(topic.user)}`, {
      exchange: topic.exchange,
      write: topic.write,
      read: topic.read,
    })
  process.stdout.write(`${JSON.stringify({ applied: definitions.users.length })}\n`)
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const args = process.argv.slice(2)
  const flag = (name) => {
    const index = args.indexOf(`--${name}`)
    return index === -1 ? undefined : args[index + 1]
  }
  const fromJson = flag('environment-json')
  const environment = {
    ...environmentFrom(join(root, 'infra', '.env')),
    ...(fromJson ? await environmentJson(fromJson) : {}),
  }
  const target = flag('write')
  const base = flag('apply')
  if (target) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${JSON.stringify(definitionsOf(environment), null, 2)}\n`, { mode: 0o644 })
    process.stdout.write(`rendered ${target}\n`)
  } else if (base) {
    await apply(base, environment, args.includes('--check'))
  } else {
    process.stderr.write(
      'usage: broker-definitions.mjs --write <path> | --apply <management-url> [--check] [--environment-json -|<path>]\n',
    )
    process.exitCode = 2
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
