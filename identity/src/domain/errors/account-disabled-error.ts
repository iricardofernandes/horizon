import { UseCaseError } from '@/core/errors/use-case-error'

/**
 * Returned only **after** the password has been verified.
 *
 * Telling someone who has proved they own the account why they cannot get in is helpful;
 * telling someone who has not is an enumeration oracle. The ordering is the security
 * property, not the message.
 */
export class AccountDisabledError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/account-disabled'
  readonly title = 'Account disabled'

  constructor(detail = 'this account has been disabled') {
    super(detail)
  }
}
