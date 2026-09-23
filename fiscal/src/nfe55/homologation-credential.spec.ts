import { execFile } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, expect, it } from 'vitest'
import { loadHomologationCredential } from './homologation-credential'
import { type SefazEndpoints, SefazHomologationTransport } from './sefaz-transport'

const directories: string[] = []

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
})

async function credential() {
  const directory = await mkdtemp(join(tmpdir(), 'horizon-sefaz-credential-'))
  directories.push(directory)
  const certificatePath = join(directory, 'certificate.pem')
  const privateKeyPath = join(directory, 'private-key.pem')
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=Horizon Homologation Transport Test Only',
    '-keyout',
    privateKeyPath,
    '-out',
    certificatePath,
  ])
  const parsed = new X509Certificate(await readFile(certificatePath))
  return {
    certificatePath,
    privateKeyPath,
    expectedFingerprint: createHash('sha256').update(parsed.raw).digest('hex'),
  }
}

it('loads only a matching, currently valid certificate and key', async () => {
  const input = await credential()
  const loaded = await loadHomologationCredential(input)
  expect(loaded.fingerprint).toBe(input.expectedFingerprint)
  expect(loaded.validUntil).toBeGreaterThan(Date.now() + loaded.minimumRemainingMilliseconds)
  await expect(
    loadHomologationCredential({ ...input, expectedFingerprint: '0'.repeat(64) }),
  ).rejects.toThrow('fingerprint mismatch')
  await expect(
    loadHomologationCredential({ ...input, minimumRemainingMilliseconds: 3 * 86_400_000 }),
  ).rejects.toThrow('not currently valid')
  const other = await credential()
  await expect(
    loadHomologationCredential({ ...input, privateKeyPath: other.privateKeyPath }),
  ).rejects.toThrow('do not match')
})

it('permits only the pinned SP homologation service paths', async () => {
  const input = await credential()
  const loaded = await loadHomologationCredential(input)
  const root = 'https://homologacao.nfe.fazenda.sp.gov.br/ws/'
  const endpoints: SefazEndpoints = {
    authorization: `${root}nfeautorizacao4.asmx`,
    receipt: `${root}nferetautorizacao4.asmx`,
    protocol: `${root}nfeconsultaprotocolo4.asmx`,
    status: `${root}nfestatusservico4.asmx`,
    event: `${root}nferecepcaoevento4.asmx`,
  }
  expect(() => new SefazHomologationTransport(endpoints, loaded)).not.toThrow()
  await expect(
    new SefazHomologationTransport(endpoints, {
      ...loaded,
      validUntil: Date.now(),
    }).send('authorization', Buffer.from('<request/>')),
  ).rejects.toThrow('no longer valid')
  expect(
    () =>
      new SefazHomologationTransport(
        { ...endpoints, authorization: endpoints.authorization.replace('homologacao.', '') },
        loaded,
      ),
  ).toThrow('Unapproved')
  expect(
    () =>
      new SefazHomologationTransport(
        { ...endpoints, event: endpoints.event.replace('https:', 'http:') },
        loaded,
      ),
  ).toThrow('Unapproved')
})
