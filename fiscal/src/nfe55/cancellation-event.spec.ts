import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  serializeCancellationEvent,
  signCancellationEvent,
  validateCancellationEventSchema,
  verifyCancellationEventSignature,
} from './cancellation-event'
import type { SimulationCredential } from './signature'

const schemaPath = new URL('../../fixtures/official/pl-010d-v1.03.zip', import.meta.url)
const schemaDigest = '45ceefe4dfbbfec93958283b650a2f1e1734784f4770d070b9907754de081d9b'
const event = {
  accessKey: '35260900000000E08G12550010000000011123456783',
  authorizationProtocol: '135260000000001',
  reason: 'Cancelamento solicitado pelo emitente',
  occurredAt: '2026-09-22T17:00:00-03:00',
  lotId: '1',
}
let directory: string
let credential: SimulationCredential

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'horizon-cancellation-credential-'))
  const key = join(directory, 'simulation-only.key.pem')
  const certificate = join(directory, 'simulation-only.cert.pem')
  await promisify(execFile)(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '1',
      '-subj',
      '/CN=Horizon Phase 42 Cancellation Simulation Only',
      '-keyout',
      key,
      '-out',
      certificate,
    ],
    { windowsHide: true },
  )
  credential = { privateKey: await readFile(key), certificate: await readFile(certificate) }
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('signs an alphanumeric-key cancellation and validates the pinned event envelope', async () => {
  const unsigned = serializeCancellationEvent(event)
  expect(serializeCancellationEvent(event)).toEqual(unsigned)
  expect(unsigned.toString()).toContain('<CNPJ>00000000E08G12</CNPJ>')
  const signed = signCancellationEvent(unsigned, credential)
  verifyCancellationEventSignature(signed, credential.certificate)
  await validateCancellationEventSchema({
    xml: signed,
    schemaZip: await readFile(schemaPath),
    expectedZipDigest: schemaDigest,
  })
  expect(() =>
    verifyCancellationEventSignature(
      Buffer.from(signed.toString().replace('Cancelamento solicitado', 'Cancelamento recusado')),
      credential.certificate,
    ),
  ).toThrow('signature is invalid')
})

it('checks cancellation-specific fields before the generic schema skips them', () => {
  expect(() => serializeCancellationEvent({ ...event, authorizationProtocol: 'x' })).toThrow()
  expect(() => serializeCancellationEvent({ ...event, reason: 'curta' })).toThrow()
  expect(() =>
    serializeCancellationEvent({ ...event, accessKey: `33${event.accessKey.slice(2)}` }),
  ).toThrow('jurisdiction')
  expect(serializeCancellationEvent({ ...event, reason: 'Erro & correção' }).toString()).toContain(
    '<xJust>Erro &amp; correção</xJust>',
  )
})
