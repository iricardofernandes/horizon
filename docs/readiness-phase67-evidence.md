# Phase 67 — evidence: invitations, MFA, passkeys and sessions

Status: **delivered on 2026-09-28** (local runs between 15:30 and 16:15 UTC).
Plan: [readiness-phase67-implementation-plan.md](readiness-phase67-implementation-plan.md).
Decision: [ADR 0061](adr/0061-access-hardening-stays-in-identity.md).
Drill record: [drills/2026-09-28-phase67-security-drill.json](drills/2026-09-28-phase67-security-drill.json).

## What was delivered

- **Identity.**
  - **Invitations:** invite, list, resend and revoke, and the public lookup and accept.
    They are mailed through the SMTP port, which is Mailpit in the local stack.
  - **Second factors on the global account:**
    - TOTP, with a sealed secret, and no step used twice;
    - passkeys, through `@simplewebauthn/server`;
    - ten recovery codes, kept as digests.
  - **Sign-in:** a challenge after the password, then a code or a passkey. Five wrong
    answers in 15 minutes lock the second factor for 15 minutes.
  - **Tokens** gain `sid`, `amr` and `auth_time`.
  - **Step-up,** and `@RequireRecentAuth()` on:
    - API keys;
    - new users and roles;
    - invitations;
    - removing a factor, and new recovery codes;
    - the MFA policy;
    - ending another user's sessions.
  - **The workspace MFA policy,** with a grace period and, after it, an enrollment token.
  - **Sessions:** device, IP prefix, `amr`, `auth_time`, and the live `jti`s of each
    family. Ending a session denylists them.
  - Every change goes to the tenant's audit chain, without codes, secrets or tokens.
  - **Migration `0007_access_hardening`** adds:
    - `account_factors` and `account_recovery_codes`, scoped to the account;
    - `invitations`;
    - a digest-only `invitation_directory`;
    - the policy columns on `tenants`.
- **Revocation before roles.** Identity and Catalog now refuse a revoked token before
  weighing its roles.
- **The web.**
  - **Sign-in:** the second-factor step (a code, a recovery code or a passkey), and
    `/enroll` when the policy requires one.
  - **`/accept-invitation`,** through `/api/invitation`, since the person is not signed in.
  - **`/app/settings/security`:** TOTP with a QR code and recovery codes, passkeys, and
    sessions.
  - **People:** invite, the invitations list (resend and revoke), and a user's sessions.
  - **Workspace settings:** the MFA policy panel.
  - **Step-up:** a dialog that retries the action once the person has confirmed.
  - All of it is in pt-BR and English.
- **The platform.**
  - Mailpit is in Compose: SMTP on 1025, the inbox on 8025.
  - Identity gains `MFA_SEAL_SECRET`, `SMTP_URL`, `MAIL_FROM`, `WEB_URL` and
    `WEBAUTHN_RP_ID`.
  - `mint-dev-token` issues `amr` and `auth_time`.

## Exit criteria: the security drill

`node scripts/phase67-drill.mjs`, through Kong, stored in
`docs/drills/2026-09-28-phase67-security-drill.json`, `"passed": true`.

| Check | Evidence |
|---|---|
| Brute force on TOTP locks out | Wrong codes answered `401, 401, 401`, then `429, 429, 429`. The right code while locked was still `429`. The lock came at the fourth attempt, because the replayed recovery code just before was the first wrong answer of the window |
| A replayed recovery code is refused | First use `200`, the same code again `401` |
| A revoked session's access token is refused within its lifetime | The token had 900 seconds left. **Before revocation:** Identity `200`, Catalog `403` (valid token, no Catalog role). **After:** Identity `401`, Catalog `401`, and its refresh token `401` |
| An expired or used invitation is refused | Delivered through Mailpit. First accept `200`, second `410`. An invitation made expired: accept `410` and lookup `410` |

The first run of the drill failed the third check. Catalog answered `403`, not `401`,
because it weighed roles before the denylist. After the fix above it passed.

## Browser run (Chromium)

1. An owner invited a guest through the API. The link came from Mailpit.
2. **`/accept-invitation`** showed "Join Browser 67" and the masked email. The guest set a
   password and saw "All set".
3. **First sign-in:** email, password, the workspace, then `/app`.
4. **Security, TOTP:** "Add an authenticator app" showed the QR code and a 32-character
   secret. A code computed in the page from that secret confirmed it, and ten recovery
   codes appeared.
5. **Security, passkey:** a virtual WebAuthn authenticator (CTAP2, internal) was added
   through the DevTools protocol. "Add a passkey" ended with "Passkey added.", and the
   authenticator held one credential. The factors listed were "Authenticator app" and
   "Passkey".
6. **Sign-in with the app:** after signing out, the password step asked "Confirm it is
   you". A wrong code was refused, the next valid code let the guest in, and the
   workspace opened `/app`.
7. **Sign-in with the passkey:** after signing out, "Use a passkey" signed the guest in.
8. **The sessions list:** one session, "Chrome on Linux", with a second factor, marked as
   this session. Signing out had ended the earlier ones.

## Tests

- **Identity unit:** 239 tests, 15 of them new. Coverage is 95.8% of statements, and 100%
  of `domain/mfa`. They cover:
  - TOTP against the RFC 6238 vectors, drift and reuse;
  - recovery codes and the lockout;
  - passkeys;
  - the sign-in challenge and the enrollment token;
  - the MFA policy at the workspace choice (inside and after the grace period);
  - step-up and `recentlyAuthenticated`;
  - sessions and their live tokens;
  - invitations: accept once, expiry, resend, revoke, an existing account's password,
    and failed mail.
- **Identity e2e:** 50 tests, 3 of them new (`access.e2e-spec.ts`), over HTTP against
  PostgreSQL and Redis:
  - a second factor, recovery codes used once, and the lockout;
  - step-up and a revoked session;
  - invitations and the policy after its grace.
- **Catalog:** 92 unit tests and 40 e2e, after the guard change.
- **Web:** 103 unit tests; 4 are new for the access helpers. The copy check passes.

## Findings along the way

- **A revoked token must read the same everywhere.** Weighing roles first told a revoked
  token without the role "forbidden" rather than "invalid". It is fixed in Identity and
  Catalog; Fiscal already checked revocation first.
- **Proxies hide the client's network.** Identity now trusts private-network proxies for
  `X-Forwarded-For`. Locally, the browser talks straight to the web server, so the
  sessions list shows the Docker network (`172.23.0.0/24`). Behind a real edge proxy, it
  shows the client's.
- **Lockout counts every wrong answer about an account,** a replayed recovery code
  included. The drill states it rather than hiding it.

## Verification

- `make check`: passed.
- Identity unit (239) and e2e (50), and Catalog unit (92) and e2e (40): passed.
- The drill passed against the rebuilt Identity, Catalog and web.
