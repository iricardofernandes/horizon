import { describe, expect, it } from 'vitest'
import { checkEndpoint, EndpointRefusedError, isPublicAddress } from './endpoint'

describe('where a webhook may go (Phase 90)', () => {
  it('takes public unicast addresses and nothing reserved', () => {
    for (const address of ['93.184.215.14', '8.8.8.8', '2606:4700:4700::1111'])
      expect(isPublicAddress(address)).toBe(true)
    for (const address of [
      '10.0.0.5',
      '172.16.4.1',
      '172.31.255.255',
      '192.168.1.10',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '198.18.0.1',
      '192.0.2.10',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:10.0.0.5',
      '::ffff:8.8.8.8',
      '64:ff9b::a00:5',
      '2001:db8::1',
      'ff02::1',
      'not-an-address',
    ])
      expect(isPublicAddress(address), address).toBe(false)
  })

  it('takes HTTPS to a name or a public address', () => {
    expect(checkEndpoint('https://hooks.example.com/horizon', false).hostname).toBe(
      'hooks.example.com',
    )
    expect(checkEndpoint('https://93.184.215.14/hooks', false).hostname).toBe('93.184.215.14')
  })

  it('refuses plain HTTP, credentials and any address outside the public internet', () => {
    for (const url of [
      'http://hooks.example.com/horizon',
      'https://user:secret@hooks.example.com/horizon',
      'https://10.0.0.5/hooks',
      'https://169.254.169.254/latest/meta-data',
      'https://[fd00::1]/hooks',
      'https://[::ffff:7f00:1]/hooks',
      'https://localhost:3005/hooks',
      'http://127.0.0.1:3940/events',
      'https://127.1/hooks',
      'ftp://hooks.example.com/horizon',
      'not a url',
    ])
      expect(() => checkEndpoint(url, false), url).toThrow(EndpointRefusedError)
  })

  it('lets a development stack call its own loopback over HTTP, and only that', () => {
    expect(checkEndpoint('http://127.0.0.1:3940/events', true).port).toBe('3940')
    expect(checkEndpoint('http://localhost:3940/events', true).hostname).toBe('localhost')
    expect(checkEndpoint('http://[::1]:3940/events', true).hostname).toBe('[::1]')
    expect(() => checkEndpoint('http://10.0.0.5/events', true)).toThrow(EndpointRefusedError)
    expect(() => checkEndpoint('http://hooks.example.com/events', true)).toThrow(
      EndpointRefusedError,
    )
  })
})
