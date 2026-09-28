export interface WorkspaceSelection {
  readonly token: string
  readonly expiresAt: Date
}

/** How the account proved itself before choosing a workspace (Phase 67). */
export interface SelectionGrant {
  readonly accountId: string
  readonly amr: readonly string[]
  readonly authTime: Date | null
}

/** Short-lived, one-use authorization to choose a tenant after password verification. */
export abstract class WorkspaceSelections {
  abstract issue(
    accountId: string,
    auth?: { amr: readonly string[]; authTime: Date },
  ): Promise<WorkspaceSelection>
  abstract resolve(token: string): Promise<string | null>
  abstract consume(token: string): Promise<string | null>

  /** The account and how it signed in; a store that keeps only the account says `pwd`. */
  async consumeGrant(token: string): Promise<SelectionGrant | null> {
    const accountId = await this.consume(token)
    return accountId === null ? null : { accountId, amr: ['pwd'], authTime: null }
  }
}
