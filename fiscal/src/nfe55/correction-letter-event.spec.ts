import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { signNfeEvent, validateNfeEventSchema, verifyNfeEventSignature } from './cancellation-event'
import {
  CORRECTION_LETTER_CONDITION,
  serializeCorrectionLetterEvent,
} from './correction-letter-event'
import type { SimulationCredential } from './signature'

const schemaPath = new URL('../../fixtures/official/pl-010d-v1.03.zip', import.meta.url)
const schemaDigest = '45ceefe4dfbbfec93958283b650a2f1e1734784f4770d070b9907754de081d9b'
const letter = {
  accessKey: '35260900000000E08G12550010000000011123456783',
  sequence: 2,
  text: 'Corrige o complemento do endereço: Bloco B & fundos.',
  occurredAt: '2026-09-26T15:00:00-03:00',
  lotId: '7',
}
let directory: string
let credential: SimulationCredential

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'horizon-correction-credential-'))
  const key = join(directory, 'simulation-only.key.pem')
  const certificate = join(directory, 'simulation-only.cert.pem')
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '1',
    '-subj',
    '/CN=Horizon Phase 45 Correction Letter Simulation Only',
    '-keyout',
    key,
    '-out',
    certificate,
  ])
  credential = { privateKey: await readFile(key), certificate: await readFile(certificate) }
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('signs a sequenced correction letter and validates the pinned event envelope', async () => {
  const xml = serializeCorrectionLetterEvent(letter)
  const text = xml.toString()
  expect(text).toContain(`Id="ID110110${letter.accessKey}02"`)
  expect(text).toContain('<nSeqEvento>2</nSeqEvento>')
  expect(text).toContain('<descEvento>Carta de Correcao</descEvento>')
  expect(text).toContain('Bloco B &amp; fundos.')
  expect(text).toContain(`<xCondUso>${CORRECTION_LETTER_CONDITION}</xCondUso>`)
  const signed = signNfeEvent(xml, credential)
  verifyNfeEventSignature(signed, credential.certificate)
  await validateNfeEventSchema({
    xml: signed,
    schemaZip: await readFile(schemaPath),
    expectedZipDigest: schemaDigest,
  })
  expect(() =>
    verifyNfeEventSignature(
      Buffer.from(signed.toString().replace('Bloco B', 'Bloco C')),
      credential.certificate,
    ),
  ).toThrow('signature is invalid')
})

it('refuses a short text, a sequence outside 1 to 20 and an invalid key', () => {
  expect(() => serializeCorrectionLetterEvent({ ...letter, text: 'curto demais' })).toThrow()
  expect(() => serializeCorrectionLetterEvent({ ...letter, sequence: 21 })).toThrow()
  expect(() =>
    serializeCorrectionLetterEvent({
      ...letter,
      accessKey: '35260900000000E08G12550010000000011123456780',
    }),
  ).toThrow('Invalid correction letter key')
})
