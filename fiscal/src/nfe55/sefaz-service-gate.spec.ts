import { expect, it } from 'vitest'
import { SefazServiceGate } from './sefaz-service-gate'

it('bounds concurrency independently for each SEFAZ service', async () => {
  const gate = new SefazServiceGate({
    maximumConcurrent: 1,
    failureThreshold: 2,
    cooldownMilliseconds: 1_000,
  })
  let release: (() => void) | undefined
  const first = gate.run(
    'authorization',
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  await expect(gate.run('authorization', async () => undefined)).rejects.toThrow(
    'concurrency limit reached',
  )
  await expect(gate.run('status', async () => 'available')).resolves.toBe('available')
  release?.()
  await first
  await expect(gate.run('authorization', async () => 'done')).resolves.toBe('done')
})

it('opens after repeated failures, waits for cooldown, and resets on success', async () => {
  let time = 100
  const gate = new SefazServiceGate(
    { maximumConcurrent: 1, failureThreshold: 2, cooldownMilliseconds: 1_000 },
    () => time,
  )
  const fail = () =>
    gate.run('authorization', async () => Promise.reject(new Error('connection lost')))
  await expect(fail()).rejects.toThrow('connection lost')
  await expect(fail()).rejects.toThrow('connection lost')
  let calls = 0
  await expect(
    gate.run('authorization', async () => {
      calls += 1
    }),
  ).rejects.toThrow('circuit is open')
  expect(calls).toBe(0)
  await expect(gate.run('receipt', async () => 'independent')).resolves.toBe('independent')
  time = 1_100
  await expect(gate.run('authorization', async () => 'recovered')).resolves.toBe('recovered')
  await expect(fail()).rejects.toThrow('connection lost')
  await expect(gate.run('authorization', async () => 'still allowed')).resolves.toBe(
    'still allowed',
  )
})
