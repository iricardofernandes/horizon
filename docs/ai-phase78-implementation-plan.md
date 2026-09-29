# Phase 78 — Threat model, service levels, screens and closing Phase N

Status: **delivered on 2026-09-29** ([evidence](ai-phase78-evidence.md)). This is the execution record for
[Phase 78 of the AI with isolation plan](ai-implementation-plan.md#78--threat-model-service-levels-screens-and-closing-phase-n).
It closes Phase N.

## Result

After this phase:
- **The Phase N threat model** (`docs/phase-n-threat-model.md`) names each threat, the
  control that answers it, and the test or drill that proves it. What is not proven is
  listed as open.
- **The red-team drill** (`scripts/phase-n-drill.mjs`) attacks the stack through Kong:
  - canaries in another workspace;
  - an injected document;
  - a revoked key, an over-grown key, a stolen key;
  - writes outside the catalogue;
  - a flood of exchanges;
  - a spent budget.

  It stores its record in `docs/drills/`.
- **Service levels** for the agent, the index, search and suggestions, each with its
  recording rules, alerts, promtool tests and a Grafana dashboard.
- **The Phase N golden path** (`scripts/phase-n-golden-path.mjs`) walks the whole phase
  end to end. It runs twice: with the `ai` profile on, and with every AI component off and
  no model key.
- **The screens:** the Phase N screens exist in pt-BR and en, a test keeps the two
  message files' Phase N keys equal, and each screen is opened in pt-BR once.
- **The documentation:**
  - `roadmap.md` moves the MCP server and RAG entries out, and fine-tuning stays;
  - `privacy.md` states the AI data, the subprocessor and the backup window;
  - the API references of `agent/` and `knowledge/`;
  - `plan.md`, the expansion plan and the Phase N plan close the phase.

## Starting point

- **Phases 71–77 are delivered.** The metrics are:
  - `agent_tool_calls_total{tool,outcome}` and `agent_exchange_seconds`;
  - `knowledge_index_lag_seconds`, `knowledge_search_seconds{outcome}`,
    `knowledge_embedding_seconds`, `knowledge_suggestion_seconds{kind,outcome}` and
    `knowledge_suggestion_decisions_total{kind,decision}`;
  - `assistant_questions_total{outcome}`, `assistant_tokens_total{kind}` and
    `assistant_answer_seconds`.
- **A defect found while planning:** every Phase N histogram in seconds uses
  OpenTelemetry's default bucket bounds (0, 5, 10, 25… 10,000), which are meant for
  milliseconds. Every search, embedding, suggestion and exchange falls in the first
  bucket, so no latency objective can be measured on them.
- **There is no latency metric for an MCP tool call.**
- **Phase 70's conventions:**
  - recording rules name each SLI once, and alerts read them;
  - `make test-alerts` checks and tests every rule file;
  - `docs/service-levels.md` holds the objectives and runbooks;
  - dashboards are provisioned from `infra/observability/grafana/dashboards`.

## Decisions frozen by this plan

1. **Histogram buckets.** Every Phase N duration histogram gets explicit bounds in seconds
   (0.005 to 60, or to 300 for the assistant), through OpenTelemetry's `advice`.
2. **A new SLI for the agent:** `agent_tool_call_seconds{outcome}`, the time from a
   `tools/call` to its audited answer, with no tool label.
3. **Service levels.** These are local defaults, as in Phase 70:

   | SLI | Objective | Alert |
   |---|---|---|
   | Agent calls that fail: outcome `failed`, where Horizon could not answer; a refusal is a correct answer | under 1% | `AgentCallsFailing`: over 5% for 10 minutes |
   | Agent calls answered within 2 s | 95% | `AgentCallsSlow`: below for 10 minutes |
   | Index freshness: the oldest due document's wait | under 10 minutes | `DocumentIndexBehind`: over for 15 minutes |
   | Searches answered within 1 s | 95% | `DocumentSearchSlow`: below for 10 minutes |
   | Suggestion acceptance, over a day, with at least 20 decisions | 30% or more | `SuggestionsRarelyAccepted` (info): below for 6 hours |

   They live in `infra/observability/rules/phase-n.rules.yml`, with their tests beside
   them, and the dashboard is *Horizon — Phase N*.
4. **The golden path's "AI off":**
   - no `ai` profile: TEI stopped, the hash embedder, suggestions `auto` and so off;
   - the extractive generator, and no Anthropic key;
   - agent access and the assistant off, until the path turns them on as a person would.

   In the same mode, Phase M's golden path and the browser golden path (`test-phase10`)
   run again. That is the fourth exit criterion: Horizon runs fully with every AI
   component off.
5. **The drill never stores a secret:** no key, no token, and no `api-key:` string (the
   gitleaks rule of Phase 71). Only statuses, codes and booleans.

## Work

1. **Metrics:** buckets in `knowledge/` and `agent/`, and `agent_tool_call_seconds`.
2. **Rules:** `phase-n.rules.yml` and `phase-n.rules.test.yml`, the Makefile's
   `test-alerts`, `docs/service-levels.md` (table and runbooks), and the dashboard JSON.
3. **`scripts/phase-n-drill.mjs`** and `make phase-n-drill`.
4. **`scripts/phase-n-golden-path.mjs`** (`--ai on|off`) and `make phase-n-golden-path`.
5. **Screens:** a web test comparing the Phase N namespaces of `pt-BR.json` and `en.json`,
   and a pt-BR walk in the browser.
6. **Documents:** the threat model, `roadmap.md`, `privacy.md`, `agent-api.md`,
   `knowledge-api.md`, and closing Phase N.

## Exit evidence

The four exit criteria of the Phase N plan, each proven by a stored artifact:
1. An agent reads and drafts only what its key's issuer could, every call is audited
   naming the key, and there is no privileged path: the golden path and the drill.
2. Retrieval is partitioned by tenant at the index, respects the owning module's roles and
   cites every result: the golden path, the drill's canaries, and the retrieval
   evaluation record (Phase 75).
3. Erasing a data subject removes their content from the index and from every answer, and
   nothing AI produces becomes a business fact without a person: the golden path.
4. Horizon runs fully with every AI component off and no model key present: the `ai`-off
   run of the golden path, Phase M's golden path and `test-phase10`.
