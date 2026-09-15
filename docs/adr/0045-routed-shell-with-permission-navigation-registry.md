# 45. A routed frontend shell with a permission-driven navigation registry

- Status: accepted
- Date: 2026-09-15

## Context

The authenticated product is one client component. `web/src/app/app/page.tsx` holds a
nine-value `view` union, the navigation array, the state and fetches for orders, webhooks
and deliveries, and the dialogs for several screens, in roughly 1,200 lines. The six
feature views under `web/src/features/` each fetch and render their own data.

Nothing below `/app` is a route. No screen can be bookmarked or linked, the browser's back
button leaves the application instead of moving between screens, there is no place to put a
loading or error boundary, and every screen's code is downloaded to show any screen.

Navigation is filtered only by the hosted-demo flag. A user without a module's role is
still offered its screen and discovers the restriction when the API refuses the call.

The expansion adds Finance, Purchasing, Fiscal, Services, CRM and Reports. Adding them to
this shape is not a maintenance concern for later; the file becomes unworkable before the
first of them ships.

## Decision

The application shell becomes nested App Router segments under `/app`, one per screen, each
with its own `loading` and `error` boundary, and one shared layout that owns the sidebar,
the workspace switcher, the user menu and the language switcher.

Navigation comes from a single **registry**: an array of entries carrying route, message
key, Phosphor icon and the module role a user must hold to see it. The sidebar is rendered
from the registry, and so is the mobile drill-down. Adding a screen means adding an entry.

The registry decides **visibility only**. Authorization remains server-side: the gateway
and each service enforce module-scoped roles (ADR 0023), and a route that is reachable by
typing its URL renders a permission-denied state from the API's own refusal rather than
trusting the client's copy of the user's roles.

Each feature owns a folder under `web/src/features/<context>/`, holding its views, its
types and its data access. The shell owns no feature state.

Shared behaviour — the typed fetch client over `tracedFetch` with RFC 9457 error handling,
list state, table, drawer and confirmation patterns, and the `Intl` formatters — lives in
shared modules, not copied per feature.

## Consequences

- Screens are linkable, the back button works, and each route loads its own code.
- A user sees a navigation that matches what they may do, and the server still refuses what
  the client would have allowed, so a stale client cannot grant access.
- The permission required by a route is declared in one readable place, which is also where
  a reviewer checks that a new screen has one.
- The refactor is behavior-preserving but touches every screen at once, and the browser
  golden path must keep passing through the new routes, with selectors bound to roles and
  test ids rather than to English copy.
- A shared layer exists to be reused: a feature that re-implements a table or a formatter is
  a review finding, not a style preference.

## Alternatives considered

**Keeping client-side view state and adding screens to it.** No migration and no routing
work. Rejected: it scales the existing problem by the size of the ERP expansion.

**Route groups per role (`/app/(finance)/...`).** Encodes permission in the file tree, which
reads well until a screen requires two roles or a role is renamed. The registry keeps the
mapping as data, where it can be tested.

**Server-rendered pages with per-page permission checks and no registry.** Correct but
incomplete: the sidebar still needs a list, and without a registry it becomes a second,
drifting source of truth.
