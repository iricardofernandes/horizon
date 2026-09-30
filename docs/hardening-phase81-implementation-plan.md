# Phase 81 — Keys, alerts and quality

Status: **delivered on 2026-09-30** ([evidence](hardening-phase81-evidence.md)). The last of the
[debts and hardening](hardening-plan.md) phases.

## Result

- **The master keys of `knowledge/` and `agent/` can be rotated,** with no downtime and
  nothing re-encrypted but the wrapped keys.
- **A burst of refused or rate-limited key exchanges raises `ApiKeyExchangesRefused`,** and
  Identity's log names the key by its prefix.
- **Inventory's branch coverage is over its gate** (80.7% against 80%).
- **`make up-apps` builds images four at a time,** and so does the golden path workflow,
  which calls it.
- **Dependabot no longer tries `@horizon/contracts`,** which failed every npm update.

## Decisions

1. **A ring of master keys.**
   - `…_MASTER_KEY` is the current key; `…_PREVIOUS_MASTER_KEYS` lists the ones being
     retired.
   - A wrapped key is `2 ‖ key name ‖ nonce ‖ ciphertext ‖ tag`. The name is the first four
     bytes of a SHA-256 of the key, never the key, and it is bound into the associated data.
   - A key wrapped before this phase (`1 ‖ …`) names no master key. It is opened by whichever
     listed key authenticates it, and the rewrap moves it to the new format.
   - Chunks and turns are untouched: they are sealed under their own data keys.
2. **Finding what to rewrap.**
   - `documents` and `assistant_keys` gain `master_key_id`, written from the wrapped value by
     the database layer.
   - A `SECURITY DEFINER` function, `tenants_on_old_master_keys(current)`, lists tenants and
     counts, never a key. It is readable through a policy for the migration role only, as
     Phase 76's purge is.
   - The rewrap itself runs in each tenant's own transaction, under forced RLS.
3. **The rewrap worker** in each service moves up to 200 keys per tenant per batch, every
   `…_REWRAP_INTERVAL_MS` (default one minute).
   - It exports `knowledge_keys_on_old_master_keys` and `assistant_keys_on_old_master_keys`.
   - It logs once when none is left.
   - A key no listed master opens is logged by error class and left as it is.
4. **Knowledge's lexeme key is its own.**
   - Before this phase the keyed lexemes (Phase 75) were hashed under a key derived from the
     master key, so a rotation would have made every document unfindable by its words.
   - `KNOWLEDGE_LEXEME_KEY`, which defaults to the master key, now keys them.
   - The document index version names the lexeme key (`…+lex-v1+<name>`), so a new lexeme
     key re-indexes every document instead of silently breaking search.
   - This re-indexes every document once, when this phase is deployed.
5. **Key exchanges:**
   - `identity_api_key_exchanges_total{outcome}` counts `issued`, `refused`, `rate-limited`
     and `unavailable`, with no key label;
   - every outcome is a series from startup, because a counter first seen at 25 shows no
     increase;
   - `ApiKeyExchangesRefused` fires above 20 refused or limited exchanges in five minutes,
     for two minutes;
   - the log line names the key as `hz_…<prefix>`.
6. **Coverage:** unit tests for purchase receipts and returns, the procurement and catalog
   consumers, delegations, shipping and returns against a reservation, and input parsing.
7. **Builds:** `make build-apps` builds every image with a `build` section,
   `HORIZON_BUILD_BATCH` (4) at a time; `make up-apps` depends on it.
8. **Dependabot:** `@horizon/contracts` is ignored in every npm entry. Whether that is enough
   is proven only by its next run.

## Found on the way

- **Kong kept a recreated service's old address for minutes.** Docker's DNS answers with a
  600-second TTL, and Kong cached it: after `--force-recreate`, `/knowledge` answered `502`
  for over three minutes. `KONG_DNS_VALID_TTL` and `KONG_RESOLVER_VALID_TTL` are now 5.
  Recovery takes about a second.
- **Prometheus reads a new rule file only on reload** (`POST /-/reload`) or restart.

## Proof

- **Unit tests:**
  - both keyrings: rotation, legacy keys, refusal, binding;
  - both sealers across a rotation;
  - both rewrap workers;
  - the exchange outcomes and the log's key name;
  - Inventory's new specs.
- **e2e:**
  - Knowledge: a document rewrapped, then read by the new key alone, and a new lexeme key
    re-indexing. The second test fails without the version change;
  - agent: a conversation read by the new key alone after its person key is rewrapped.
- **`make test-alerts`:** the alert fires on a burst and stays quiet on issued exchanges.
- **`scripts/phase81-rotation-drill.mjs`** on the running stack:
  - rotate both keys, retire the old ones, and rotate back, with a document and a
    conversation readable throughout;
  - 25 refused exchanges, counted and logged by prefix.
- **Prometheus:** `ApiKeyExchangesRefused` went from pending to firing on a real burst.
