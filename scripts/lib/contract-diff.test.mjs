/**
 * Tests for the contract compatibility analysis.
 *
 * Uses node:test, built into Node — the repository root has no package.json and no
 * dependencies by design (ADR 0001), and this is exactly the kind of thing that would
 * otherwise justify adding one.
 *
 *   node --test scripts/lib/
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ADDITIVE,
  BREAKING,
  bumpSatisfied,
  diffSchema,
  parseVersion,
  requiredBump,
} from './contract-diff.mjs'

const object = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

function diff(before, after) {
  const findings = []
  diffSchema(before, after, 'root', findings)
  return findings
}

const severities = (findings) => findings.map((f) => f.severity)

describe('property changes', () => {
  it('flags a removed property as breaking', () => {
    const findings = diff(
      object({ a: { type: 'string' }, b: { type: 'string' } }, ['a']),
      object({ a: { type: 'string' } }, ['a']),
    )
    assert.deepEqual(severities(findings), [BREAKING])
    assert.match(findings[0].message, /property removed/)
    assert.equal(findings[0].path, 'root.b')
  })

  it('treats a new optional property as additive', () => {
    const findings = diff(object({ a: { type: 'string' } }, ['a']), object({ a: { type: 'string' }, b: { type: 'string' } }, ['a']))
    assert.deepEqual(severities(findings), [ADDITIVE])
  })

  it('treats a new required property as breaking', () => {
    // Every existing producer omits it, so every existing producer starts failing.
    const findings = diff(
      object({ a: { type: 'string' } }, ['a']),
      object({ a: { type: 'string' }, b: { type: 'string' } }, ['a', 'b']),
    )
    assert.deepEqual(severities(findings), [BREAKING])
    assert.match(findings[0].message, /required property added/)
  })

  it('flags optional becoming required as breaking', () => {
    const findings = diff(
      object({ a: { type: 'string' } }, []),
      object({ a: { type: 'string' } }, ['a']),
    )
    assert.deepEqual(severities(findings), [BREAKING])
  })

  it('flags required becoming optional as additive', () => {
    const findings = diff(
      object({ a: { type: 'string' } }, ['a']),
      object({ a: { type: 'string' } }, []),
    )
    assert.deepEqual(severities(findings), [ADDITIVE])
  })

  it('recurses into nested objects', () => {
    const findings = diff(
      object({ inner: object({ a: { type: 'string' } }, ['a']) }, ['inner']),
      object({ inner: object({}, []) }, ['inner']),
    )
    assert.deepEqual(severities(findings), [BREAKING])
    assert.equal(findings[0].path, 'root.inner.a')
  })
})

describe('type and constraint changes', () => {
  it('flags a changed type as breaking', () => {
    const findings = diff({ type: 'string' }, { type: 'number' })
    assert.deepEqual(severities(findings), [BREAKING])
  })

  it('flags a tightened maxLength as breaking and a loosened one as additive', () => {
    assert.deepEqual(severities(diff({ type: 'string', maxLength: 200 }, { type: 'string', maxLength: 100 })), [BREAKING])
    assert.deepEqual(severities(diff({ type: 'string', maxLength: 100 }, { type: 'string', maxLength: 200 })), [ADDITIVE])
  })

  it('flags an added pattern as breaking and a removed one as additive', () => {
    assert.deepEqual(severities(diff({ type: 'string' }, { type: 'string', pattern: '^x' })), [BREAKING])
    assert.deepEqual(severities(diff({ type: 'string', pattern: '^x' }, { type: 'string' })), [ADDITIVE])
  })

  it('flags a changed pattern as breaking', () => {
    // Cannot tell widening from narrowing without solving regex containment, so the
    // conservative answer is the safe one.
    assert.deepEqual(severities(diff({ type: 'string', pattern: '^a' }, { type: 'string', pattern: '^b' })), [BREAKING])
  })
})

describe('enum changes', () => {
  it('flags a removed enum value as breaking', () => {
    const findings = diff(
      { type: 'string', enum: ['a', 'b'] },
      { type: 'string', enum: ['a'] },
    )
    assert.deepEqual(severities(findings), [BREAKING])
  })

  it('treats an added enum value as additive', () => {
    const findings = diff({ type: 'string', enum: ['a'] }, { type: 'string', enum: ['a', 'b'] })
    assert.deepEqual(severities(findings), [ADDITIVE])
  })

  it('reports both when values are added and removed', () => {
    const findings = diff(
      { type: 'string', enum: ['a', 'b'] },
      { type: 'string', enum: ['a', 'c'] },
    )
    assert.deepEqual(severities(findings).sort(), [ADDITIVE, BREAKING].sort())
  })
})

describe('identical schemas', () => {
  it('reports nothing', () => {
    const schema = object({ a: { type: 'string' }, b: { type: 'number' } }, ['a'])
    assert.deepEqual(diff(schema, structuredClone(schema)), [])
  })
})

describe('version rules', () => {
  it('requires a major bump for a breaking change at 1.x and above', () => {
    assert.equal(requiredBump(parseVersion('1.4.2'), BREAKING), 'major')
    assert.equal(requiredBump(parseVersion('1.4.2'), ADDITIVE), 'minor')
  })

  it('requires a minor bump for a breaking change under 0.x', () => {
    // npm convention: a caret range on 0.x admits only patch releases, so minor is the
    // breaking position. Treating 0.2.0 as compatible with 0.1.0 would be wrong.
    assert.equal(requiredBump(parseVersion('0.1.0'), BREAKING), 'minor')
    assert.equal(requiredBump(parseVersion('0.1.0'), ADDITIVE), 'patch')
  })

  it('accepts a bump at or above the required position', () => {
    assert.equal(bumpSatisfied(parseVersion('0.1.0'), parseVersion('0.2.0'), 'minor'), true)
    assert.equal(bumpSatisfied(parseVersion('0.1.0'), parseVersion('1.0.0'), 'minor'), true)
    assert.equal(bumpSatisfied(parseVersion('0.1.0'), parseVersion('0.1.1'), 'minor'), false)
  })

  it('rejects an unchanged version', () => {
    assert.equal(bumpSatisfied(parseVersion('0.1.0'), parseVersion('0.1.0'), 'patch'), false)
  })

  it('rejects an unparseable version', () => {
    assert.throws(() => parseVersion('not-a-version'), /unparseable/)
  })
})
