# BluelineGPT Platform Administration Portal — Phase 1, Prompt 1

## Repository Audit, Architecture and Implementation Plan

Audit date: 7 August 2026
Branch audited: `ui-v2.0`
Scope: **audit and design only**. No Platform Portal functionality was implemented.

---

## A. Executive Summary

**`READY_WITH_REQUIRED_PREREQUISITES`**

The repository is BluelineGPT, is a pnpm monorepo, and is in a state where the
architecture can be audited reliably. Authentication, tenant isolation, the
Company model and the reset engine were all identified from repository evidence.

The audit found substantially **more existing Platform foundation than the
prompt assumed**:

- `accounts.account_kind` already includes `platform_administrator`, and the
  schema **requires** such an account to have `company_id is null`
  (`accounts_scope_check`).
- `IdentityKind` in the API already models `platform_administrator`, and
  `IdentityContext.companyId` is already `string | null`.
- A Platform login endpoint already exists: `POST /api/v1/platform/auth/login`.
- A Platform administrator bootstrap already exists, with an advisory lock, a
  single-use guard and an audit event.
- `roles` already supports Platform-scope rows (`company_id is null`, with
  `roles_platform_code_unique`).
- The `platform.*` permission namespace is **already reserved**: Company role
  management explicitly excludes it
  (`apps/api/src/roles/role.service.ts:90` — `where code not like 'platform.%'`).
- `audit_events` is already append-only, already allows `company_id is null`
  (Platform-level events), and already carries actor, correlation id, IP,
  user agent and before/after data.

Three prerequisites must be resolved before Prompt 2 is implemented. They are
listed in section S.

---

## B. Repository Architecture

### Applications

| Path | Package | Framework | Port (dev) | Deployed |
| --- | --- | --- | --- | --- |
| `apps/api` | `@blueline/api` | NestJS 11 + Kysely + PostgreSQL | 3000 | `Dockerfile.api` |
| `apps/web` | `@blueline/web` | React 19 + Vite + react-router | 5174 | `Dockerfile.web` |
| `apps/store` | `@blueline/store` | React 19 + Vite + react-router | 5175 | **no Dockerfile** |
| `mobile_app` | Flutter | Dart/Flutter | n/a | CI-built APK |

`pnpm-workspace.yaml` declares `apps/*` only. There is no `packages/` directory —
**this repository has no shared-package convention today.**

`apps/store` is the decisive precedent: it is a second React application, added
with its own `package.json`, its own `vite.config.ts`, its own port and its own
same-origin `/api` dev proxy. It shares **no** code with `apps/web` through a
package. A third application follows the same established pattern.

### API

