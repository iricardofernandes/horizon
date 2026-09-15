import { describe, expect, it } from 'vitest'
import { validateExplainQuery } from './query-validator.js'

describe('validateExplainQuery', () => {
  it.each([
    'SELECT id FROM sales_orders WHERE id = $1',
    'SELECT count(*) FROM sales_orders',
    'WITH recent AS (SELECT id FROM sales_orders) SELECT * FROM recent',
  ])('accepts a single read-only statement: %s', (query) => {
    expect(validateExplainQuery(query)).toBe(query)
  })

  it.each([
    'SELECT 1; DELETE FROM sales_orders',
    'INSERT INTO sales_orders (id) VALUES (1)',
    "UPDATE sales_orders SET status = 'cancelled'",
    'DELETE FROM sales_orders',
    'WITH changed AS (DELETE FROM sales_orders RETURNING *) SELECT * FROM changed',
    'SELECT * FROM sales_orders FOR UPDATE',
    'SELECT pg_sleep(1)',
    "SELECT set_config('app.current_tenant', 'x', false)",
    "SELECT nextval('sequence')",
  ])('rejects mutations, locks, multiple statements and unsafe calls: %s', (query) => {
    expect(() => validateExplainQuery(query)).toThrow()
  })
})
