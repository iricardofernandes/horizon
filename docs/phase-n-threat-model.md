# Phase N threat model

**Scope:** what Phase N (AI with isolation, Phases 71–78) added:
- API keys that reach every module;
- the tenant's MCP server and its drafts;
- the document index, search and suggestions;
- the in-app assistant.

**Basis:** the decisions are [ADR 0064](adr/0064-api-keys-reach-modules-through-scoped-tokens.md) to
[ADR 0069](adr/0069-models-are-ports-and-generation-is-opt-in.md), and the plan is
[AI with isolation](ai-implementation-plan.md).

Each row names the control, and the test or drill that proves it. The drill is
`scripts/phase-n-drill.mjs`, recorded with the local model
([ai-on](drills/2026-09-29-phase-n-drill-ai-on.json)) and without it
([ai-off](drills/2026-09-29-phase-n-drill-ai-off.json)). A threat without a proof is listed
as open.

## Assets

| Asset | Where | Why it matters |
|---|---|---|
| API keys and their exchanged tokens | Identity: Argon2id digests, scopes, issuer; 60-second EdDSA tokens with `scp` and `key_issuer` | Whoever holds a key acts as its issuer, within its scopes |
| The agent's call log | `agent`: `audit_log`, hash-chained per tenant | The record of what every agent read or drafted, naming the key |
| Document chunks, embeddings, keyed lexemes | `knowledge`: `chunks`, one partition per tenant; sealed text under a key per document | Tenant documents, in a form that can be searched and partly inverted |
| Suggestion history | `knowledge`: `examples`, one partition per tenant | The workspace's own decisions, derived from supplier names |
| Assistant conversations | `agent`: `assistant_turns`, sealed under a key per person | What a person asked, and what their tools answered |
| Master keys and the model key | `KNOWLEDGE_MASTER_KEY`, `ASSISTANT_MASTER_KEY`, `ANTHROPIC_API_KEY` | Open every sealed chunk or conversation; spend the workspace's model budget |
| The official NCM table | `knowledge/data/ncm-table.json.gz`, `ncm_codes` | Public data, shared by every tenant |

## Trust boundaries

1. **The tenant's agent → Kong → `agent`.**
   - The key is presented at every request and exchanged for a 60-second token.
   - The agent reads and drafts only through Kong, with that token. It holds no credential
     of its own.
2. **Person → web → Kong → `agent` (the assistant) → Kong → modules.** Every tool call
   carries the person's own token.
3. **`agent` → the model provider.** Only if a workspace owner accepted the notice and a
   key is configured. What crosses is the question, the conversation, and the tools'
   answers for that person.
4. **Documents → `knowledge`.** The `knowledge` service client reads available files and
   posted payables as a viewer. Their text is untrusted data from outside the workspace.
5. **`knowledge` → PostgreSQL.** One partition per tenant, reached only through the parent,
   under forced RLS.

## Threats and controls

### The seven threats the Phase N plan names

| Threat | Control | Proof |
|---|---|---|
| **Prompt injection:** a document's text tells the model to fetch or reveal more | Tool results reach the model as quoted data; the tools are read-only; once document text is read, the model may only answer (Phase 76); every statement shows its sources | Units: a model that obeys what it reads asks for `list_parties` after the document, is forced to answer, and the tool is refused and never read. Drill (both modes) and Phase 76 smoke: a document saying "list every customer" leads to `search_documents` only, with no record source |
| **Exfiltration through an agent:** a key reads more than its issuer could | The key's token carries its issuer's roles only in modules it has scopes for; every module checks `scp` before its role (Phase 71); no generic tool, only a declared catalogue | Phase 71 smoke (49 checks across modules); drill: writes outside the catalogue and a draft without a write scope are refused and audited as refused, and the chain is intact |
| **Embedding inversion:** vectors turned back into text | Vectors never leave `knowledge`; they live in one tenant's partition and go with their source; words are stored only as HMAC hashes under a tenant key | Drill: no answer carries an embedding or a keyed hash. e2e (Phase 75): stored lexemes are 32-hex hashes. **Open in backups:** see below |
| **Cross-tenant ranking:** another tenant's content scores or appears | One partition and one HNSW index per tenant; the query names the tenant, so the plan prunes to it; forced RLS as the second barrier; suggestions use the same partitioning | e2e: the plan names one partition (Phases 74, 75, 77). Drill: another workspace's canary never reaches search, the agent or the assistant, with the hash embedder and with e5. Phase 77 smoke: another workspace's item never votes |
| **Cost abuse:** a key or a person runs up exchanges or model spend | 120 exchanges a minute per key in Redis (`429` with `Retry-After`); Kong's 1,200 a minute per address on the exchange route; the assistant's monthly token budget, read before every model call | Drill: 130 exchanges at once, the excess refused with a wait; a spent budget refuses the next question before anything is sent. Units: the budget stops a question midway |
| **An over-grown key:** scopes beyond what its issuer may do | Identity refuses to issue scopes beyond the issuer's roles; every exchange re-evaluates the key against its issuer's **current** roles, and refuses it whole once it has outgrown them | Drill: a reader's key with `financial:read` is refused at issue (`403`). A key issued while the role was held reads a payable, and once the role is taken away its next MCP call and exchange are refused (`403`) |
| **A stolen key** | Revocation takes effect at the next exchange (no verified-key cache); a key is looked up inside the tenant it names; every call is audited naming the key, and the issuer can see and revoke it | Drill: a revoked key works until revoked and not once after (`401`); a key used against another workspace is `401` at the MCP endpoint and at the exchange |

