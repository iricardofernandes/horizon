import { type Either, left, right } from '@/core/either'
import { ConflictError } from '@/core/errors/errors/conflict-error'
import { InvalidInputError } from '@/core/errors/errors/invalid-input-error'
import { ResourceNotFoundError } from '@/core/errors/errors/resource-not-found-error'
import { Customer } from '@/domain/entities/customer'
import {
  CustomerEmail,
  CustomerName,
  CustomerPhone,
  TaxId,
} from '@/domain/value-objects/sales-values'
import type { Clock } from '../ports/clock'
import type { SalesUnitOfWork } from '../ports/unit-of-work'

export class CreateCustomerUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(request: {
    tenantId: string
    name: string
    taxId: string
    email: string
    phone: string
    address: string
  }): Promise<Either<InvalidInputError | ConflictError, { customerId: string }>> {
    const name = CustomerName.create(request.name)
    if (name.isLeft()) return left(name.value)
    const taxId = TaxId.create(request.taxId)
    if (taxId.isLeft()) return left(taxId.value)
    const email = CustomerEmail.create(request.email)
    if (email.isLeft()) return left(email.value)
    const phone = CustomerPhone.create(request.phone)
    if (phone.isLeft()) return left(phone.value)
    const address = request.address.trim().replace(/\s+/g, ' ')
    if (address.length < 5 || address.length > 500)
      return left(new InvalidInputError('/address', 'must contain between 5 and 500 characters'))
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      if (await scope.customers.findByTaxId(taxId.value.value))
        return left(new ConflictError('customer tax identifier already exists'))
      const customer = Customer.create({
        tenantId: request.tenantId,
        name: name.value,
        taxId: taxId.value,
        email: email.value,
        phone: phone.value,
        address,
        now: this.clock.now(),
      })
      await scope.customers.create(customer)
      return right({ customerId: customer.id.toString() })
    })
  }
}

export class EraseCustomerUseCase {
  constructor(
    private readonly unitOfWork: SalesUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(request: {
    tenantId: string
    customerId: string
  }): Promise<Either<ResourceNotFoundError, void>> {
    return this.unitOfWork.inTenant(request.tenantId, async (scope) => {
      const customer = await scope.customers.findById(request.customerId)
      if (!customer) return left(new ResourceNotFoundError('customer was not found'))
      customer.erase(this.clock.now())
      await scope.customers.erase(customer)
      return right(undefined)
    })
  }
}
