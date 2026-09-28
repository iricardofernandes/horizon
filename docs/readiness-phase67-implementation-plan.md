# Phase 67 — Invitations, MFA, passkeys and sessions

Status: **delivered on 2026-09-28** ([evidence](readiness-phase67-evidence.md)). This is the execution record for
[Phase 67 of the production readiness plan](production-readiness-implementation-plan.md#67--invitations-mfa-passkeys-and-sessions).
Decision: [ADR 0061](adr/0061-access-hardening-stays-in-identity.md). Extends ADR 0020
(refresh families) and ADR 0021 (the denylist).

## Result

After this phase:
- **Joining a workspace.** An administrator invites a person by email, with roles. The
  person follows a single-use link, valid for 72 hours, and sets their own password.
  Locally, the mail lands in Mailpit.
- **A second factor.** A person can add:
  - TOTP, from an authenticator app, with ten recovery codes;
  - passkeys.

  Once they have one, signing in asks for it after the password.
- **Step-up.** Sensitive actions ask to confirm again, with the password and the second
  factor: API keys, roles, removing a factor, new recovery codes, and the MFA policy.
- **The workspace MFA policy:** `off`, `admins` or `everyone`, with a grace period.
- **Sessions.** Every sign-in is a session the person can see, with device, IP prefix,
  when it started and when it was last used. They can end one, or all the others. An
  administrator can end a user's sessions. Ending a session also kills its live access
  tokens.
- **A security drill** (`scripts/phase67-drill.mjs`) proves the defences, and stores its
  results.

## Starting point

- **Signing in** has two steps:
  1. email and password verify a global **account**, and answer a one-use **selection
     token**, kept in Redis;
  2. choosing a workspace opens a **refresh family** in Redis and mints an access token.
- **Access tokens** carry `sub`, `tenant_id`, `roles` and `jti`. Modules verify them
  locally. Identity, Catalog and Fiscal also check the `jti` denylist, and the
  denylist-by-subject.
- **Logout** deletes the family and denylists only the token that asked. Other tokens of
  that family live on, up to 15 minutes.
- **Users are created by an owner, with a password the owner chose** (`POST /users`).
  A user's account is linked on its first sign-in, when its password matches (the
  "legacy membership" reconciliation).
- **Identity roles:**
  - `owner` manages everything;
  - `admin` reads users, the audit log and data subjects.
- Identity sends no mail.

## Decisions frozen by this plan

1. **Tokens say how and when the person signed in.** An access token gains three claims:
   - `sid`: the refresh family, which is the session;
   - `amr`: `pwd`, plus `otp` (TOTP), `hwk` (passkey) or `rec` (recovery code);
   - `auth_time`: when the person last proved who they are.

   A refresh keeps `amr` and `auth_time`, and only a step-up renews them. Modules that
   do not read the new claims are unaffected.
2. **A session keeps the tokens it issued.**
   - Each family has a Redis set of its live `jti`s, each with its expiry, pruned as they
     expire.
   - Ending a session denylists every live one. Catalog and Fiscal already check `jti`,
     so they refuse a revoked session's token without any change.
   - The family also keeps its device label (from the User-Agent), the IP prefix (`/24`
     or `/48`), `amr`, `auth_time`, and when it was created and last used.
3. **TOTP (RFC 6238).**
   - SHA-1, 6 digits and 30 seconds, with one step of drift either way.
   - The secret is 20 random bytes, sealed with Identity's secret box.
   - Enrollment is two calls:
     1. start: the secret and an `otpauth://` URI, which the web shows as a QR code;
     2. confirm with a code: the factor becomes active, and ten recovery codes are shown
        once.
   - A time step once used is refused again (`last_used_step`), so a code cannot be
     replayed.
4. **Recovery codes.**
   - Ten codes of 10 characters (`xxxxx-xxxxx`, base32), stored as keyed digests.
   - Each is used once. Regenerating them replaces all ten.
