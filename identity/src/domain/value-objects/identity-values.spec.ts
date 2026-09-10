import { TEST_HASH, valid } from 'test/support/identity-context'
import { describe, expect, it } from 'vitest'
import { ApiKeyScopes } from './api-key-scopes'
import { ApiKeyToken } from './api-key-token'
import { Email } from './email'
import { PasswordHash } from './password-hash'
import { PersonName } from './person-name'
import { RoleAssignments } from './role-assignments'
import { TenantName } from './tenant-name'
import { TenantSlug } from './tenant-slug'
import { Timezone } from './timezone'

describe('identity value validation', () => {
  it('normalizes email without applying provider-specific dot or plus rules', () => {
    const email = valid(Email.create(' Ana.Silva+work@EXAMPLE.COM '))
    expect(email.value).toBe('ana.silva+work@example.com')
    expect(email.domain).toBe('example.com')
    expect(email.equals(valid(Email.create('ana.silva+work@example.com')))).toBe(true)
    expect(email.equals(valid(Email.create('anasilva@example.com')))).toBe(false)
  })
  it.each(['', 'a'.repeat(255), 'invalid', 'a@localhost', 'a b@example.com'])(
    'rejects invalid email %s',
    (raw) => {
      expect(Email.create(raw).isLeft()).toBe(true)
    },
  )
  it.each([PersonName, TenantName])(
    'normalizes whitespace in names and enforces size bounds',
    (type) => {
      const name = valid(type.create('  Ana \n Silva  '))
      expect(name.value).toBe('Ana Silva')
      expect(name.equals(valid(type.create('Ana Silva')))).toBe(true)
      expect(type.create('').isLeft()).toBe(true)
      expect(type.create('a'.repeat(201)).isLeft()).toBe(true)
      expect(type.create('a'.repeat(200)).isRight()).toBe(true)
    },
  )
  it('normalizes handles and rejects punctuation and size violations', () => {
    const slug = valid(TenantSlug.create(' EXAMPLE-WORKSPACE '))
    expect(slug.value).toBe('example-workspace')
    expect(slug.equals(valid(TenantSlug.create('example-workspace')))).toBe(true)
    for (const raw of [
      'ab',
      'a'.repeat(64),
      '-example',
      'example-',
      'example--workspace',
      'ex ample',
    ])
      expect(TenantSlug.create(raw).isLeft()).toBe(true)
  })
  it('accepts known timezones and refuses empty or unknown zones', () => {
    const zone = valid(Timezone.create(' America/Sao_Paulo '))
    expect(zone.value).toBe('America/Sao_Paulo')
    expect(zone.equals(valid(Timezone.create('America/Sao_Paulo')))).toBe(true)
    expect(Timezone.create('').isLeft()).toBe(true)
    expect(Timezone.create('Unknown/Zone').isLeft()).toBe(true)
  })
  it('detects weaker Argon2 parameters on every axis and never downgrades a stronger hash', () => {
    const hash = valid(PasswordHash.create(TEST_HASH))
    expect(hash.encoded).toBe(TEST_HASH)
    expect(hash.equals(valid(PasswordHash.create(TEST_HASH)))).toBe(true)
    expect(PasswordHash.create('not-a-hash').isLeft()).toBe(true)
    expect(hash.needsRehash({ memoryKib: 20000, timeCost: 2, parallelism: 1 })).toBe(true)
    expect(hash.needsRehash({ memoryKib: 19456, timeCost: 3, parallelism: 1 })).toBe(true)
    expect(hash.needsRehash({ memoryKib: 19456, timeCost: 2, parallelism: 2 })).toBe(true)
    expect(hash.needsRehash({ memoryKib: 1024, timeCost: 1, parallelism: 1 })).toBe(false)
  })
  it('round-trips credentials and rejects invalid segments', () => {
    const token = ApiKeyToken.create({
      environment: 'test',
      prefix: 'A'.repeat(24),
      secret: 'b'.repeat(32),
    })
    expect(valid(ApiKeyToken.parse(` ${token.toString()} `)).equals(token)).toBe(true)
    expect(token.environment).toBe('test')
    expect(token.prefix).toHaveLength(24)
    expect(token.secret).toHaveLength(32)
    for (const raw of [
      'broken',
      token.toString().replace('test', 'prod'),
      token.toString().slice(0, -1),
    ])
      expect(ApiKeyToken.parse(raw).isLeft()).toBe(true)
  })
  it('canonicalizes scope sets and checks their module reach against roles', () => {
    const scopes = valid(ApiKeyScopes.create(['identity:write', 'catalog:read', 'identity:write']))
    expect(scopes.values).toEqual(['catalog:read', 'identity:write'])
    expect(scopes.equals(valid(ApiKeyScopes.create(['identity:write', 'catalog:read'])))).toBe(true)
    const roles = RoleAssignments.of([{ module: 'identity', role: 'owner' }])
    expect(scopes.isGrantableBy(roles)).toBe(false)
    expect(scopes.modulesBeyond(roles)).toEqual(['catalog'])
    expect(scopes.contains('identity:write')).toBe(true)
    expect(scopes.contains('identity:read')).toBe(false)
    for (const raw of [
      [],
      Array<string>(51).fill('identity:read'),
      ['identity:delete'],
      ['UPPER:read'],
    ])
      expect(ApiKeyScopes.create(raw).isLeft()).toBe(true)
  })
  it('keeps role grants immutable, deduplicated and sorted by module and role', () => {
    const owner = { module: 'identity', role: 'owner' }
    const viewer = { module: 'identity', role: 'viewer' }
    const catalog = { module: 'catalog', role: 'editor' }
    const roles = RoleAssignments.of([viewer, owner, catalog, owner])
    expect(roles.pairs).toEqual([catalog, owner, viewer])
    expect(roles.equals(RoleAssignments.of([catalog, viewer, owner]))).toBe(true)
    expect(roles.rolesIn('identity')).toEqual(['owner', 'viewer'])
    const revoked = roles.revoke(owner)
    expect(revoked.has('identity', 'owner')).toBe(false)
    expect(roles.has('identity', 'owner')).toBe(true)
    expect(RoleAssignments.empty().isEmpty).toBe(true)
    expect(RoleAssignments.empty().grant(owner).isEmpty).toBe(false)
  })
})
