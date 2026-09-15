import { describe, expect, it, vi } from 'vitest'
import { PostgresSource } from './postgres.js'

class ObservablePostgresSource extends PostgresSource {
  readonly driver = vi.fn(
    async (_module: string, _query: string): Promise<unknown> => [{ Plan: {} }],
  )
  protected override executeExplain(module: string, query: string): Promise<unknown> {
    return this.driver(module, query)
  }
}

describe('PostgresSource explain boundary', () => {
  it('rejects an unsafe statement before invoking the database driver', async () => {
    const source = new ObservablePostgresSource(
      new Map([['sales', 'postgres://debug@localhost/sales']]),
    )
    await expect(source.explain('sales', 'DELETE FROM sales_orders')).rejects.toThrow(/SELECT/)
    expect(source.driver).not.toHaveBeenCalled()
    await source.close()
  })

  it('passes a validated SELECT to the narrow explain function', async () => {
    const source = new ObservablePostgresSource(
      new Map([['sales', 'postgres://debug@localhost/sales']]),
    )
    await expect(source.explain('sales', 'SELECT count(*) FROM sales_orders')).resolves.toEqual([
      { Plan: {} },
    ])
    expect(source.driver).toHaveBeenCalledOnce()
    await source.close()
  })
})
