# Claude Code Instructions

Read `Documentation/CLAUDE_CODE_HANDOVER.md` before making changes.

This repository is BluelineGPT only. Do not introduce content or assumptions from another project.

## Driver Cash Reconciliation hold

The current Driver Cash Reconciliation phase has completed its required pre-execution review, but implementation is awaiting explicit approval of the business decisions listed in the handover. Do not modify Driver Cash Reconciliation code or its related database objects until those decisions are approved.

Scope of this hold — it is not a global database freeze:

## Approved enhancements

The following enhancements are approved for implementation:

- **Multi-level order grouping** (Area, Trader, Driver, Status) with full emirate name display (e.g., "Sharjah - Abu Shagara") to improve order management UX.

## Code modification boundary

- It blocks **only** Driver Cash Reconciliation implementation and the database objects belonging to that phase.
- It does **not** block unrelated schema work, including Trader Commerce and Storefront work.
- Unrelated database work is still subject to its own safety gates: live-schema verification, a verified backup before any write, correct migration ordering, deterministic backfill, and hard validation before any column is made mandatory.
- Regardless of phase, do not change reconciliation, Orders, settlements, Journal Entries, Accounting, or `file_objects` as a side effect of unrelated work.

Use these local ports:

- API: 3000
- Web: 5174

Do not use ports 5173 or 8787.

Never print or expose values from `.env` or `Bluelineconfig`.

## Deployment registry — required after every code change

`Documentation/deployment-registry.json` is the single source of truth for
"is this app's Render deploy caught up with local." It is read by the
Deployment Registry screen (Platform Administration, and a read-only view
under the Company Portal's Administration section). This file must be kept
current — a stale entry defeats the entire point, which is telling the user
what's actually live without them having to open both environments and
compare by hand.

Whenever you commit a change under `apps/api`, `apps/web`, `apps/platform-web`,
or `apps/store`, before ending your turn:

1. Find that app's entry in `Documentation/deployment-registry.json` (by `id`).
2. Update `lastChange`: `commit` (short SHA of the commit you just made),
   `date` (ISO date), `description` (one line, user-facing — what changed,
   not how), and `by` (`"claude"` or `"codex"` — whichever you are).
3. Set `status`:
   - `"needs_deploy"` the moment you commit, before you push.
   - `"pushed_awaiting_confirmation"` once you push.
   - Never set `"confirmed_live"` yourself — that field is only set when the
     user explicitly confirms Render is showing the change (same as the
     deploy-verification pattern already used throughout this project). Leave
     it at `"pushed_awaiting_confirmation"` until they say so.

Do not skip this because the change felt small. The registry is only useful
if it is never wrong.

## Version badge — required on every user-facing app

Every app with a UI (currently `apps/web`, `apps/platform-web`) must show a
small build-version badge on every screen, in its shared header/layout — not
added page by page. It displays `__APP_VERSION__`, a short git commit SHA
that `vite.config.ts` bakes in at build time via `define` (see `apps/web`'s
`VersionBadge` component and `vite.config.ts` for the working pattern to
copy). This is the direct, trustworthy way to confirm what commit a running
app — local or Render — is actually serving: open the app, read the badge.
Never hand-type this value or derive it any other way; it must always come
from git at build time, or the whole point of it is lost.

## Crash reporting — required on every app

Every app (`apps/web`, `apps/api`, `apps/platform-web`, `apps/store`,
`mobile_app`) must report its own uncaught crashes to the Platform's Error
Handler screen — automatically, with no manual step, the moment a crash
happens. This is `client_error_reports` (`Documentation/deployment-registry
.json`'s sibling table) via `POST /errors` (authenticated apps — `web`,
`platform-web`) or `POST /errors/public` (apps with anonymous users —
`store`, `mobile_app`, before sign-in). See `ClientErrorReportController`'s
own comment for why there are two routes, not one, and
`apps/web/src/api/error-reporting-client.ts` /
`apps/store/src/api/error-reporting-client.ts` /
`mobile_app/lib/core/reliability/crash_reporter.dart` for the working
pattern to copy for a new app. Backend 500s are captured automatically by
`ApiExceptionFilter` — nothing to add there.

A new app is not done until its crash reporting is wired in, the same way
it is not done without a version badge.
