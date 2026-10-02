/**
 * Tests for the broker identities (Phase 90, ADR 0075): what each module's RabbitMQ user may
 * declare, publish and read, and the definitions RabbitMQ imports at boot.
 *
 *   node --test scripts/lib/
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  definitionsOf,
  MIN_PASSWORD_LENGTH,
  MODULES,
  missingPasswords,
  passwordHash,
  passwordKey,
  permissionsOf,
} from '../../infra/scripts/broker-definitions.mjs'

const matches = (pattern, name) => new RegExp(pattern).test(name)

describe('a module user', () => {
  it('declares and binds its own names, and the shared exchanges, nothing else', () => {
    const { configure } = permissionsOf('sales')
    for (const name of ['sales.events', 'sales.events.dlx', 'sales.events.dlq', 'horizon.events', 'horizon.journal'])
      assert.ok(matches(configure, name), name)
    for (const name of ['financial.events', 'horizon.events.dlx', 'horizon.dead-letters', 'amq.default', 'salesx.events'])
      assert.ok(!matches(configure, name), name)
  })

  it('writes to its own names and the exchanges it publishes to, never the default exchange', () => {
    const { write } = permissionsOf('sales')
    for (const name of ['sales.events', 'sales.events.dlx', 'horizon.events', 'horizon.journal'])
      assert.ok(matches(write, name), name)
    // RabbitMQ checks a publish to the default exchange as a write to `amq.default`.
    for (const name of ['amq.default', '', 'ledger.events.dlx', 'reporting.replay', 'financial.events'])
      assert.ok(!matches(write, name), name)
  })

  it('publishes only routing keys of its own module', () => {
    const events = permissionsOf('sales').topics.find((topic) => topic.exchange === 'horizon.events')
    assert.ok(matches(events.write, 'sales.order.placed'))
    assert.ok(!matches(events.write, 'financial.settlement.recorded'))
    assert.ok(!matches(events.write, 'salesforce.lead.created'))
    const journal = permissionsOf('sales').topics.find((topic) => topic.exchange === 'horizon.journal')
    assert.ok(matches(journal.write, 'sales.seal'))
    assert.ok(!matches(journal.write, 'financial.seal'))
  })

  it('may not write to the shared exchange at all when it only consumes', () => {
    for (const module of ['webhooks', 'agent', 'knowledge', 'reporting']) {
      const granted = permissionsOf(module)
      assert.ok(!matches(granted.write, 'horizon.events'), module)
      assert.ok(matches(granted.read, 'horizon.events'), module)
      const events = granted.topics.find((topic) => topic.exchange === 'horizon.events')
      assert.equal(events.write, '^$', module)
    }
  })

  it('may not read the shared exchange when it only publishes', () => {
    for (const module of ['identity', 'parties']) {
      const granted = permissionsOf(module)
      assert.ok(matches(granted.write, 'horizon.events'), module)
      assert.ok(!matches(granted.read, 'horizon.events'), module)
      assert.equal(granted.topics.find((topic) => topic.exchange === 'horizon.events').read, '^$', module)
    }
  })

  it('reads the journal only when it is Reporting', () => {
    for (const module of Object.keys(MODULES))
      assert.equal(matches(permissionsOf(module).read, 'horizon.journal'), module === 'reporting', module)
    assert.ok(!matches(permissionsOf('reporting').write, 'horizon.journal'))
  })

  it('names no module it does not know', () => {
    assert.throws(() => permissionsOf('billing'), /Unknown module/)
  })
})

describe('the definitions', () => {
  it('hash a password the way RabbitMQ checks it', () => {
    const salt = Buffer.from([1, 2, 3, 4])
    const hash = Buffer.from(passwordHash('sales-local', salt), 'base64')
    assert.equal(hash.length, 36)
    assert.deepEqual(hash.subarray(0, 4), salt)
    const digest = createHash('sha256').update(Buffer.concat([salt, Buffer.from('sales-local')])).digest()
    assert.deepEqual(hash.subarray(4), digest)
  })

  it('give every module a user of its own, with its own permissions', () => {
    const definitions = definitionsOf({})
    const names = definitions.users.map((user) => user.name)
    assert.equal(new Set(names).size, names.length)
    for (const module of Object.keys(MODULES)) {
      assert.ok(names.includes(module), module)
      const user = definitions.users.find((candidate) => candidate.name === module)
      assert.deepEqual(user.tags, [])
      assert.equal(definitions.permissions.filter((granted) => granted.user === module).length, 1)
    }
    const monitor = definitions.permissions.find((granted) => granted.user === 'mcp-debugger')
    assert.deepEqual([monitor.configure, monitor.write, monitor.read], ['^$', '^$', '^$'])
  })

  it('declare the shared exchanges, so every topic permission names one that exists', () => {
    const definitions = definitionsOf({})
    const declared = new Set(definitions.exchanges.map((exchange) => exchange.name))
    assert.deepEqual([...declared].sort(), ['horizon.events', 'horizon.journal'])
    assert.ok(definitions.exchanges.every((exchange) => exchange.type === 'topic' && exchange.durable))
    assert.ok(definitions.topic_permissions.every((topic) => declared.has(topic.exchange)))
  })

  it('carry no password, only salted hashes', () => {
    const rendered = JSON.stringify(definitionsOf({ HORIZON_RABBITMQ_PASSWORD_SALES: 'a-password-of-sales' }))
    assert.ok(!rendered.includes('a-password-of-sales'))
    assert.ok(!rendered.includes('sales-local'))
  })

  it('leave the administrator and the monitor out of what a remote broker is given', () => {
    const definitions = definitionsOf({}, { modulesOnly: true })
    assert.deepEqual(definitions.users.map((user) => user.name).sort(), Object.keys(MODULES).sort())
    assert.ok(definitions.users.every((user) => user.tags.length === 0))
  })

  it('name each password a remote broker still lacks, and never its value', () => {
    const environment = Object.fromEntries(
      Object.keys(MODULES).map((module) => [passwordKey(module), 'x'.repeat(MIN_PASSWORD_LENGTH)]),
    )
    assert.deepEqual(missingPasswords(environment), [])
    environment.HORIZON_RABBITMQ_PASSWORD_SALES = 'short'
    delete environment.HORIZON_RABBITMQ_PASSWORD_LEDGER
    assert.deepEqual(missingPasswords(environment), [
      'HORIZON_RABBITMQ_PASSWORD_SALES',
      'HORIZON_RABBITMQ_PASSWORD_LEDGER',
    ])
  })
})