- Global prefix `api/v1` (`apps/api/src/bootstrap/create-application.ts`).
- Modular monolith (ADR-002). Modules registered in `apps/api/src/app.module.ts`.
- `helmet`, global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`),
  global `ThrottlerGuard` (default 100 req / 60 s, env-tunable).
- CORS: explicit allow-list, `credentials: true`, wildcard rejected, HTTPS
  enforced in production (`configuration/environment.ts`).
- Swagger served only outside production.

### Database

PostgreSQL. 90 forward migrations in `database/migrations/`, run by Kysely
(`kysely_migration`). Heavy use of database-enforced integrity: composite
`(id, company_id)` foreign keys, `exclude using gist` for effective-dated rows,
immutability triggers, and append-only triggers.

### Authentication

- `POST /api/v1/auth/login` — Company login. The Company is resolved **from the
  request host**, never from the body (`CompanyHostResolver`). The old
  `GET /auth/companies` enumeration endpoint has been removed; ADR
  `login-company-selection-and-company-list-exposure.md` is now stale — Option A
  was implemented.
- `POST /api/v1/platform/auth/login` — Platform administrator login
  (`PlatformAuthenticationController`).
- Passwords hashed via `PasswordHasher`; plaintext never stored or returned.
- Failed-login counter with `locked_until` lockout (`AUTH_LOCKOUT_MINUTES`,
  default 15, max 5 attempts enforced by a check constraint).
- Temporary passwords with `force_password_change` and an expiry.

### Sessions

- Server-side in `account_sessions`: SHA-256 `token_hash`, `expires_at`,
  `revoked_at`, `created_ip`, `user_agent`.
- Dual transport: `Authorization: Bearer <43-char token>` **and** an `HttpOnly`,
  `SameSite=Lax`, `Path=/api` cookie (`blueline_session`), `Secure` in
  production only.
- CSRF: a cookie-authenticated **state-changing** request must also carry
  `X-Blueline-Session: cookie`. Bearer requests are exempt by design.
- A trigger (`account_sessions_scope_guard`) forces the session's `company_id`
  to equal the account's `company_id`.

### Companies

`companies` — `id`, `code` (unique, case-insensitive), `subdomain` (unique,
DNS-label checked), `name_en`, `name_ar`, `subtitle_en`, `subtitle_ar`,
`address_en/ar`, `telephone`, `email`, `logo_file_id`, `trade_license_number`,
`trade_license_expiry_date`, `tax_registration_number`, `status`,
`activated_at`, `disabled_at`, optimistic-lock `version`.

`status` is constrained to **`active` | `disabled` only**.

`company_settings` — `base_currency` (locked to AED), `default_language`
(en/ar), `timezone`, VAT settings, alert thresholds.

`company_business_day_configurations` — effective-dated business-day rule
(start time + timezone), non-overlap enforced by `exclude using gist`.

### Users

`accounts` (login identity, four kinds) → `company_users` (Company profile,
1:1 with account) → `employees`. `user_business_links` links an account to a
Trader/Driver business entity.

### Roles and permissions

`permissions` (code catalog) → `role_permissions` → `roles` → `account_roles`.
Roles are Company-scoped **or** Platform-scoped (`company_id is null`).
Permissions are enforced by `AuthenticationGuard` via
`@RequirePermissions` / `@RequireAnyPermission` / `@RequireIdentityKinds`
metadata, resolved per request from the database. Services additionally
re-resolve the Company from `TenantContextAccessor` — the frontend never
supplies it.

### Configuration

Typed columns plus dedicated tables. `configuration/environment.ts` validates
every environment variable at startup and refuses unsafe production values
(local DB host, wildcard CORS, HTTP origins, dev tenant fallback).

### Deployment

`Dockerfile.api` (port 3000) and `Dockerfile.web` (static, port 8080).
`compose.local.yaml` is local-only. Production ingress/TLS/host routing are
described in `Documentation/Architecture/DEPLOYMENT_ARCHITECTURE.md` but are
not yet provisioned.

---

## C. Existing Platform Capabilities

These already exist and must be reused, not rebuilt:

| Capability | Evidence |
| --- | --- |
| Platform account kind | `accounts_kind_check` + `accounts_scope_check`, `20260713230000_core_tenancy_security.ts` |
| Platform account global username uniqueness | `accounts_platform_username_unique`; `accounts_platform_normalized_username_unique` |
| Platform identity in the API | `apps/api/src/security/identity-context.ts` — `IdentityKind`, `companyId: string \| null` |
| Platform login endpoint | `PlatformAuthenticationController`, `apps/api/src/authentication/authentication.controller.ts` |
| Platform administrator bootstrap | `apps/api/src/platform/platform-administrator-bootstrap.ts`, script `security:bootstrap-platform` |
| Platform-scoped roles | `roles_platform_code_unique` |
| Reserved `platform.*` permission namespace | `apps/api/src/roles/role.service.ts:90` |
| Platform-level audit rows | `audit_events.company_id` nullable; bootstrap writes one |
| Append-only audit | `reject_audit_mutation()` trigger |
| Development Company provisioning | `apps/api/src/platform/development-company-bootstrap.ts` |
| Per-Company defaults seeding | `apps/api/src/platform/company-defaults.ts` |
| Company test-data reset | the four reset files (section D) |
| Demo/fixture seeding | `apps/api/src/platform/reconciliation-demo-seed.ts` |
| UAE area import | `apps/api/src/platform/uae-area-import.ts` |

**Not present:** any Company-management HTTP API. There is no `/companies`
controller anywhere. `@Controller` inventory confirms it.

---

## D. Existing Reset Capability

### Files

| File | Lines | Role |
| --- | --- | --- |
| `apps/api/src/platform/reset-company-test-data.manifest.ts` | 714 | Classification, live-schema introspection, ownership resolution, dependency ordering, readiness blockers. **Read-only.** |
| `apps/api/src/platform/reset-company-test-data.ts` | 233 | Dry-run report. Runs inside `begin transaction read only`. **No write capability.** |
| `apps/api/src/platform/reset-company-test-data.engine.ts` | 415 | Execution. Caller owns the transaction; never commits. |
| `apps/api/src/platform/reset-company-test-data.cli.ts` | 222 | CLI entry, argument gates, backup, commit/rollback. |
| `reset-company-test-data.safety.test.ts` | 138 | Static safety assertions. |
| `reset-company-test-data.guards.test.ts` | 197 | Argument/backup gate unit tests. |
| `reset-company-test-data.database.test.ts` | 326 | Database-backed test, gated by `RUN_RESET_DATABASE`. |

### Structure

- **Manifest**: `PURGE_TABLES` (95 entries), `PRESERVE_TABLES` (36 entries),
  `CONDITIONAL_TABLES` (deliberately empty), `GLOBAL_TABLES` (7 entries),
  `CYCLE_BREAKS` (2), and `MODULE_RULES` (17 module groupings).
  Anything in the live schema not present in a classification list becomes
  `UNSAFE` and **blocks the reset** — new tables cannot slip in silently.
- **Engine**: introspects `information_schema` and `pg_catalog` at run time; it
  does not trust a hard-coded table list.

### Safety properties (all verified in source)

| Property | Mechanism |
| --- | --- |
| Production block | `computeBlockers` pushes a blocker when `NODE_ENV === "production"`; `rejectionReason` refuses `--execute` in production "with no bypass" |
| Development-Company-only | `computeBlockers` requires the Company `code` to match `/^DEV-/i` |
| Company isolation | every delete is `delete from <t> where company_id = $1`; engine throws unless ownership is `direct` |
| No dynamic SQL injection | `quoteIdentifier` rejects anything not `/^[a-z_][a-z0-9_]*$/` |
| Rollback safety | engine never commits; CLI wraps in `begin` / `commit` / `rollback` |
| Guard suspension | only triggers listed in `APPROVED_TRIGGERS` (52 names across 7 approved reasons) may be disabled, inside the transaction only |
| Guard restoration proof | re-reads `pg_trigger.tgenabled` and refuses to commit if any is still disabled |
| Ownership precondition | refuses if the current role does not own a table whose trigger must be suspended |
| Parent-total guard precondition | `requiresCleared` — refuses unless `journal_entries` / `opening_balance_batches` are in the removal set |
| FK cycle handling | `CYCLE_BREAKS` nullifies `journal_entries.accounting_event_id` and `conversations.last_message_id` first; unbroken cycles block |
| Post-reset verification | every removal-set table re-counted to zero before commit |
| Preserved-table verification | every preserved Company-scoped table re-counted and compared to its pre-reset count |
| Backup | `pg_dump --format=custom` to `.backups/`; missing `pg_dump` **stops** execution unless `--allow-no-backup` is passed explicitly |
| Double confirmation | `--execute` **and** `--confirm-company-id` matching `--company-id` exactly |

### Preserved data

The 36 `PRESERVE_TABLES` include `companies`, `accounts`, `account_sessions`,
`account_roles`, `roles`, `role_permissions`, `permissions`, `company_users`,
`company_settings`, `company_business_day_configurations`, `chart_of_accounts`,
`account_mappings`, `accounting_configurations`, `accounting_periods`,
`fiscal_years`, `company_cash_accounts`, `company_bank_accounts`, `areas`,
`emirates`, `audit_events`, `password_reset_tokens`, `file_objects`,
`kysely_migration`, and **`trader_commerce_profiles`**.

### Global Commerce handling

`trader_commerce_profiles` is in **both** `PRESERVE_TABLES` and `GLOBAL_TABLES`.
It has no `company_id` column. `resolveOwnership` returns `kind: "global"`, and
`buildCountStatement` for a global table produces an unparameterised count used
for reporting only — never a delete. The Company-scoped links
(`trader_commerce_company_links`, `trader_delivery_company_relationships`) and
the storefront tables **are** in the removal set. This distinction is correct
and must be preserved.

### Reuse recommendation

**Reuse the engine unchanged.** The Platform API must call `runReset` through a
thin Nest service that owns the transaction exactly as the CLI does. No second
manifest, no second engine, no Platform reset SQL.

---

## E. Company Management Gaps

| Area | State |
| --- | --- |
| Company creation via API/UI | **Missing.** Only `bootstrapDevelopmentCompany`, a dev-only script path. |
| Company list/read API | **Missing.** No `/companies` controller. |
| Company profile editing | **Partial.** `/company-profile` exists but is Company-self-service, `company_user`-only, and edits only names, subtitles, telephone and logo. |
| Lifecycle states | **Partial.** `active` / `disabled` only. No draft, pending activation, suspended, or closed. |
| Company environment/type | **Missing.** The `DEV-` code prefix is the de-facto marker and is a naming convention, not a typed column. |
| Company slug | **Existing** — `subdomain`, uniquely indexed and format-checked. |
| Soft deletion | **Partial.** `disabled_at` exists; every FK is `on delete restrict`, so hard deletion is effectively impossible by design. |
| First Company Admin creation | **Partial.** Exists only inside the dev bootstrap script. |
| Company-user administration | **Existing and strong** — see section below. |
| Billing / subscription | **Missing.** |
| Usage metering | **Partial.** `saas_usage_events` exists (`order_submitted` only, with `billing_period_start` and an idempotency key). |
| Module enablement / feature flags | **Missing.** |
| Mobile / WhatsApp / payment configuration | **Missing.** `whatsapp_number` is a contact field on commerce/storefront records only. |

### Company user management — reusable as-is

`apps/api/src/users/user-administration.service.ts` already implements:
`list`, `details`, `create`, `edit`, `assignRoles`, `deactivate`, `reactivate`,
`lock`, `unlock`, `resetPassword`, `setForcePasswordChange`, `sessions`,
`revokeSession`, `revokeSessions`, `auditHistory`.

`password_reset_tokens` already provides single-use (`used_at`) and expiring
(`expires_at`) tokens with a scope-guard trigger.

**Constraint:** the controller is annotated `@RequireIdentityKinds("company_user")`
and the service resolves the Company from `TenantContextAccessor`. A Platform
actor has `companyId === null`, so `TenantContextAccessor.current()` throws.
Reuse therefore requires a **target-company context**, not a change to these
services' security posture.

---

## F. Logs and Audit Findings

| Source | Company-scoped | Actor | Correlation | Immutable | Notes |
| --- | --- | --- | --- | --- | --- |
| `audit_events` | yes (nullable → Platform rows allowed) | `actor_account_id` | `correlation_id` not null | **yes** (`reject_audit_mutation`) | also `ip_address`, `user_agent`, `before_data`, `after_data`, `reason` |
| `order_status_history` | yes | yes | — | append-only trigger | |
| `order_events` | yes | yes | — | append-only trigger | |
| `order_assignments` | yes | yes | — | history guard | |
| `account_sessions` | yes | account | — | no | login/session record incl. IP + UA |
| `balance_override_audits` | yes | yes | — | unique-constrained | |
| `accounting_configuration_history` | yes | yes | — | — | |
| `realtime_event_log` | yes | audience account | sequence number | no | 14-day `expires_at` |
| `communication_notification_outbox` | yes | recipient | — | no | `status` pending/processed |
| `idempotency_records` | yes | — | idempotency key | no | expiring |
| `saas_usage_events` | yes | — | idempotency key | no | billing-period stamped |
| HTTP request log (pino) | not structured per Company | — | `x-correlation-id` echoed | n/a | redacts `authorization`, `cookie`, `req.body.password`, `req.body.token`, `set-cookie` |

**Strengths:** `audit_events` is a genuinely append-only, correlation-carrying,
Company-and-Platform-capable audit table. It is already the right home for
Platform audit.

**Gaps:**
1. No `result` / `failure_reason` column — failures cannot be distinguished from
   successes except by `action` naming convention.
2. No `source_application` column — a Platform action and a Company action are
   indistinguishable by origin.
3. No target-user column distinct from `subject_id` (usable, but untyped).
4. `audit_events` is in `PRESERVE_TABLES`, so a Company reset does **not** delete
   it. This is already correct and must stay correct.
5. Retention is defined only for `realtime_event_log`. No retention policy
   elsewhere.
6. The pino HTTP log has no Company dimension, so per-Company API log views
   cannot be built from it today.

---

## G. Data Integrity / One-Leg Risk Findings

The repository already contains a **working, read-only, set-based one-leg
detector**, which is the strongest possible evidence for the Phase 2 design:

`apps/api/src/accounting/accounting-recovery.service.ts` detects
"delivered Orders without an `order_delivered` Accounting Event" and
"Outsourced Driver fee accruals without an `outsourced_driver_fee_accrued`
Event or Journal", classifies each row with a reason code
(`accounting_period_missing`, `accounting_event_mapping_missing`, …) and a
recommended action (`create_missing_event`, `reprocess_event`,
`review_manually`, `none`). It is explicitly documented as a prediction that is
never more permissive than the poster, and its row shape already matches
`accounting_batch_items`.

### Findings

**Critical**

- *One-leg financial transactions are a known, present condition, not a
  hypothesis.* The existence of `accounting-recovery.service.ts`,
  `accounting-reprocess-precheck.service.ts`, the `accounting_batch_*` tables
  and migration `20260805280000_historical_recovery_batch_support.ts` proves the
  system has already accumulated delivered Orders without their accounting leg.
  No Company-wide, cross-module detector exists — coverage is accounting-only.

**High**

- *`journal_entries.accounting_event_id` is nullable.* Confirmed by
  `CYCLE_BREAKS`, which relies on that nullability. A journal can therefore
  exist with no source event, and nothing detects it.
- *No cross-module detector for the non-accounting legs.* Driver collection →
  trader payable, settlement → allocation, storefront order → delivery order,
  and mobile-command → backend-state have no equivalent of the accounting
  recovery preview.
- *`communication_notification_outbox` rows can remain `pending` indefinitely.*
  The index exists; no detector or age alert does.

**Medium**

- *`realtime_event_log` rows expire after 14 days* (`expires_at` default). Any
  integrity rule that compares an operational record to its realtime event must
  be bounded to that window or it will produce false positives on older data.
- *The reset manifest's `MODULE_RULES` are report-only groupings*, derived from
  table-name prefixes. They are not a business-module dependency graph and must
  not be mistaken for one when the modular reset is designed.

**Low**

- *Cross-company relationships are structurally very hard to create.* Composite
  `(id, company_id)` foreign keys are used pervasively, and
  `integrity.database.test.ts` asserts cross-tenant inserts fail with a `23*`
  SQLSTATE. Cross-company one-leg risk is materially lower than orphan risk.

---

## H. Recommended Architecture

### Platform web application — `apps/platform-web`

A **new, separate Vite + React application** in the monorepo.

Evidence: `apps/store` established exactly this pattern (own package, own port,
own vite config, own `/api` same-origin proxy, zero shared packages). There is
no `packages/` directory, so extracting shared UI code would mean inventing a
workspace convention that does not exist — a change with regression risk across
the entire Company portal for no Platform benefit.

Port: **5176** (5174 = web, 5175 = store, 3000 = API; 5173 and 8787 are
forbidden by project instructions).

`apps/web` and `apps/mobile` are **not modified**.

Duplicate the small amount needed (API client shape, error rendering, i18n
bootstrap) rather than extracting shared packages in Phase 1. Revisit extraction
only after the Platform Portal is stable and a genuine, low-risk seam exists.

### Platform API — new `PlatformModule` in the existing API

Routes under the existing global prefix: `/api/v1/platform/...`.

Rationale: `platform/auth` already lives there, the domain services to be reused
(`UserAdministrationService`, the reset engine) already live there, and a second
API application would duplicate database access, configuration validation and
the session store. Register a new `PlatformModule` in `app.module.ts`.

### Platform user model — existing `accounts`, no new table

`accounts.account_kind = 'platform_administrator'` with `company_id is null`,
already enforced by `accounts_scope_check`. A dedicated Platform-user table
would fork session management, lockout and password handling for no gain, and
would contradict the existing bootstrap and login path.

### Platform role model — Platform-scoped `roles` + `platform.*` permissions

Use `roles` with `company_id is null` (index already present). Put every
Platform permission under the **already reserved** `platform.*` namespace, which
Company role management already filters out. Role collision is therefore
structurally impossible.

**Phase 1 minimum:** one role, `platform_super_admin`, and a small permission
set. Do not create the five speculative roles.

Suggested Phase 1 permissions:

- `platform.companies.read`
- `platform.companies.manage`
- `platform.company_users.read`
- `platform.company_users.manage`
- `platform.audit.read`

`platform.maintenance.reset` is deliberately **excluded** from Phase 1.

### Target-company context

Add a `PlatformTargetCompanyGuard` + `@TargetCompany()` binding that:

1. reads the Company id **only** from the route parameter `:companyId`;
2. rejects anything that is not a UUID;
3. re-resolves the Company row from the database on every request;
4. rejects unknown Companies with the same response as inaccessible ones;
5. enters the target Company into `RequestSecurityContextStore.tenant` for the
   duration of the request **without** changing `identity.companyId`;
6. writes an `audit_events` row for the cross-Company access.

Step 5 is the key reuse mechanism: it makes `TenantContextAccessor.current()`
return the target Company, so `UserAdministrationService` and other existing
Company-scoped services work unchanged under a Platform actor. `identity` stays
Platform, so `@RequireIdentityKinds` and permission checks stay honest.

Company name, environment and any other Company attribute supplied by the
browser must be ignored entirely.

### Company lifecycle

Extend `companies_status_check` to `draft | active | suspended | disabled`.

- `draft` — created, no admin yet, cannot log in.
- `active` — normal.
- `suspended` — login refused, data retained, reversible.
- `disabled` — existing terminal state; keep the name to avoid rewriting the
  existing login check (`account.companyStatus === "disabled"` in
  `authentication.service.ts`).

Do **not** add `pending_activation` or `closed`. `draft` covers the former and
`disabled` covers the latter, and each extra state multiplies transition tests.

Add `status_changed_at`, `status_changed_by_account_id` and a status-transition
audit action.

### Company environment

Add a typed, **server-only** column `companies.environment` with values
`development | demo | sandbox | trial | production`, defaulting to `production`
so that an unmigrated or newly created row is never accidentally resettable.
Backfill: `DEV-*` code → `development`, everything else → `production`.

This column — never the browser, never `NODE_ENV` alone — becomes the source of
truth for whether destructive maintenance is permitted. The existing `DEV-`
code check stays in place as a second, independent gate.

### Configuration model

Typed columns and dedicated tables, following the established repository style
(`company_settings`, `company_business_day_configurations`). For module
enablement, a narrow `company_modules` table (`company_id`, `module_code`,
`enabled`, `enabled_at`, `enabled_by_account_id`) with a checked `module_code`
enum. **No** general-purpose JSON settings blob.

### Platform audit model

Reuse `audit_events`. It is already append-only, already Platform-capable, and
already excluded from Company reset. Add three columns:

- `result` (`success` | `failure`), not null default `success`
- `failure_reason` text
- `source_application` (`company_portal` | `platform_portal` | `store` | `mobile` | `system`)

Use `action` values namespaced `platform.*`. Never write passwords, tokens or
integration secrets; the existing `before_data`/`after_data` writers must mask.

### Reset integration model

```
Platform Admin UI  →  Platform Admin API  →  ResetService (thin Nest wrapper)
                                          →  runReset()   (existing engine, unchanged)
                                          →  PostgreSQL
