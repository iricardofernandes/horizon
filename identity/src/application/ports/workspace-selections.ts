export interface WorkspaceSelection {
  readonly token: string
  readonly expiresAt: Date
}

/** Short-lived, one-use authorization to choose a tenant after password verification. */
export abstract class WorkspaceSelections {
  abstract issue(accountId: string): Promise<WorkspaceSelection>
  abstract resolve(token: string): Promise<string | null>
  abstract consume(token: string): Promise<string | null>
}