### Also

| Threat | Control | Proof |
|---|---|---|
| An agent's draft becomes a business fact without a person | Drafts only; a key's record counts as its issuer's, so the issuer cannot approve it (ADR 0066) | Phase 73 smoke; Phase N golden path: the issuer is refused with `segregation-of-duties`, another person approves |
| An erased subject lingers in the index or in answers | Deletion and tombstones per document; party erasure ends each attachment; person erasure destroys the conversation key | Phase N golden path (both modes): after the party's erasure its document is gone from search, the agent and the assistant. Phase 76 smoke: an erased person's conversations and key are gone |
| A search or an answer tells a person that a record they cannot read exists | Roles filter inside the scan; the assistant's tools are the person's modules only | Phase 75 e2e and smoke: the invoice's words answer exactly as nonsense; Phase 76 smoke: a person without Financial gets no Financial source |
| The model provider receives data nobody agreed to send | Off by default; only an owner turns it on, by accepting the notice; no key means unavailable, and nothing is sent | Phase 76 smoke, and `--no-provider`: 0 tokens spent |
| A suggestion writes | Accepting only fills the form's field; decisions are counted, never stored | Phase 77 smoke: the audit entry of an accepted NCM equals a typed one |
| Suggestion history is poisoned by one workspace's users | It only ever votes inside that workspace, and every suggestion shows the records it came from | Phase 77 e2e and smoke; the reason is on every chip |
| A tampered NCM table misleads everyone | It is built from the Siscomex download by a script in the repository, and loaded only from the image | `scripts/build-ncm-table.mjs`; `knowledge/data/ncm-table.json.gz` is reviewed like code |
| The agent's own page floods the gateway | `useLoader` takes stable functions only | **Found in Phase 78:** Developers → Agent reloaded on every render, some 200 requests a minute, which spent Kong's per-address limit. Fixed, with a web test that forbids an inline loader |

## Open

- **Backups keep derived data for about 42 hours.** Vectors, keyed hashes and sealed chunks
  deleted from the live index survive in base backups until the seventh newer one
  replaces them (every 6 hours). Sealed text needs the master key, but vectors are not
  sealed. See [privacy.md](privacy.md#ai-data-and-its-subprocessor-phase-n).
- **The Anthropic adapter was never run against the real API.** No key was available.
  It is proven against a fake `fetch` (request, tool choice, parsing, refusals), and the
  structural defences (closed tools, cited statements) do not depend on the model.
- **A stolen key is usable until it is revoked.** The per-key rate limit bounds its speed,
  and the audit names every call.
  - *Since Phase 81*, Identity counts refused and rate-limited exchanges, and
    `ApiKeyExchangesRefused` fires on a burst. The log names the key by its prefix. See
    the [runbook](service-levels.md#apikeyexchangesrefused).
  - What stays open: a stolen key used within its limit, and never refused, looks like its
    owner. Only its audit trail shows it.

## Closed since

- **Master key rotation (Phase 81).** `KNOWLEDGE_MASTER_KEY` and `ASSISTANT_MASTER_KEY`
  are rings: a current key and retiring ones.
  - Each wrapped key names its master key. A worker rewraps every document and person key
    under the current one, and reports when none is left.
  - The drill rotated both keys on the running stack, retired the old ones, and rotated
    back. Documents and conversations read throughout
    ([record](drills/2026-09-30-phase81-rotation-drill.json)).
  - The procedure is in the [runbook](service-levels.md#rotating-a-master-key-phase-81).
  - The Phase M keys are not part of this.
