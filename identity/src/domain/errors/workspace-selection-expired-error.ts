import { UseCaseError } from '@/core/errors/use-case-error'

export class WorkspaceSelectionExpiredError extends UseCaseError {
  readonly type = 'https://horizon.dev/problems/workspace-selection-expired'
  readonly title = 'Workspace selection expired'

  constructor() {
    super('the workspace selection is invalid or expired; sign in again')
  }
}