5. **Passkeys (WebAuthn),** with `@simplewebauthn/server` in Identity and
   `@simplewebauthn/browser` in the web.
   - The relying party is `WEBAUTHN_RP_ID`, and the origin `WEB_URL`.
   - A passkey is a second factor after the password. Passkey-only sign-in waits for
     later: see the revisions.
6. **Signing in with a second factor.**
   - The password step answers a **challenge**, not a selection, when the account has an
     active factor: `{ mfaRequired: true, challengeToken, methods }`. The challenge lives
     5 minutes in Redis.
   - Then one of:
     - `POST /auth/mfa` with a TOTP or recovery code;
     - `POST /auth/mfa/passkey/options` and `POST /auth/mfa/passkey`.

     Either answers the selection token, carrying the `amr`.
   - **Lockout:** 5 wrong second factors in 15 minutes lock the account's second factor
     for 15 minutes (`429`), whatever the method. A correct code clears the count.
7. **Step-up (`POST /auth/step-up`).**
   - It takes the password, and a TOTP or recovery code when the account has a factor.
   - It answers a new access token for the same session, with `auth_time` now, and the
     session keeps the new `auth_time`.
   - **Routes that need it** (`auth_time` within 10 minutes, and a second factor in `amr`
     when the account has one):
     - creating, rotating and revoking API keys;
     - assigning roles;
     - inviting (which grants roles);
     - removing a factor, and new recovery codes;
     - the MFA policy;
     - ending another user's sessions.

     Otherwise the answer is `403`, with the problem type `step-up-required`.
   - `infra/scripts/mint-dev-token.mjs` sets `auth_time` to now and `amr` to `pwd`, so
     the older scripts keep working.
8. **The workspace MFA policy.** `GET` and `PUT /workspace/mfa-policy`, owner only, with
   step-up. It is `{ policy: off | admins | everyone, graceDays: 0–30 }`.
   - **Who it covers:** `admins` means anyone holding `admin` or `owner` in any module.
   - **Choosing a workspace it covers,** without a second factor:
     - inside the grace period (from the policy change), the session opens, and the
       answer names `enrollBy`;
     - after it, the choice is refused (`403 mfa-enrollment-required`), with an
       **enrollment token** (10 minutes). That token allows only the TOTP enrollment
       calls under `/auth/enrollment`. After enrolling, the person signs in again.
9. **Invitations** (tenant-scoped, `invitations` table).
   - `POST /invitations` takes `{ email, name, roles }`, needs `owner` and step-up, and
     mails a link to `WEB_URL/accept-invitation?token=…`.
     - The token is 32 random bytes, and only its digest is stored.
     - It is valid for 72 hours and used once.
   - `GET /invitations` lists them.
   - `POST /invitations/{id}/revoke` ends one.
   - `POST /invitations/{id}/resend` issues a new token and a new 72 hours. The old link
     stops working.
   - **Public routes:**
     - `GET /invitations/lookup?token=` answers the workspace name, the masked email, and
       whether the person already has an account;
     - `POST /invitations/accept` takes `{ token, name, password }`.
   - **Accepting.**
     - It creates the user in the workspace with the invited roles, through the existing
       user registration, and marks the invitation used, in one transaction.
     - When the email already has a Horizon account, the password given must be that
       account's password. The next sign-in links the workspace through the existing
       reconciliation.
   - **Refusals:** an expired, used, revoked or unknown token is refused alike (`410`).
   - **Personal data.** The email is kept only while the invitation is pending. Accepting,
     revoking or expiring it leaves only its masked form.
   - `POST /users` (a password chosen by an owner) stays for scripts and the demo. The web
     offers invitations only.
10. **Mail is a port.** It is SMTP through `nodemailer`, with Mailpit in the local stack
    (SMTP 1025, UI 8025), and in memory in tests. A mail that fails to send is reported
    to the owner (`502`) and the invitation stays, so they can resend it.
