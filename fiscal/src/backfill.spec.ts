import { createServer } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { HttpOwnerFiscalClient } from './backfill'

let server: ReturnType<typeof createServer>
let client: HttpOwnerFiscalClient
const requests: { path: string; authorization: string | undefined; cache: string | undefined }[] =
  []

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
      cache: request.headers['cache-control'],
    })
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ data: [], nextCursor: null }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server has no port')
  const url = `http://127.0.0.1:${address.port}`
  client = new HttpOwnerFiscalClient({ parties: url, identity: url, catalog: url }, 'tenant-token')
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

it('uses only authenticated owner HTTP exports for profile and classification backfill', async () => {
  const id = '00000000-0000-4000-8000-000000000001'
  await client.listParties(1, id)
  await client.partyRevision(id, 2)
  await client.issuerRevisions()
  await client.issuerRevision(1)
  await client.listClassifications(1, id)
  await client.classificationRevision(id, 3)
  expect(requests.map((request) => request.path)).toEqual([
    `/parties/fiscal-profiles?limit=1&cursor=${id}`,
    `/parties/${id}/fiscal-profile/2`,
    '/workspace/company/fiscal-profiles',
    '/workspace/company/fiscal-profile/1',
    `/items/classifications?limit=1&cursor=${id}`,
    `/items/${id}/classification/3`,
  ])
  expect(requests.every((request) => request.authorization === 'Bearer tenant-token')).toBe(true)
  expect(requests.every((request) => request.cache === 'no-store')).toBe(true)
})
