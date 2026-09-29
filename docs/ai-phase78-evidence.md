# Phase 78 evidence — Threat model, service levels, screens and closing Phase N

[Plan](ai-phase78-implementation-plan.md) ·
[Phase N plan](ai-implementation-plan.md#78--threat-model-service-levels-screens-and-closing-phase-n) ·
[threat model](phase-n-threat-model.md) ·
[service levels](service-levels.md#phase-n--the-agent-the-index-search-and-suggestions) ·
[agent API](agent-api.md) · [knowledge API](knowledge-api.md)

**Records:**
- golden path: [ai-on](drills/2026-09-29-phase-n-golden-path-ai-on.json),
  [ai-off](drills/2026-09-29-phase-n-golden-path-ai-off.json);
- drill: [ai-on](drills/2026-09-29-phase-n-drill-ai-on.json),
  [ai-off](drills/2026-09-29-phase-n-drill-ai-off.json);
- [the ai-off run](drills/2026-09-29-phase-n-ai-off-run.json).

## Phase N's exit criteria

| Criterion | Proven by |
|---|---|
| 1. An agent reads and drafts only what its key's issuer could; every call is audited naming the key; no privileged path | **Golden path**, both modes: the agent reads and drafts through the key; the issuer is refused approval with `segregation-of-duties` and another person approves; Financial's audit names the issuer as actor and the key as `via`; every agent call is in the hash-chained log with the key, and the chain is intact. **Drill**, both modes: revoked, stolen and over-grown keys are refused; writes outside the catalogue are refused and audited as refused |
| 2. Retrieval is partitioned by tenant at the index, respects module roles, and cites its sources | **Golden path:** search, the agent's `search_documents` and the assistant cite the document with its record and excerpt. **Drill:** another workspace's canary never reaches search, the agent or the assistant, with e5 and with the hash embedder. **Phase 75:** one partition per plan (e2e), the reader without Financial (smoke), and the [retrieval evaluation](drills/2026-09-29-phase75-retrieval-tei.json) (e5 recall@5 0.889 against a gate of 0.8) |
| 3. Erasing a data subject removes their content from the index and from every answer; nothing AI produces becomes a business fact without a person | **Golden path**, both modes: after the party's erasure, its document is gone from search, from the agent and from the assistant's answer. The payable the agent drafted became a business fact only through another person's approval. **Phase 76:** an erased person's conversations and key are gone. **Phase 77:** an accepted suggestion only fills a form |
| 4. Horizon runs fully with every AI component off and no model key present | **[The ai-off run](drills/2026-09-29-phase-n-ai-off-run.json)**: TEI not running, the hash embedder, suggestions off, the extractive generator, `ANTHROPIC_API_KEY` empty. In that state: the Phase N golden path (9/9), Phase M's golden path (5/5), the browser golden path (`make test-phase10`) and the drill (10/10) |

## What was delivered

- **The threat model:**
  - it covers the seven threats the plan names, and six more;
  - each row names a control and a proof, from a test, a smoke or the drill;
  - four limits are left open and stated: the backup window, the unexercised Anthropic
    API, no anomaly detection on a stolen key, and master-key rotation.
- **`scripts/phase-n-drill.mjs`** (`make phase-n-drill`): ten attacks through Kong, 10 of 10
  with the local model and without it.
  - **Identity refuses a key beyond its issuer's roles** at issue (`403`).
  - A key issued while the role was held **is refused whole** at its next exchange once
    the role is taken away (`403` at the MCP endpoint and at the exchange).
  - **The key flood:** 130 simultaneous exchanges of one key; the excess was refused with
    `Retry-After`.
- **`scripts/phase-n-golden-path.mjs`** (`make phase-n-golden-path`, `AI=on`): 9 of 9 in
  both modes.
  - It checks the environment it claims first: the embedder, whether suggestions are
    available, the generator, the switches.
  - Indexing took 2.6 s with e5 and 1.5 s with the hash embedder.
- **`scripts/phase-n-kit.mjs`** is what both share. It refuses to write a record that could
  hold a key, a token or an `api-key:` string.
- **Service levels:**
  - `infra/observability/rules/phase-n.rules.yml`: 6 recording rules and 5 alerts;
  - `phase-n.rules.test.yml`: every alert fires and stays quiet as it should. Refusals are
    not failures, an absent failure is 0, and acceptance is per kind;
  - `make test-alerts` runs them, in CI too;
  - the *Horizon — Phase N* dashboard is provisioned in Grafana;
  - the objectives and runbooks are in `docs/service-levels.md`.
- **Metrics:**
  - every Phase N duration histogram now has bounds in seconds, and a new
    `agent_tool_call_seconds{outcome}` times each MCP call to its audited answer;
  - after the stack was rebuilt, Prometheus shows `agent_tool_call_seconds_bucket` with
    `le` from `0.005` to `60.0`, and the recording rules evaluate.
- **Screens:**
  - a web test requires the Phase N message namespaces in both locales, with Portuguese a
    translation and not a copy of English;
  - in the browser, in pt-BR: the assistant settings (notice, turning on), the assistant
    (question and sources), Developers → Agent, and the NCM chip ("Como em 1 registro
    seu…").
- **Documents:**
  - `roadmap.md`: the MCP server and RAG entries moved out, and fine-tuning stays, with
    what Phase N collects;
  - `privacy.md`: the AI data, the one subprocessor and when, erasure of derived data,
    and the backup window: about 42 hours, not zero;
  - `agent-api.md` and `knowledge-api.md`;
  - Phase N closed in `plan.md`, the expansion plan and the Phase N plan.

## Found and fixed in this phase

- **Every Phase N latency histogram was unmeasurable.** OpenTelemetry's default bounds are
  meant for milliseconds, and these record seconds, so every search, embedding, suggestion
  and exchange fell into the first bucket. They now use explicit bounds in seconds.
- **Developers → Agent reloaded forever.** Phase 72's page gave `useLoader` an inline
  function, so every render loaded again: 593 requests to each of two routes in three
  minutes. That spent Kong's 600-a-minute limit for the web server's address and broke
  other screens with `429`. It is now stable, and a web test forbids an inline loader. The
  test fails on the old page.
- **The extractive assistant answered in English** whatever the question's language. It
  now answers in Portuguese or English, as the question reads.
- **The drill's first draft misread the over-grown key.** A refused exchange is an HTTP
  `403`, not an MCP error. The check now reads both, and records that Identity refuses the
  key whole rather than narrowing it.

## Not fixed, stated

- **Catalog's items screen needs an Inventory role** (found in Phase 77). It is older than
  Phase N.
- **Kong's per-address limits** (`/auth` 30 a minute, everything 600 a minute) are shared
  by every browser behind the web server. A busy office behind one web instance would
  meet them.
- **The Anthropic adapter was not run against the real API:** no key is available here.

## Verification

- `agent/`:
  - 71 unit tests (the MCP latency SLI; the answer's language);
  - 21 e2e tests.
- `knowledge/`: 63 unit tests, 25 e2e.
- `web/`: 148 unit tests (Phase N translations; stable loaders); typecheck and lint clean.
- `make test-alerts`: every rule file checked, and every test passes.
- The phase's closing runs are listed in the commit's report.
