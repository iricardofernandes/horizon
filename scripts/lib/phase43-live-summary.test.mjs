import assert from 'node:assert/strict'
import { test } from 'node:test'
import { phase43LiveSummary } from './phase43-live-summary.mjs'

test('live exchange logs keep status and digest without authority references or XML', () => {
  const summary = phase43LiveSummary({
    action: 'resume',
    exchangeId: 'ec9d5a93-919d-45c9-8ed8-64d9e537dfc4',
    service: 'authorization',
    statusCode: '100',
    documentStatusCode: '100',
    eventStatusCode: null,
    responseDigest: 'a'.repeat(64),
    receipt: 'sensitive-receipt',
    protocolNumber: 'sensitive-protocol',
    response: '<sensitive-xml/>',
  })
  assert.equal(summary.receiptPresent, true)
  assert.equal(summary.protocolPresent, true)
  assert.equal(summary.responseDigest, 'a'.repeat(64))
  assert.doesNotMatch(JSON.stringify(summary), /sensitive/)
})

test('live exchange logs require a retained response digest', () => {
  assert.throws(() => phase43LiveSummary({ responseDigest: null }), /response digest/)
})
