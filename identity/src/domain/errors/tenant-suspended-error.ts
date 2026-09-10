import { UseCaseError } from '@/core/errors/use-case-error'

export class TenantSuspendedError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/tenant-suspended'
  readonly title = 'Tenant suspended'

  constructor() {
    super('this tenant is suspended')
  }
}