11. **Sessions API:**

    | Route | Who | Does |
    |---|---|---|
    | `GET /auth/sessions` | the person | their sessions in this workspace, the current one marked |
    | `DELETE /auth/sessions/{id}` | the person | ends one |
    | `POST /auth/sessions/revoke-others` | the person | ends every other one |
    | `GET /users/{id}/sessions` | admin, owner | a user's sessions |
    | `DELETE /users/{id}/sessions` | owner, with step-up | ends all of a user's sessions |
12. **Audit.** Every change is appended to the tenant's chain, without secrets, codes or
    tokens:
    - invitation created, resent, revoked and accepted;
    - factor enrolled and removed;
    - recovery codes regenerated and used;
    - step-up;
    - MFA policy changed;
    - session revoked, by whom.

    Failures and lockouts before a workspace is chosen have no tenant. They are
    structured logs.

## Work

### A — Identity
1. **Migration:**
   - `account_factors` and `account_recovery_codes`, scoped to the account;
   - `invitations`, scoped to the tenant;
   - the MFA policy columns on `tenants`.
2. **Domain:**
   - TOTP;
   - recovery codes;
   - the invitation and its lifecycle;
   - the MFA policy and who it covers;
   - the device label and IP prefix.
3. **Application:**
   - the MFA challenge, verify and lockout;
   - enrollment;
   - step-up;
   - sessions;
   - invitations;
   - the policy at workspace choice.
4. **Infrastructure:**
   - the store, the Redis challenge, lockout, session meta and live `jti`s;
   - the mailer;
   - WebAuthn;
   - the controllers, and the step-up guard.
5. **Tests:** unit (TOTP vectors, codes, lockout, policy, invitation), and e2e (sign-in
   with MFA, step-up, sessions, invitations).

### B — Platform
Mailpit in Compose, the new environment variables, and the dev-token script.

### C — Web
1. **The login second step:** a code, a recovery code, or a passkey.
2. **`/accept-invitation`.**
3. **Security (`/app/settings/security`):**
   - TOTP with a QR code and the recovery codes;
   - passkeys;
   - sessions.
4. **People:** invite, list, revoke and resend.
5. **The workspace MFA policy,** and a step-up dialog wherever a sensitive action asks for
   it.

### D — Evidence
1. `scripts/phase67-drill.mjs` stores its results in `docs/drills/`:
   - TOTP brute force locks out;
   - a replayed recovery code is refused;
   - a revoked session's access token is refused, by Identity and by Catalog;
   - an expired or used invitation is refused.
2. A browser run: invitation to first sign-in, TOTP enrollment, a passkey with a virtual
   authenticator, and sign-in with each.

## Exit evidence

- A security drill script:
  - brute force on TOTP locks out;
  - a replayed recovery code is refused;
  - a revoked session's access token is refused within its lifetime;
  - an expired or used invitation is refused.

  It stores its results.

## Revisions made while implementing

- **Revocation before roles.** Identity and Catalog checked a route's role before the
  denylist, so a revoked token without the role got `403` instead of `401`. The drill
  caught it. Both now weigh revocation first, as Fiscal already did.
- **Passkeys are a second factor only.** Passkey-only sign-in, which ADR 0061 allows when
  the workspace does, is left for later.
- **The IP prefix is the client's only behind trusted proxies.**
  - Identity trusts private-network proxies (`trust proxy`) and reads `X-Forwarded-For`.
  - The web server forwards the header only when it receives one.
  - Locally, a browser that talks straight to the web server shows the Docker network.
- **What counts toward the lockout.** A wrong step-up password counts, and so does a
  replayed recovery code: each is a wrong answer about the same account.
- **Audit.** Failures before a workspace is chosen have no tenant, so they are logs.
  Enrollment and removal are audited in the workspace of the session that made them.
- **`POST /users` stays** for scripts and the demo, and now asks for step-up. The web
  offers only invitations.

