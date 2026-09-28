# 61. Access hardening stays in Identity: invitations, MFA, passkeys and visible sessions

- Status: accepted; implemented in Phase 67 ([evidence](../readiness-phase67-evidence.md)); passkey-only sign-in is left for later.
- Date: 2026-09-27

## Context

Today an administrator creates a user with a password they chose and must pass on, and a
password is the only factor. The session model is sound: rotating refresh-token families
with reuse detection (ADR 0020) and a `jti` denylist (ADR 0021). But a user cannot see or
end their own sessions.

An ERP that moves money and issues fiscal documents needs more than a password for the
people who can do that.

## Decision

1. **Invitations replace administrator-chosen passwords.**
   - An administrator invites an email with roles.
   - The invitation link is single use and valid for 72 hours. The invited person sets
     their own password.
   - Invitations are revoked or resent, and every step is audited.
   - An outbound mail port sends the link. The local stack uses Mailpit.
2. **Second factors:**
   - TOTP (RFC 6238), with ten recovery codes that are stored hashed and each used once;
   - passkeys (WebAuthn), as a second factor, or as the only factor when the workspace
     allows it.
3. **The workspace MFA policy** is one of `off`, `admins` (anyone holding an `admin` or
   `owner` role in any module) or `everyone`, with a grace period for enrollment.
4. **Tokens say how the user signed in.** An access token carries `amr`.
   - A route that requires MFA refuses a token without it.
   - Step-up re-authentication is required to create API keys, change roles and reset a
     factor.
5. **Sessions.**
   - Each refresh-token family is a visible session, with device label, IP prefix, created
     at and last used.
   - A user ends their own sessions. An administrator ends anyone's.
   - Ending a session also denylists its live access tokens.
6. **Recovery.** A locked-out sole administrator is recovered by an operator procedure in
   the runbook. It is audited and needs two operators. No backdoor exists in the product.

## Consequences

- Identity gains its first outbound integration (mail), behind a port with a mock.
- Every module keeps verifying tokens as today. Only routes that declare an MFA
  requirement read `amr`.
- **Tests.** A security drill (brute force, replayed codes, revoked sessions, expired
  invitations) becomes part of the release evidence.

## Alternatives considered

- **SSO (SAML/OIDC) first.** Valuable for larger customers, and out of Phase M's scope. It
  does not remove the need for MFA on local accounts.
- **SMS codes.** Weak against SIM swapping, and it needs a paid provider.
- **An MFA service of its own.** It would split the one decision that must be atomic:
  whether this person may have a token.
