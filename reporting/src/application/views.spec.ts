import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type SavedView, viewProblem, visibleTo } from '@/domain/views'
import { ManageViewsUseCase, ViewStore } from './views'

class MemoryViews extends ViewStore {
  readonly held: SavedView[] = []
  async list(_: string, userId: string, screen: string | null) {
    return this.held.filter((v) => visibleTo(v, userId) && (!screen || v.screen === screen))
  }
  async find(_: string, viewId: string) {
    return this.held.find((v) => v.viewId === viewId) ?? null
  }
  async insert(_: string, view: SavedView) {
    this.held.push(view)
  }
  async update(_: string, view: SavedView) {
    this.held[this.held.findIndex((v) => v.viewId === view.viewId)] = view
  }
  async remove(_: string, viewId: string) {
    this.held.splice(
      this.held.findIndex((v) => v.viewId === viewId),
      1,
    )
  }
}

const tenantId = randomUUID()
const clock = { now: () => new Date('2026-09-28T12:00:00.000Z') }
const input = {
  screen: 'financial.payables',
  name: 'Vencendo esta semana',
  query: 'view=due-soon&search=energia',
  columns: ['dueOn', 'party', 'open'],
  shared: false,
}

describe('saved views', () => {
  it('keeps a view for its owner, and shows a shared one to everyone', async () => {
    const views = new ManageViewsUseCase(new MemoryViews(), clock)
    const mine = await views.create(tenantId, 'ana', input)
    const shared = await views.create(tenantId, 'ana', { ...input, name: 'Todos', shared: true })
    expect(mine.isRight() && shared.isRight()).toBe(true)
    expect((await views.list(tenantId, 'ana', 'financial.payables')).length).toBe(2)
    expect((await views.list(tenantId, 'bruno', null)).map((v) => v.name)).toEqual(['Todos'])
    const again = await views.create(tenantId, 'ana', input)
    expect(again.isLeft() && again.value.title).toBe('Conflict')
  })

  it('lets only the owner change or delete it; a private one does not exist for others', async () => {
    const views = new ManageViewsUseCase(new MemoryViews(), clock)
    const shared = await views.create(tenantId, 'ana', { ...input, shared: true })
    const privateOne = await views.create(tenantId, 'ana', { ...input, name: 'Minha' })
    if (shared.isLeft() || privateOne.isLeft()) throw new Error('not created')
    const byOther = await views.update(tenantId, 'bruno', shared.value.viewId, { name: 'x' })
    expect(byOther.isLeft() && byOther.value.title).toBe('Forbidden')
    const hidden = await views.remove(tenantId, 'bruno', privateOne.value.viewId)
    expect(hidden.isLeft() && hidden.value.title).toBe('Resource not found')
    const renamed = await views.update(tenantId, 'ana', shared.value.viewId, {
      name: '  Semana  ',
      shared: false,
    })
    expect(renamed.isRight() && renamed.value).toMatchObject({ name: 'Semana', shared: false })
    expect((await views.remove(tenantId, 'ana', privateOne.value.viewId)).isRight()).toBe(true)
    const bad = await views.update(tenantId, 'ana', shared.value.viewId, { query: '?x=1' })
    expect(bad.isLeft() && bad.value.title).toBe('Invalid input')
  })

  it('refuses a screen, name, query or columns it cannot keep', () => {
    expect(viewProblem(input)).toBeNull()
    expect(viewProblem({ ...input, screen: 'payables' })).toMatch(/screen/)
    expect(viewProblem({ ...input, name: ' ' })).toMatch(/name/)
    expect(viewProblem({ ...input, query: 'x'.repeat(1001) })).toMatch(/query/)
    expect(viewProblem({ ...input, query: 'a=\u0001' })).toMatch(/control/)
    expect(viewProblem({ ...input, columns: ['bad column'] })).toMatch(/columns/)
  })
})
