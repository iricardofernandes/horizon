# 69. Models are ports, generation is opt-in, and nothing depends on them

- Status: accepted; planned for Phases 74–77 ([Phase N plan](../ai-implementation-plan.md)).
- Date: 2026-09-29

## Context

ADR 0035 established that Horizon runs fully with no model available and no Anthropic key
present. Phase N adds embeddings, generation and suggestions. Sending tenant data to a
model provider makes that provider a subprocessor, which is a decision for the workspace,
not for Horizon.

## Decision

- **Embeddings are a port.**
  - CI uses a deterministic hash adapter.
  - The stack's `ai` profile runs a local multilingual model (`multilingual-e5-small` on
    Text Embeddings Inference).
  - No tenant text leaves the stack to be embedded.
- **Generation is a port.**
  - The Anthropic adapter takes its model id from configuration (default
    `claude-opus-5-5`).
  - CI uses a deterministic extractive adapter.
- **Generation is off until a workspace owner turns it on,** after a notice that names the
  provider and what is sent.
  - A monthly token budget applies per workspace.
  - Turning it off stops sending at once.
- **Suggestions** start from the tenant's own confirmed history (nearest neighbours). A
  model only re-ranks them when generation is on.
- **With the `ai` profile off and no model key,** every screen and flow of Phases A to M
  works. The golden path runs that way in CI.

## Consequences

- Nothing about Horizon's correctness depends on a model being available or right.
- Local embeddings cost memory in the stack, so the `ai` profile is opt-in.
- A model change is configuration plus a re-embed, never a code change in a module.

## Alternatives considered

**A hosted embedding API.** Rejected as the default: it would send every document outside
the stack, before any workspace consents to anything.

**Generation on by default.** Rejected: it makes a subprocessor decision for the customer.
