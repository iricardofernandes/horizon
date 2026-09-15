# 38. Global account before workspace selection

- Status: accepted
- Date: 2026-09-15
- Supersedes: [0037](0037-tenant-directory-before-authentication.md) for interactive login

## Context

ADR 0037 required a workspace slug together with email and password at login. That makes
tenancy part of the credential prompt even though a person may belong to several
workspaces. It also prevents the product from showing the memberships already available
to an authenticated account.

Tenant isolation must remain fail-closed: proving a password cannot mint a tenant token
until the account explicitly chooses one of its memberships. Existing installations also
already store credentials on tenant-scoped `users`, so the transition cannot invalidate
those accounts.

## Decision

Interactive authentication has two stages:

1. `POST /auth/login` verifies only email and password. It returns an opaque, five-minute
   selection token and the account's workspace projection. It does not mint an access or
   refresh token.
2. `POST /auth/workspace` consumes that token exactly once, verifies the selected
   account-to-tenant membership under RLS, and only then opens the ordinary tenant-scoped
   session. `POST /auth/workspaces` can refresh the projection while the token is valid.

Credentials live in a global `accounts` aggregate. `account_directory` maps a keyed HMAC
of normalized email to account id; it stores no plaintext personal data.
`account_memberships` is a minimal selection projection. Roles, user status and personal
data remain on tenant-scoped `users`, and selecting a workspace rechecks both tenant and
user state before minting claims.

Existing users migrate lazily on their first successful account-first login. Memberships
with the same email are linked only when the supplied password verifies against each
legacy credential; equal email alone is never enough. No legacy row is deleted. The
selection token is random, stored only as a digest in Redis, held in an HttpOnly cookie by
the web BFF, expires after five minutes and is consumed on selection.

API-key authentication remains explicitly tenant-scoped and is unchanged.

## Consequences

The login form asks for email and password only. An authenticated account sees its
workspaces next, and a tenant claim does not exist before that choice. A stolen selection
token has a short lifetime, is one-use and can select only a server-provided membership.

During the lazy migration window, an unknown email may require bounded scans of the
minimal tenant directory to locate encrypted tenant users. Once an account directory
entry exists, invalid passwords do not perform that scan. A future offline backfill can
remove the legacy lookup without changing the HTTP contract.

New account-management flows must treat email as a global identity and attach a tenant
membership to the existing account instead of creating an independent credential with
the same email.

## Alternatives considered

Keeping workspace on the login form preserves the old implementation but exposes an
infrastructure concept before identity is known. Issuing a global bearer token before
selection broadens its authority and complicates every downstream verifier. Linking all
same-email rows without password proof risks joining unrelated legacy identities.
