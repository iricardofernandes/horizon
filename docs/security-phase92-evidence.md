# Phase 92 evidence — The workspace's day, the edge, and the AWS path

[Plan](security-logic-plan.md#phase-92--the-workspaces-day-the-edge-and-the-aws-path) ·
[ADR 0077](adr/0077-the-business-day-is-told-where-the-business-is.md)

Findings 6, 7, 8, 9, 10 and 13 of the [security and logic review](security-logic-plan.md).
Two of them were delivered in part, as said below.

## Before and after

| Finding | Before | After |
|---|---|---|
| 6. The day | "today" was the UTC date: after 21:00 in Brasília a title due today was overdue and a lot expiring today had expired | one function, `businessDayOf`, in `America/Sao_Paulo` by default, used wherever a module turns now into a date |
| 7. The local stack | every published port bound to all interfaces; Kong's Admin API published; Redis without a password; Grafana `admin`/`admin` fixed | every port binds to `127.0.0.1` unless `HORIZON_BIND_ADDRESS` says otherwise; the Admin API is not published; Redis takes a password; Grafana's comes from `infra/.env` |
| 8. The AWS path | the web was given `HORIZON_UPSTREAM_URL`, which it does not read, and no Secure cookies or trusted hop; Kong trusted no forwarded address; no probe | `HORIZON_API_URL`, `HORIZON_COOKIE_SECURE`, `HORIZON_WEB_TRUSTED_HOPS`; `KONG_TRUSTED_IPS` is the VPC range; the probe runs as a service |
| 9. Password guessing | limited per address only; a disabled account said so to anyone with its password | each wrong password for an account name delays the next, from 0.5 s up to 8 s, whatever the address; a disabled account with a second factor answers as a wrong password |
| 10. Kong and tokens | the READMEs said Kong validates every token; its `jwt` plugin runs on the self-test route only | the READMEs say what is true: each service verifies; Kong is the edge |
| 13. Uploads | two uploads of one slot wrote the same object, and the one recorded could keep the key of bytes the other overwrote | each upload writes an object of its own; the one that loses removes it |

## Proof

- **The day:** contracts tests at 23:30 in Brasília (still today) and at 00:30 UTC on a
  month's last day (not yet that day); a lot expiring on 30 September has not expired at
  23:30 that evening and has at midnight. Sales' contract schedule, which builds dates by
  calendar arithmetic, keeps its 129 tests.
- **Password guessing:** three free mistakes, then 500, 1000 and 2000 ms; an account that
  does not exist is delayed the same way; the right password clears the count; the delay
  never exceeds 8 s. A disabled account answers `InvalidCredentials` with a second factor
  unproved, and `AccountDisabled` without one.
- **Uploads:** two uploads of one slot at once leave one object, and the bytes served are
  the file's.
- **The AWS path:** Terraform `validate` and its tests with the dev and prod variables,
  with new assertions for the web's three settings, Kong's trusted range and the probe.
- **The local stack:** `docker compose config` resolves every published port to
  `127.0.0.1`; see the gates for the stack rebuilt this way.

## Gates

- On the stack rebuilt with every port on `127.0.0.1`, Redis under a password and no
  published Admin API: `make demo` twice, `make test-phase10`, `make test-alerts`, the
  Phase O golden path and the Phase 90 smoke (14 of 14). No Horizon container publishes a
  port on all interfaces.
- `node scripts/ci-local.mjs --full`, after the last edit: every check, clean installs,
  typecheck, lint, tests and build of every project, the e2e suites of all sixteen
  services, and every Docker image. Earlier runs caught three mistakes of this phase: a
  Compose `user` rewritten as a port, a domain layer importing the contracts, and an
  upload key the object store refused.
- The platform smoke passes every check but "16 module databases exist", which counts the
  `horizon_drill` database an earlier recovery drill left locally.
- `deck` did not run: `gateway/kong.yml` is unchanged.

## Delivered in part

- **Finding 6:** the day is Brasília's for every workspace. Each workspace's own timezone
  is not carried to the modules ([ADR 0077](adr/0077-the-business-day-is-told-where-the-business-is.md)).
- **Finding 8:** the retention job is not a task on AWS. It takes one connection template
  for every database, and there each database has a relay secret of its own.
- **Finding 10:** Kong's `jwt` plugin is still on the self-test route only. Every module
  serves public paths under its own prefix (health, signed links, invitations, the MCP
  endpoint), and Kong's keys are rendered files while Identity's rotate, so the plugin on
  every route would need exceptions in every service and would tie every request to that
  rendering. Each service already verifies every token. The documentation no longer
  claims otherwise.
- **Finding 13:** an upload that crashes between writing its object and recording it
  leaves an object nobody names. It is encrypted under a key nobody kept.
