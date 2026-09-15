# 44. Localization stops at the presentation boundary

- Status: accepted
- Date: 2026-09-15

## Context

The product's users work in Brazilian Portuguese; its code, identifiers, commits and
documentation are in English by convention (CONTRIBUTING.md). The frontend currently has
every string inline in English, so the first question of the expansion is not whether to
translate, but how far translation is allowed to reach.

The dangerous version is the one that reaches into contracts. A localized enum value, a
translated permission name or a path segment that differs per language turns a display
preference into a compatibility problem: consumers of `@horizon/contracts` would have to
know a language, and an audit record would mean something different depending on who wrote
it.

## Decision

Translation applies to rendered text and nothing else.

These remain English, permanently, and are never localized: API paths, JSON property
names, enum values, event types and envelope fields, module and permission names, audit
action names, error codes, log and metric fields, database identifiers, and the values
stored in any of them.

These are translated: every string a user reads — labels, headings, help text, validation
messages, empty states, dialog copy, accessible names and notification text. Enum and
status values are mapped to translated labels at the view boundary, never at the source.

Locale is a property of the **global user**, not of the workspace, resolved as: the
signed-in user's preference, then a locale cookie, then the browser's preference, then
`pt-BR`. A workspace separately holds legal country, timezone, base currency and fiscal
regime; those drive calculation and are not display preferences.

Authenticated URLs are language-neutral. There are no localized route segments and no
locale prefix, so switching language never invalidates a bookmarked resource. `/api/**` is
never localized.

Numbers, dates, currency, relative time and plurals are formatted through a single `Intl`
layer at the view boundary. User-entered data, tax identifiers, SKUs and tokens are
rendered exactly as stored.

## Consequences

- A contract consumer, an audit reader and a log query behave identically regardless of the
  user's language, which is the property that makes the events catalogue meaningful.
- Message catalogues must stay key-identical across locales, so CI compares their key sets
  and fails on a newly introduced raw string in a component.
- Every enum gains a translation map in the frontend, which is a visible place to notice
  that a status has been added without a label.
- The ERP forfeits localized URLs. For an authenticated business application with no SEO
  surface, that is not a loss.
- A user switching language does not switch workspace, and a workspace's currency does not
  follow the reader's language — a Brazilian workspace read in English still reports BRL.

## Alternatives considered

**Locale-prefixed routes (`/pt-BR/app/...`).** The conventional Next.js layout, and correct
for public content. Rejected here: it makes every shared link language-specific and turns a
preference change into a navigation.

**Server-side translation driven by `Accept-Language`.** Would let the API return ready-to-
display text. Rejected: it makes the API's response body depend on a header, breaks caching
and contract tests, and localizes exactly the values that must stay stable.

**Keeping the interface in English only.** Cheapest, and wrong for the intended operator,
who is not required to read English to run a business.
