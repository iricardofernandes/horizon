/**
 * Slug → tenant id, and **deliberately outside tenant scope** (ADR 0037).
 *
 * Every other read in this module happens inside a transaction that has already declared
 * which tenant it is for. This one cannot: it is the lookup that *establishes* the
 * tenant, performed before `app.current_tenant` is set, by an unauthenticated caller who
 * has typed a workspace handle into a login form.
 *
 * So it is a separate, unscoped table holding exactly two columns and nothing else. Not
 * an RLS exception on `tenants` — an exception would apply to the tenant's name, its
 * timezone and every column added later, and would have to be re-justified each time. A
 * separate table with nothing personal in it needs justifying once.
 */
export abstract class TenantDirectory {
  abstract resolve(slug: string): Promise<string | null>

  /** Registered inside the same transaction as the tenant row it points at. */
  abstract register(slug: string, tenantId: string): Promise<void>

  abstract slugExists(slug: string): Promise<boolean>
}
