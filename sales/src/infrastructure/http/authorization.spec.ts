import 'reflect-metadata'
import { ForbiddenException, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { SalesRuntime } from '@/main/sales-runtime'
import { SalesAuthGuard } from './authorization'
import { BillingController } from './billing.controller'
import { ContractsController } from './contracts.controller'
import { SalesController } from './sales.controller'

type Role = 'admin' | 'representative' | 'viewer'

function guardFor(roles: readonly { module: string; role: Role }[]) {
  const runtime = {
    accessTokens: {
      verify: (token: string) =>
        token === 'valid'
          ? Promise.resolve({ tenantId: 'tenant', subject: 'ana', roles })
          : Promise.reject(new Error('invalid')),
    },
  } as unknown as SalesRuntime
  return new SalesAuthGuard(runtime, new Reflector())
}

/** The execution context Nest gives the guard for one route of one controller. */
function route(controller: { prototype: object }, method: string, token = 'valid') {
  const handler = (controller.prototype as Record<string, unknown>)[method] as () => unknown
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }) }),
  } as never
}

describe('Sales authorization of the service routes', () => {
  it('lets a viewer read services and billing, and nothing more', async () => {
    const viewer = guardFor([{ module: 'sales', role: 'viewer' }])
    await expect(viewer.canActivate(route(BillingController, 'preview'))).resolves.toBe(true)
    await expect(viewer.canActivate(route(BillingController, 'overview'))).resolves.toBe(true)
    await expect(viewer.canActivate(route(ContractsController, 'billedPeriods'))).resolves.toBe(
      true,
    )
    await expect(viewer.canActivate(route(SalesController, 'serviceOrder'))).resolves.toBe(true)
    for (const [controller, method] of [
      [BillingController, 'start'],
      [BillingController, 'resume'],
      [ContractsController, 'bill'],
      [ContractsController, 'credit'],
      [ContractsController, 'amend'],
      [SalesController, 'openServiceOrder'],
    ] as const)
      await expect(viewer.canActivate(route(controller, method))).rejects.toBeInstanceOf(
        ForbiddenException,
      )
  })

  it('lets a representative or an admin bill, credit and run a month', async () => {
    for (const role of ['representative', 'admin'] as const) {
      const guard = guardFor([{ module: 'sales', role }])
      await expect(guard.canActivate(route(BillingController, 'start'))).resolves.toBe(true)
      await expect(guard.canActivate(route(ContractsController, 'credit'))).resolves.toBe(true)
    }
  })

  it('refuses a role in another module and a token that does not verify', async () => {
    const other = guardFor([{ module: 'fiscal', role: 'admin' }])
    await expect(other.canActivate(route(BillingController, 'preview'))).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    const guard = guardFor([{ module: 'sales', role: 'admin' }])
    await expect(
      guard.canActivate(route(BillingController, 'preview', 'forged')),
    ).rejects.toBeInstanceOf(UnauthorizedException)
  })
})
