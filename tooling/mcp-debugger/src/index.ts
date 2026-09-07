/**
 * Read-only MCP server over the observability plane (ADR 0035).
 *
 * Opt-in behind HORIZON_MCP_DEBUGGER_ENABLED, default false. Horizon runs fully with
 * this disabled and with no Anthropic API key present; it is not a runtime dependency
 * of any module.
 *
 * Contents arrive in phase 12, deliberately late — the tools have nothing to read
 * until logs, traces and metrics actually flow.
 */

export {}
