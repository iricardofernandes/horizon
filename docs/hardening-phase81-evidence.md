# Phase 81 evidence — Keys, alerts and quality

[Plan](hardening-phase81-implementation-plan.md) · [debts and hardening](hardening-plan.md) ·
[drill](drills/2026-09-30-phase81-rotation-drill.json) ·
[runbooks](service-levels.md#apikeyexchangesrefused)

## Before and after

| | Before | After (2026-09-30) |
|---|---|---|
| Master key rotation | not possible: one key wrapped everything, naming nothing | a ring; every wrapped key names its master. The drill rotated both keys and back on the running stack |
| Upgrade | — | on first start, every existing key was rewrapped into the named format: Knowledge 32 documents under `96aa721f`, the assistant 14 person keys under `a16e2913`. Each worker logged "every … key is wrapped under the current master key". The index re-indexed once to `hash-384-v1+lex-v1+f8a1714f` |
| A stolen key's unusual use | nothing counted or alerted | `identity_api_key_exchanges_total{outcome}`, and `ApiKeyExchangesRefused` fired on a real burst |
| Inventory branch coverage | 71.23%, under its own 80% gate | **80.7%** (1142 of 1415) |
| Image builds | all at once in `up -d --build` | `make build-apps`, four at a time |
| Dependabot | every npm update failed on `@horizon/contracts` (`private_source_authentication_failure`, `localhost:4873`) | the package is ignored in every npm entry. Proven only by its next run |
| A recreated service through Kong | `502` for minutes (Docker's 600 s TTL, cached by Kong) | back in about a second (TTL 5 s) |

## Proof

- **The drill** (`node scripts/phase81-rotation-drill.mjs`), 5 of 5:
  - before: a party's contract is found and cited, and an assistant conversation reads back;
  - rotated: Knowledge's keys moved from `96aa721f` to a new name, and the assistant's from
    `a16e2913`. Both read throughout;
  - retired: with the old keys removed, both read as before;
  - rotated back to the original keys: every key is back under `96aa721f` and `a16e2913`,
    and everything reads;
  - 25 exchanges of an unknown key:
    - all `401`;
    - counted in Prometheus (increase of 25 over five minutes);
    - 25 log lines naming the key's prefix, none containing its secret.
  - **One failed run also proved the recovery path.** It stopped midway, restarted with the
    original key and the drill's as previous, and the workers moved every key back to the
    original names.
- **The alert on the stack.** After Prometheus reloaded its rules, 25 refused exchanges took
  `ApiKeyExchangesRefused` from pending (14:53:19) to firing (14:55:19).
- **e2e:**
  - Knowledge:
    - a document rewrapped, then read by the new key alone, by words and by meaning;
    - a new lexeme key re-indexing. This test fails when the version ignores the lexeme key;
  - agent: a conversation sealed before the rotation, opened by the new key alone.
- **Unit tests:**
  - Knowledge and agent: keyrings, sealers across a rotation, rewrap workers;
  - Identity: exchange outcomes, and a log that names the prefix and never the secret;
  - Inventory: 34 new tests in four specs.
- **`make test-alerts`:** the new cases pass. The alert fires at 20 minutes on a burst, is
  quiet at 9, and no refusal is a count of 0.

## Found and fixed in this phase

- **Rotating the master key would have broken keyword search.** The Phase 75 lexeme key was
  derived from it. It is now a separate key, and the index version follows it.
- **The alert could not have fired on the first burst after a restart.** A counter series
  born at 25 shows no increase. Every outcome now starts at 0.
- **Kong cached a recreated service's old address for minutes** (see above).
- **Two drill timing mistakes:**
  - a read right after a restart was taken before the services answered;
  - "until" accepted an unreadable answer.

  Both now wait for both reads.

## Not done, stated

- **Dependabot covers only 8 npm projects** (identity, catalog, inventory, sales, webhooks,
  web, contracts, the MCP debugger). Parties, Financial, Treasury, Ledger, Procurement,
  Fiscal, CRM, Reporting, Files, Agent and Knowledge get no automatic updates. Adding them
  is about a dozen more pull requests a week, which is the owner's decision.
- **Deploying this phase re-indexes every document once,** because the index version now
  names the lexeme key.
- **The Phase M keys** still have no rotation. This phase covers
  Phase N's master keys, as planned.

## Verification (2026-09-30)

- **`node scripts/ci-local.mjs --full`:**
  - every gate passed but module boundaries. A new Inventory spec called `toSnapshot()`
    outside `test/` (ADR 0031), and it now uses `snapshotOf`;
  - after the fix, the boundaries check, Inventory's typecheck, lint and coverage gate
    (213 tests, 80.7% branches) passed. The full run was not repeated;
  - test counts in that run:
    - Knowledge: 72 unit, 27 e2e;
    - agent: 81 unit, 22 e2e;
    - Identity: 252 unit, 52 e2e;
    - Inventory: 213 unit, 68 e2e.
- **After rebuilding the stack,** all passed:
  - `make demo` twice, `make test-alerts` and `make test-phase10`;
  - the Phase 79 and Phase 80 smokes, again (5 of 5 each);
  - every DLQ holds 0 messages.
- **`deck` was not run.** `gateway/kong.yml` did not change; Kong's DNS settings are
  environment variables.
