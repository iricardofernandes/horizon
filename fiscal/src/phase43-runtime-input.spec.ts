import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { HomologationExchangeWorker } from './homologation-exchange-worker'
import { authorizerRuntimeSchema, loadAuthorizerOperations } from './phase43-runtime-input'

const directories: string[] = []
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })))
})

const operation = (name: string) => ({
  operation: name,
  operationNamespace: `http://www.portalfiscal.inf.br/nfe/wsdl/${name}`,
})
const operations = {
  wsdlDigest: 'a'.repeat(64),
  authorization: operation('NFeAutorizacao4'),
  receipt: operation('NFeRetAutorizacao4'),
  protocol: operation('NFeConsultaProtocolo4'),
  status: operation('NFeStatusServico4'),
  event: operation('NFeRecepcaoEvento4'),
}

it('loads reviewed SOAP operations per authorizer and refuses unknown ones', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'horizon-phase43-runtime-'))
  directories.push(directory)
  const path = join(directory, 'svrs-operations.json')
  await writeFile(path, JSON.stringify(operations))
  const loaded = await loadAuthorizerOperations(
    authorizerRuntimeSchema.parse({ SVRS: { operationsPath: path } }),
  )
  expect(loaded.SVRS).toEqual({ operations, trustAnchor: null })
  expect(loaded.SP).toBeUndefined()
  expect(() => authorizerRuntimeSchema.parse({})).toThrow()
  expect(() => authorizerRuntimeSchema.parse({ RJ: { operationsPath: path } })).toThrow()
  await expect(
    loadAuthorizerOperations({ SVRS: { operationsPath: path, trustAnchorPath: path } }),
  ).rejects.toThrow('both path and fingerprint')
})

it('resolves the runner and operations for each exchange it selects', async () => {
  const resume = vi.fn(async () => undefined)
  const factory = vi.fn(async () => ({ runner: { resume }, operations }))
  const worker = new HomologationExchangeWorker(
    { nextPreparedForActive: async () => '00000000-0000-4000-8000-000000000043' },
    factory as never,
  )
  expect(await worker.processOne('00000000-0000-4000-8000-000000000001', 'worker-a')).toBe(true)
  expect(factory).toHaveBeenCalledWith(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000043',
  )
  expect(resume).toHaveBeenCalledWith(
    expect.objectContaining({ exchangeId: '00000000-0000-4000-8000-000000000043' }),
    operations,
  )
})