```

The wrapper owns `begin` / `commit` / `rollback` exactly as the CLI does, calls
the existing `runDryRun` for preview and the existing `runReset` for execution,
and writes a permanent `platform_reset_audits` row **outside** the reset
transaction so a rollback cannot erase the attempt record.

`platform_reset_audits` must be added to `PRESERVE_TABLES` in the same change
that creates it, or the manifest will classify it `UNSAFE` and block every
reset. That is the manifest working correctly.

### Integrity engine model

Follow `accounting-recovery.service.ts`: declarative rules, one set-based SQL
statement per rule, `LATERAL` lookups, database-side counting and paging, no
per-row application loop. Persist issues in `integrity_issues`
(`rule_code`, `company_id`, `severity`, `entity_type`, `entity_id`,
`first_detected_at`, `last_detected_at`, `status`, `evidence` jsonb,
`correlation_id`), deduplicated on `(company_id, rule_code, entity_type,
entity_id)`. Detect-only first; auto-fix is a separate, separately-audited
decision.

Load protection: run against a read-only transaction, bound every scan by a
date window and a row cap, run scheduled scans off-peak per Company business
day, and never hold locks on operational tables.

### Deployment

Add `Dockerfile.platform-web` mirroring `Dockerfile.web`. Route
`platform.bluelinegpt.com` at the ingress to that container. Add the Platform
origin to `CORS_ORIGINS`.

---

## I. Reset Module Mapping Findings

Initial mapping from business module to the manifest's 95 removal-set tables.
`MODULE_RULES` in the manifest already groups these for reporting; the mapping
below is the **business** view the future UI would expose.

| Business module | Tables (from `PURGE_TABLES`) | Depends on (must also clear) |
| --- | --- | --- |
| Orders | `orders`, `order_assignments`, `order_attachments`, `order_events`, `order_expenses`, `order_items`, `order_status_history`, `international_shipments`, `import_batches`, `import_errors`, `tracking_tokens`, `tracking_access_events`, `saas_usage_events`, `employee_order_earnings`, `driver_commission_orders` | everything financial that references an Order |
| Customers | `customers`, `customer_addresses` | Orders |
| Traders | `traders`, `trader_bank_accounts`, `trader_service_prices` | Orders, Settlements, Collections, Storefront |
| Drivers | `drivers`, `driver_documents` | Orders, Reconciliation, Commissions, Payroll |
| Employees | `employees`, `employee_roles`, `employee_allowances`, `employee_salary_versions`, `employee_delivery_earning_rules`, `hr_documents`, `hr_document_attachments` | Payroll |
| Driver Collections | `trader_collections`, `trader_collection_allocations`, `trader_receivables`, `driver_collection_trader_payables` | Orders, Accounting |
| Driver Reconciliation | `driver_reconciliations`, `driver_reconciliation_orders`, `driver_reconciliation_expenses`, `driver_reconciliation_payments` | Orders, Accounting |
| Driver Commissions / Outsourced Fees | `driver_commission_calculations`, `driver_commission_rules`, `outsourced_driver_fee_accruals`, `outsourced_driver_fee_payments`, `outsourced_driver_fee_payment_allocations`, `outsourced_driver_fee_versions`, `outsourced_driver_payments` | Orders, Accounting |
| Trader Settlements | `trader_settlements`, `trader_settlement_orders`, `trader_settlement_payments` | Orders, Accounting |
| Payroll | `payroll_periods`, `payroll_entries`, `payroll_adjustments`, `payroll_line_allowances`, `payroll_payments`, `payroll_payment_allocations`, `payroll_commission_links`, `payroll_calculation_exceptions` | Employees, Accounting |
| General Expenses | `general_expenses`, `general_expense_lines`, `general_expense_payments`, `general_expense_payment_rows`, `general_expense_attachments`, `operating_expenses` | Accounting |
| Cash / Bank Transactions | `cash_bank_movements`, `cash_bank_movement_attachments` | Accounting |
| Accounting Transactions | `accounting_events`, `accounting_event_components`, `journal_entries`, `journal_lines`, `opening_balance_batches`, `opening_balance_lines` | **everything above** |
| Accounting Batch / Recovery | `accounting_batch_jobs`, `accounting_batch_items`, `accounting_batch_transitions` | Accounting |
| Period Closing execution | `closing_workflows`, `closing_workflow_tasks`, `closing_workflow_reviews`, `closing_workflow_transitions`, `closing_task_comments`, `closing_task_attachments` | Accounting |
| Communication / Notifications | `conversations`, `conversation_participants`, `messages`, `communication_notification_outbox`, `customer_messaging_sessions`, `realtime_event_log`, `support_cases`, `idempotency_records` | Orders |
| Trader Ecommerce / Storefront | `trader_storefronts`, `trader_storefront_products`, `trader_storefront_categories`, `trader_storefront_slugs`, `trader_storefront_product_media`, `trader_storefront_product_option_groups`, `trader_storefront_product_option_values`, `trader_commerce_company_links`, `trader_delivery_company_relationships` | Traders |

### Global / preserved boundary

`trader_commerce_profiles` is **global** and preserved. Deleting a global
Commerce entity, if ever supported, must be a separate Platform operation with
its own authorization — never part of a Company reset.

### Safe / unsafe modularity concerns

1. **Accounting cannot be preserved while transactions are cleared.** Removing a
   Driver reconciliation while keeping its accounting event and journal creates
   exactly the one-leg condition Phase 2 exists to detect. Accounting must be
   auto-expanded into any selection that includes a financial module.
2. **Preset A (Transactions Only) is not expressible today.** `PURGE_TABLES` is a
   single flat set. Preserving Traders/Customers/Drivers/Employees while clearing
   transactions requires splitting the set into module groups **and** re-running
   `collectInboundReferences` against the reduced set — a preserved master still
   referenced by a cleared child is fine, but a *cleared* master still referenced
   by a *preserved* row would block. This is a real manifest refactor, not a
   configuration change.
3. **Preset B (Full Test Reset) is exactly today's behaviour** and needs no
   manifest change.
4. **`employee_allowances`, `employee_salary_versions`,
   `outsourced_driver_fee_versions` and `driver_commission_rules` are per-entity,
   not configuration.** They must move with their master, never independently.
5. **Dependency expansion must be computed from live foreign keys**, reusing
   `dependencyOrder` and `collectInboundReferences`, not from a hand-written
   module dependency table that will drift.
6. **`idempotency_records` in the Communication group is a mis-grouping** for UI
   purposes — it is cross-cutting. It should be expanded automatically with any
   selection rather than presented as a Communication choice.

---

## J. Gap Matrix

| Capability | Existing | Partial | Missing | Evidence | Risk | Phase |
| --- | :-: | :-: | :-: | --- | --- | --- |
| Platform web application | | | ✕ | no `apps/platform-web` | Low | P1/P2 |
| Platform authentication | ✓ | | | `PlatformAuthenticationController` | — | — |
| Platform session cookie | | ✕ | | platform login does **not** call `setSessionCookie` | **High** | P1/P2 |
| Platform account model | ✓ | | | `accounts_scope_check` | — | — |
| Platform role | | ○ | | `roles_platform_code_unique`, no rows seeded | Medium | P1/P2 |
| Platform permission model | | ○ | | `platform.*` namespace reserved, no codes seeded | Medium | P1/P2 |
| Target-company context | | | ✕ | `TenantContextAccessor` throws when `companyId` is null | **High** | P1/P2 |
| Company creation | | ○ | | dev bootstrap script only | High | P1/P3 |
| Company profile | | ○ | | `/company-profile`, Company-self-service only | Medium | P1/P3 |
| Company lifecycle | | ○ | | `active`/`disabled` only | High | P1/P3 |
| Company environment/type | | | ✕ | `DEV-` code convention only | **High** | P1/P3 |
| First Company Admin | | ○ | | inside `bootstrapDevelopmentCompany` | High | P1/P4 |
| Account activation | | ○ | | `force_password_change` + temporary password | Medium | P1/P4 |
| Password reset | ✓ | | | `password_reset_tokens`, single-use + expiring | — | P1/P4 |
| Account unlock | ✓ | | | `UserAdministrationService.unlock` | — | P1/P4 |
| Session revocation | ✓ | | | `revokeSession`, `revokeSessions` | — | P1/P4 |
| Company module configuration | | | ✕ | no module table | Medium | P2+ |
| Feature flags | | | ✕ | none found | Low | P2+ |
| Billing configuration | | | ✕ | none found | Medium | later |
| Subscription | | | ✕ | none found | Medium | later |
| Usage metering | | ○ | | `saas_usage_events` (`order_submitted` only) | Medium | later |
| Company logs | | ○ | | many sources, no unified per-Company view | Medium | P1/P5 |
| Platform audit | | ○ | | `audit_events` usable; no `result`/`source_application` | High | P1/P5 |
| Security logs | | ○ | | `account_sessions` + audit; no unified login-history view | Medium | P1/P5 |
| Correlation IDs | ✓ | | | `genReqId` + `audit_events.correlation_id` | — | — |
| Mobile configuration | | | ✕ | Flutter `config/*.json`, build-time only | Low | later |
| WhatsApp configuration | | | ✕ | contact field only | Low | later |
| Storefront configuration | | ○ | | storefront tables exist; no Platform control | Low | later |
| Payment configuration | | | ✕ | none found | Low | later |
| Company reset engine | ✓ | | | four reset files, proven | — | — |
| Reset preview | ✓ | | | `runDryRun`, `READY_FOR_EXECUTION_TOOL` | — | — |
| Modular reset | | | ✕ | flat `PURGE_TABLES` | Medium | reset phase |
| Reset dependency expansion | | ○ | | `dependencyOrder` exists at table level | Medium | reset phase |
| Permanent reset audit | | | ✕ | CLI writes stdout only | **High** | reset phase |
| Data-integrity scans | | ○ | | accounting-only, read-only preview | High | P2 |
| One-leg detection | | ○ | | `accounting-recovery.service.ts` | **Critical** | P2 |
| Support tooling | | ○ | | `support_cases` + `/support/cases`, Company-scoped | Low | later |

✓ existing ○ partial ✕ missing

---

## K. Risk Register

| # | Risk | Sev | Evidence | Impact | Mitigation | Resolve in |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Platform authorization bypass | Critical | `AuthenticationGuard` is deny-by-default, but no `platform.*` permission is seeded, so a Platform account today carries an **empty** permission set | Platform routes could be written without a permission and default to open | Every Platform controller must carry `@RequireIdentityKinds("platform_administrator")` **and** an explicit `@RequirePermissions("platform.*")`; add a test that fails if any Platform route lacks both | Prompt 2 |
| 2 | Cross-company data exposure | Critical | Platform actor legitimately spans Companies | Wrong-Company data returned or written | Target-company guard re-resolves from DB per request; Company id only from the route; audit every cross-Company access | Prompt 2 |
| 3 | **Platform login stores the token in the browser** | **High** | `PlatformAuthenticationController.loginPlatform` returns the token but never calls `setSessionCookie`, unlike the Company controller | A Platform SPA would have to hold the token in JS or `localStorage`, violating the no-browser-storage rule | Issue the same `HttpOnly` cookie on Platform login (and clear it on logout) before any Platform UI is built | Prompt 2 |
| 4 | **`platform` subdomain collides with a tenant** | **High** | `CompanyHostResolver` maps any single label under the host suffix to a Company subdomain; only `www` is excluded. `companies.subdomain` has no reserved-word check | A Company registered with subdomain `platform` would take over `platform.bluelinegpt.com`; conversely the Platform host resolves as a tenant login host | Add a reserved-subdomain list (`platform`, `www`, `api`, `admin`, `store`, `app`) enforced in both `CompanyHostResolver` and a `companies` check constraint | Prompt 2 |
| 5 | Platform user tied incorrectly to a Company | Low | `accounts_scope_check` makes it impossible at the database level | — | Keep the constraint; never add a "home Company" to a Platform account | — |
| 6 | Role collision | Low | `platform.*` already filtered from Company role management | — | Keep all Platform permissions in `platform.*`; add a test | Prompt 2 |
| 7 | Company suspension breaks operations | Medium | `authentication.service.ts` refuses login when `companyStatus === "disabled"`; background/realtime paths are not checked | Suspension may not stop non-login activity | Define suspension semantics explicitly; check status at session validation, not only at login | Prompt 3 |
| 8 | Password-reset abuse | Medium | `password_reset_tokens` is single-use and expiring; `resetPassword` is Company-admin gated | Platform-initiated reset could be used to take over a Company | Require a reason, audit every reset with actor + target, rate-limit, never display the password to the Platform actor | Prompt 4 |
| 9 | Session revocation gaps | Low | `revoked_at` checked on every `findActiveSession` | — | Reuse unchanged | — |
| 10 | Browser token storage | High | Company portal is clean (tests assert no `accessToken` in `localStorage`); Platform path is not | See #3 | Same as #3; add the equivalent assertion test for the Platform app | Prompt 2 |
| 11 | Duplicate Company code | Low | `companies_code_unique` on `lower(code)` | — | Surface the constraint violation as a field error | Prompt 3 |
| 12 | Partial onboarding | Medium | `bootstrapDevelopmentCompany` is a single transaction; an API path could be split across requests | Company with no admin, or admin with no role | Create Company + first Admin + defaults in **one** transaction, as the bootstrap already does; `draft` status until complete | Prompt 3/4 |
| 13 | Configuration drift | Medium | `company_settings` has no history table; `accounting_configuration_history` shows the intended pattern | Silent setting changes | Effective-dated or history-backed changes for anything affecting reports | Prompt 3 |
| 14 | Missing Platform audit | High | no `result`/`source_application` columns | Failures invisible; Platform vs Company origin indistinguishable | Add the three columns; write audit on failure paths too | Prompt 5 |
| 15 | Sensitive data in logs | Low | pino redacts auth header, cookie, password, token, `set-cookie` | — | Extend the redact list as new fields appear; mask in `before_data`/`after_data` | Prompt 5 |
| 16 | Unsafe support access | Medium | no impersonation exists anywhere (searched) | — | Do **not** introduce impersonation in Phase 1 | — |
| 17 | Reset engine duplication | High | one engine today | Divergent safety behaviour | Platform API must call `runReset`; add a test asserting only one caller path exists | reset phase |
| 18 | Reset production bypass | Critical | two independent gates today (`NODE_ENV`, `DEV-` code) | Production data loss | Add `companies.environment` as a third server-side gate; never accept environment from the browser | reset phase |
| 19 | Reset backup failure | High | `backupDecision` stops unless `--allow-no-backup` | Unrecoverable loss | Never expose `--allow-no-backup` through the API; a failed backup must abort | reset phase |
| 20 | Reset deletes global Commerce | Critical | `trader_commerce_profiles` is PRESERVE + GLOBAL; engine refuses non-direct ownership | Cross-Company data loss | Add an explicit regression test asserting it is never in the removal order | reset phase |
| 21 | Unsafe modular reset combination | High | flat `PURGE_TABLES`; no module graph | One-leg records created **by** the reset | Auto-expand dependencies from live FKs; refuse any selection whose reduced set fails `collectInboundReferences` | reset phase |
| 22 | Reset audit deleted by reset | High | CLI persists nothing | No record a reset happened | `platform_reset_audits` written outside the reset transaction and added to `PRESERVE_TABLES` | reset phase |
| 23 | One-leg financial transaction | Critical | `accounting-recovery.service.ts` exists because this has already happened | Financial reports understate | Phase 2 Company-wide detector; extend beyond accounting | Phase 2 |
| 24 | Missing correlation ID | Low | `correlation_id` is `not null` on `audit_events`; pino generates one per request | — | Thread the request id into every Platform audit write | Prompt 5 |
| 25 | Heavy integrity scan | Medium | recovery service is set-based and paged — the right precedent | Production load | Read-only transactions, bounded windows, row caps, off-peak scheduling | Phase 2 |
| 26 | Migration conflict | Medium | 90 timestamp-named migrations; `migrations:validate` in CI | Ordering collision | Keep timestamp naming; run `pnpm migrations:validate` | every phase |
| 27 | Deployment routing issue | Medium | no `Dockerfile.platform-web`; `apps/store` also has none | Platform host unroutable | Add the Dockerfile, ingress rule and `CORS_ORIGINS` entry with the app | Prompt 2 |

---

## L. Proposed Prompt 2

**Platform authentication, roles, permissions, target-company context, security
foundation, and the `apps/platform-web` skeleton.**

**Objective** — a Platform administrator can sign in at
`platform.bluelinegpt.com`, is authenticated by an `HttpOnly` cookie, sees an
empty authenticated shell, and every Platform API route is deny-by-default.

**Dependencies** — none beyond this audit.

**Backend**

- New `apps/api/src/platform/platform.module.ts`, registered in `app.module.ts`.
- Issue and clear the session cookie on `POST /platform/auth/login` and add
  `POST /platform/auth/logout` (risk #3).
- Reserved-subdomain guard in `CompanyHostResolver` **and** a `companies` check
  constraint (risk #4).
- `PlatformTargetCompanyGuard` + `@TargetCompany()` decorator: route-param only,
  UUID-validated, DB re-resolved, entered into the request tenant context,
  audited.
- `GET /platform/companies` (list, read-only) as the minimal route that proves
  the guard and permission model end to end.
- Seed `platform_super_admin` role and the five `platform.*` permissions.

**Frontend** — new `apps/platform-web` (port 5176): login view, authenticated
shell, Company list, error boundary, i18n bootstrap. `credentials: "include"`,
`X-Blueline-Session` header on mutations, **no** token in any browser storage.
No file under `apps/web` or `apps/mobile` is touched.

**Database** — one migration: seed the Platform role and permissions; add the
reserved-subdomain constraint.

**Security controls** — deny-by-default; `@RequireIdentityKinds("platform_administrator")`
plus an explicit `platform.*` permission on every route; HttpOnly + Secure +
SameSite cookie; CSRF header; throttling on the Platform login route.

**Tests** — Company user denied Platform routes; Platform user denied Company
routes; unknown/invalid/other-Company `:companyId` rejected; no token in browser
storage; every Platform route carries both decorators; reserved subdomain
rejected.

**Completion gate** — all of the above pass, `pnpm typecheck` clean, no new lint
errors, and no diff under `apps/web` or `apps/mobile`.

---

## M. Phase 1 Prompts 3–5

**Confirmed, with these refinements:**

**Prompt 3 — Company lifecycle and profile.** Add `draft` and `suspended` to
`companies_status_check`; add `companies.environment` (server-only, default
`production`, backfilled from the `DEV-` prefix); add status-change columns;
`POST /platform/companies`, `GET/PATCH /platform/companies/:companyId`,
lifecycle transition endpoints. Company creation must seed defaults in the same
transaction, reusing `seedCompanyDefaults`.

**Prompt 4 — Company Admin onboarding and access recovery.** Reuse
`UserAdministrationService` through the target-company context — do not
duplicate it. First Company Admin creation, activation, password reset, unlock,
session listing and revocation, forced password change. Reason required and
audited on every access-recovery action.

**Prompt 5 — Platform audit trail, tenant-isolation validation, certification.**
Add `result`, `failure_reason`, `source_application` to `audit_events`;
`GET /platform/companies/:companyId/audit`; a full tenant-isolation test suite;
Phase 1 certification report.

**Moved out of Phase 1:** module configuration and feature flags. Nothing in
Prompts 2–5 depends on them, and section 37 forbids pulling them forward.

---

## N. Future Reset Phase

**Four prompts.**

1. **Module abstraction and mapping.** Split `PURGE_TABLES` into declared
   business modules; build dependency expansion from live foreign keys reusing
   `dependencyOrder` / `collectInboundReferences`; prove Preset A and Preset B
   resolve to valid, complete removal sets. No API, no UI.
2. **Preview API + permanent reset audit schema.** `POST /platform/companies/:companyId/maintenance/reset/preview`
   wrapping the existing `runDryRun`; create `platform_reset_audits` and add it
   to `PRESERVE_TABLES` in the same migration; add the `companies.environment`
   third gate.
3. **Execute API.** Thin service owning the transaction and calling the
   unchanged `runReset`; backup mandatory with no waiver exposed; double
   confirmation; readiness=true required; audit written outside the transaction;
   post-reset verification before any success response.
4. **Platform UI + browser validation.** Maintenance screen under
   Companies → Company Details → Maintenance → Reset Company Data; module
   selection, preview, confirmation, progress, verified result. Validated
   against a **new, purpose-created non-production fixture Company** — not Dana.

---

## O. Files Reviewed

**Reset (all four known files present):**
`apps/api/src/platform/reset-company-test-data.manifest.ts`,
`reset-company-test-data.ts`, `reset-company-test-data.engine.ts`,
`reset-company-test-data.cli.ts`, plus `.safety.test.ts`, `.guards.test.ts`,
`.database.test.ts`.

**Platform:** `platform-administrator-bootstrap.ts`,
`run-platform-administrator-bootstrap.ts`, `development-company-bootstrap.ts`,
`company-defaults.ts`, `reconciliation-demo-seed.ts`, `uae-area-import.ts`,
`run-development-data-reset.ts`, `administration.database.test.ts`.

**Authentication / security / tenancy:** `authentication.controller.ts`,
`authentication.service.ts`, `authentication.guard.ts`,
`authentication.decorators.ts`, `session-cookie.ts`,
`security/identity-context.ts`, `security/request-security-context.ts`,
`tenancy/tenant-context.ts`, `tenancy/company-host-resolver.ts`.

**API structure:** `main.ts`, `bootstrap/create-application.ts`, `app.module.ts`,
`configuration/environment.ts`, `logging/http-logger.config.ts`,
`infrastructure/database/*`.

**Domain:** `users/user-administration.controller.ts` + `.service.ts`,
`roles/role.controller.ts` + `.service.ts`, `company-profile/*`,
`company-configuration/*`, `support/*`,
`accounting/accounting-recovery.service.ts`.

**Frontend:** `apps/web/src/api/api-client.ts`, `apps/web/src/app/*`,
`apps/web/src/theme/theme-preference.ts`, `apps/store/vite.config.ts`,
`apps/store/package.json`.

**Database:** `20260713230000_core_tenancy_security.ts`,
`20260713230010_delivery_operations.ts`, `20260713230040_authentication_sessions.ts`,
`20260718010000_user_role_administration.ts`,
`20260727120000_company_profile_branding.ts`,
`20260802120000_communication_backend.ts`,
`20260805120000_company_business_day_configuration.ts`,
`20260807000000_trader_commerce_foundation.ts`,
`infrastructure/database/integrity.database.test.ts`; full migration listing (90).

**Docs / deployment:** `CLAUDE.md`, `Documentation/CLAUDE_CODE_HANDOVER.md`,
`Documentation/Architecture/DEPLOYMENT_ARCHITECTURE.md`,
`Documentation/Decisions/ADR-004-tenant-context.md`,
`Documentation/Decisions/login-company-selection-and-company-list-exposure.md`,
`Dockerfile.api`, `Dockerfile.web`, `compose.local.yaml`,
`.github/workflows/ci.yml`, `scripts/dev.ps1`, `package.json`,
`pnpm-workspace.yaml`.

---

## P. Commands Executed

Read-only inspection only. **No destructive command, and no reset execution, was
run.**

```
git status --porcelain
ls / wc / grep / sed over the repository
pnpm typecheck
pnpm lint
pnpm test
```

---

## Q. Tests / Baseline

Frameworks: **Vitest** (API, web, store), **Flutter test** (mobile, CI only).
No browser/e2e framework exists in this repository — verification is unit,
component (Testing Library + jsdom) and database-integration.

### `pnpm typecheck` — **PASS** (exit 0, all workspaces)

### `pnpm lint` — **FAIL** (exit 1) — pre-existing, unrelated to Platform work

39 problems: **38 errors, 1 warning**, all in `apps/web`:

- `react-hooks/exhaustive-deps` — "Definition for rule not found" (the plugin is
  referenced but not registered), several files
- `@typescript-eslint/no-unused-vars` — `operationalAreaLabel`, `isControl`,
  `setConsumedDeepLink`
- `@typescript-eslint/consistent-type-imports` — `AccountingApi`,
  `StorefrontApp.test.tsx`
- `no-irregular-whitespace` — `CashBankMovementsPage.tsx:1077`,
  `ExpensePaymentsPage.tsx:1254`

None are in `apps/api`, `apps/store`, `database/` or any Platform-related file.
These are **not** to be fixed as part of Platform work.

### `pnpm test` — **PASS** (exit 0)

| Workspace | Files | Tests |
| --- | --- | --- |
| `apps/api` | 38 passed, 34 skipped (72) | **407 passed, 274 skipped** (681) |
| `apps/web` | 45 passed (45) | **390 passed** (390) |
| `apps/store` | 1 passed (1) | **16 passed** (16) |
| **Total** | 84 passed, 34 skipped | **813 passed, 274 skipped** |

**0 failures.**

### Skips / quarantines

The 274 skipped API tests are **not failures**. They are database-integration
tests deliberately gated behind explicit environment flags via
`describe.skipIf`, so CI and local runs do not require a live PostgreSQL
instance. 16 distinct gates were found, including:

`RUN_INTEGRITY_DATABASE`, `RUN_DATABASE_INTEGRATION`, `RUN_RESET_DATABASE`,
`RUN_ADMINISTRATION_INTEGRATION`, `RUN_PROVISIONING_DATABASE`,
`RUN_RECONCILIATION_DATABASE`, `RUN_SETTLEMENT_DATABASE`,
`RUN_CONCURRENCY_DATABASE`, `RUN_COMPANY_PROFILE_DATABASE`,
`RUN_STOREFRONT_DATABASE`, `RUN_COMMERCE_DATABASE`, `RUN_FIXTURE_DATABASE`,
`RUN_HISTORY_DATABASE`, `RUN_RECONCILIATION_HTTP`, `RUN_SETTLEMENT_HTTP`,
`RUN_COMMERCE_MEDIA_DATABASE`.

This convention **must be preserved** for Platform tests: pure-logic tests run
always; database-backed Platform tests get their own flag
(e.g. `RUN_PLATFORM_DATABASE`) and a `package.json` script, matching
`test:reset:database` and `test:administration:database`.

### Reset tooling baseline

`reset-company-test-data.safety.test.ts` (14 assertions) and
`.guards.test.ts` (11 assertions) run unconditionally and passed. The
database-backed `reset-company-test-data.database.test.ts` was skipped
(`RUN_RESET_DATABASE` unset) and was **not** run — consistent with the
instruction not to perform a destructive reset. **No reset was executed, and no
dry run was run against Dana or any other Company.**

### Migration status

`pnpm migrations:validate` is part of `ci:validate`; 90 forward migrations were
listed and inspected statically. Live migration state was not queried, because
that would require connecting to the development database, which this audit did
not do.

---

## R. Changes Made

No functional Platform Portal implementation was performed in this audit prompt.

The only change is this document:
`Documentation/Architecture/PLATFORM_ADMINISTRATION_PORTAL_AUDIT.md` (new).

No source file, migration, test or configuration file was modified.

---

## S. Blockers / Prerequisites

No stop condition was met. The repository is BluelineGPT, authentication and
tenant isolation were understood, the Company model was identified, and all four
named reset files exist and match the documented behaviour.

**Three prerequisites must be resolved inside Prompt 2, before any Platform UI
is built:**

1. **Platform login must issue the `HttpOnly` session cookie.** It currently
   does not, so a Platform SPA would be forced to store the token in the browser
   — a direct violation of the no-browser-storage rule. (Risk #3)
2. **`platform` must become a reserved subdomain.** `CompanyHostResolver`
   excludes only `www`, and `companies.subdomain` has no reserved-word
   constraint, so `platform.bluelinegpt.com` is currently ambiguous with a
   tenant host. (Risk #4)
3. **Platform roles and `platform.*` permissions must be seeded.** A Platform
   administrator today authenticates successfully but carries an empty
   permission set, so no permission-gated route would ever admit them. (Risk #1)

**Two advisories, not blockers:**

- The working tree carries a large number of uncommitted modifications on
  `ui-v2.0`. Nothing is deleted and the audit was reliable, but Platform work
  should start from a committed baseline.
- `pnpm lint` fails on pre-existing errors in `apps/web`, unrelated to Platform
  work. Platform work must not be blocked by them, and must not "fix" them as a
  side effect.

---

## T. Final Status

`READY_WITH_REQUIRED_PREREQUISITES`

---

# Implementation status — appended after Phase 1, Prompt 2

_Added 8 August 2026. The audit above is unchanged; this section records what has
since been built. Design detail lives in
`PLATFORM_ADMINISTRATION_PORTAL.md`._

## The three prerequisites from section S are resolved

| # | Prerequisite | Resolution |
| --- | --- | --- |
| 1 | Platform login must issue the `HttpOnly` session cookie | Done. Platform sign-in moved to `apps/api/src/platform/platform-auth.controller.ts`, sets the same `blueline_session` cookie as Company sign-in, and now returns **no token at all**. |
| 2 | `platform` must become a reserved subdomain | Done. One list in `apps/api/src/tenancy/reserved-subdomains.ts`, honoured by `CompanyHostResolver` (a reserved host no longer falls through to the development Company) and enforced by the `companies_subdomain_not_reserved` check constraint. A test asserts the two never drift. |
| 3 | Platform roles and `platform.*` permissions must be seeded | Done. Migration `20260808100000_platform_administration_foundation` seeds six codes and the `platform_super_admin` system role, and grants it to any pre-existing Platform account. |

## Also delivered in Prompt 2

- `apps/platform-web` — a separate React + Vite application on port 5176, with
  its own same-origin `/api` proxy. No file under `apps/web`, `apps/store` or
  `apps/mobile` was modified.
- `PlatformModule` in the API, owning every `/api/v1/platform/...` route.
- `RequirePlatformPermissions`, which applies the Platform identity kind **and**
  `platform.access` plus any granular code, enforced by the existing
  deny-by-default global guard.
- `PlatformTargetCompanyGuard` — route-param only, UUID-validated, database
  re-resolved, request-scoped, with `identity.companyId` left `null`.
- `PlatformAuditService`, writing to the existing append-only `audit_events`.

## Gap matrix rows that have changed

| Capability | Was | Now |
| --- | --- | --- |
| Platform web application | Missing | **Existing** — `apps/platform-web` |
| Platform session cookie | Partial (High risk) | **Existing** — cookie issued, no token returned |
| Platform role | Partial | **Existing** — `platform_super_admin` |
| Platform permission model | Partial | **Existing** — six `platform.*` codes |
| Target-company context | Missing (High risk) | **Existing** — `PlatformTargetCompanyGuard` |

## Risk register items closed

Risks 3 (browser token storage on the Platform path), 4 (`platform` subdomain
collision), 6 (role collision) and 10 (browser token storage) are closed and
covered by tests. Risk 1 (Platform authorization bypass) is mitigated by a test
that fails if any Platform route lacks both the identity-kind and permission
annotations.

Risks 17–22 (reset engine) are untouched and remain open for the Company
Maintenance / Reset phase. **The existing Company reset engine remains unchanged
and no destructive reset was executed.**

## Database state after Prompt 2

Migration `20260808100000_platform_administration_foundation` is applied to the
development database. Verified read-only afterwards: six `platform.*`
permissions, one active system role `platform_super_admin` holding all six, the
`companies_subdomain_not_reserved` constraint present and `convalidated = true`,
and the Company row count unchanged.
