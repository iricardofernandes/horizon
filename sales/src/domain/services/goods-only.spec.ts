import { describe, expect, it } from 'vitest'
import { goodsOnly } from './goods-only'

const good = { lineId: 'l1', itemId: 'i-good' }
const service = { lineId: 'l2', itemId: 'i-service' }
const unknown = { lineId: 'l3', itemId: 'i-unknown' }
const kinds = new Map([
  ['i-good', 'product' as const],
  ['i-service', 'service' as const],
])

describe('a sales order is a goods order', () => {
  it('accepts goods and items whose kind is not known yet', () => {
    expect(goodsOnly([good, unknown], kinds, 'order').isRight()).toBe(true)
  })

  it('refuses a service line and names it', () => {
    const refused = goodsOnly([good, service], kinds, 'order')
    expect(refused.isLeft()).toBe(true)
    expect(refused.value).toMatchObject({
      message: expect.stringMatching(/^service items are delivered by a service order.*l2/),
    })
  })

  it('says a proposal converts its services to a service order', () => {
    const refused = goodsOnly([service], kinds, 'proposal')
    expect(refused.value).toMatchObject({
      message: expect.stringMatching(/^service lines of a proposal/),
    })
  })
})
