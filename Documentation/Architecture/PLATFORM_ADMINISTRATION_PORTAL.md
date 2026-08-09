# BluelineGPT Platform Administration Portal — Architecture

Status: **Phase 1 complete and certified.** The certification evidence and the
tenant-isolation attack matrix are recorded in
`PLATFORM_ADMINISTRATION_PHASE_1_CERTIFICATION.md`, which is the document to
read before operating the Portal.

Companion document: `PLATFORM_ADMINISTRATION_PORTAL_AUDIT.md` records the
Prompt 1 repository audit that this design came from. That document is history
and is not rewritten; its implementation status is appended at its end.

---

## 1. Purpose and boundary

The Platform Administration Portal is used by the BluelineGPT platform owner and
authorised internal staff to administer the delivery Companies that use
BluelineGPT. It is **not** the Company operational portal.

| Platform Portal owns | Company Portal keeps |
| --- | --- |
| Company onboarding, profile, lifecycle | Orders, Traders, Drivers, Customers |
| Company subscription and billing configuration | Areas, pricing, Employees |
| Enabled modules | Driver collections and reconciliation |
| Company administrators and access recovery | Trader settlements, payroll |
| Company usage, logs, integration health | Day-to-day accounting and reports |
| Company maintenance and support tooling | |

Nothing operational moves into the Platform Portal.

---

## 2. Applications

| Path | Package | Dev port | Purpose |
| --- | --- | --- | --- |
| `apps/api` | `@blueline/api` | 3000 | NestJS API, all portals |
| `apps/web` | `@blueline/web` | 5174 | Company Delivery Portal |
| `apps/store` | `@blueline/store` | 5175 | Trader Storefront |
| **`apps/platform-web`** | **`@blueline/platform-web`** | **5176** | **Platform Administration Portal** |

`apps/platform-web` is a separate Vite + React application, following the
precedent `apps/store` set: its own package, its own Vite config, its own port,
its own same-origin `/api` dev proxy, and no shared UI package.

**Why not a shared package.** The Prompt 1 audit found no `packages/` workspace
convention in this repository — `apps/store` also carries its own CSS and its
own API client. Creating one now would mean inventing a workspace shape and
editing the Company Portal to prove it, risking regressions across every
operational screen for the sake of a handful of primitives. When a genuine,
low-risk seam appears, extraction can be revisited.

**No file under `apps/web`, `apps/store` or `apps/mobile` was modified for the
Platform Portal.**

### Same-origin API is mandatory, not a preference

`VITE_API_BASE_URL` defaults to the relative `/api/v1`. The Platform session is
an `HttpOnly`, `SameSite=Lax` cookie with **no bearer-token fallback of any
kind**. An absolute API origin would make every request cross-site, the browser
would withhold the cookie, and the Portal would be permanently signed out — with
no token in JavaScript to fall back on. Serve the API under the Platform origin
(dev proxy locally, reverse proxy in production).

---

## 3. Platform API

All routes sit under the existing global prefix, owned by a single module:
`apps/api/src/platform/platform.module.ts`.

| Route | Auth | Permission |
| --- | --- | --- |
| `POST /api/v1/platform/auth/login` | public | — |
| `GET /api/v1/platform/auth/me` | Platform | `platform.access` |
| `POST /api/v1/platform/auth/logout` | Platform | `platform.access` |
| `GET /api/v1/platform/companies` | Platform | `platform.access` + `platform.companies.read` |
| `GET /api/v1/platform/companies/:companyId/context` | Platform | `platform.access` + `platform.companies.read` |

The Company reset tools also live in `apps/api/src/platform/` but are
**deliberately not registered** in `PlatformModule`. They remain a CLI
capability. See §11.

---

## 4. Authentication and the session model

### What was wrong

A Platform login endpoint already existed and authenticated correctly, but —
unlike Company login — it never issued the `HttpOnly` session cookie. It
returned a bearer token in the response body. Any browser client would have had
to hold that token in JavaScript or `localStorage`, which the Portal is required
never to do.

### What it does now

`POST /platform/auth/login` sets the same `blueline_session` cookie the Company
Portal uses, and **returns no token at all**. Company login still returns
`accessToken` because API clients that predate the cookie use one; the Platform
Portal has no such history, so withholding it is not a limitation — it removes
the option.

| Property | Value | Why |
| --- | --- | --- |
| Cookie name | `blueline_session` | Same server-side session record as Company sessions |
| `HttpOnly` | always | Page scripts cannot read it, so cannot leak it into storage |
| `Path` | `/api` | Not attached to static asset requests |
| `SameSite` | `Lax` | Withheld on cross-site state-changing requests |
| `Secure` | production only | Forcing it under local HTTP would make the browser drop it silently |
| CSRF | `X-Blueline-Session: cookie` required on every cookie-authenticated mutation | A cross-site form cannot set a custom header; a cross-origin fetch that tries triggers a preflight the API will not answer |

Sessions are server-side rows in `account_sessions` (SHA-256 token hash,
`expires_at`, `revoked_at`). Nothing about issuance, expiry or revocation is
Platform-specific, so revoking a Platform session server-side kills it
immediately on every path.

### Session bootstrap

A reload throws all client state away and rebuilds it from
`GET /platform/auth/me`, which succeeds because the browser still holds the
cookie. `me` returns account id, username, display name, kind, `companyId`
(always `null`), effective `platform.*` permissions and Platform role codes. It
returns no password material, no token, no reset token and no Company data.

Permissions returned by `me` are filtered to the `platform.*` namespace: a
Platform account should never hold a Company permission, and if one were granted
by mistake the Portal must not act on it.

### Sign-out

`POST /platform/auth/logout` revokes the server session **first**, then clears
the cookie. If clearing failed for any reason the session is already dead rather
than merely hidden.

### MFA

**Deferred / not mandatory.** No MFA is implemented, no MFA screen exists, and
no unfinished MFA columns were added. The architecture does not preclude it.

---

## 5. Platform users

A Platform Administrator is an ordinary `accounts` row with
`account_kind = 'platform_administrator'` and `company_id IS NULL`. The database
constraint `accounts_scope_check` makes any other state impossible, so a Platform
user can never be bound to a real or placeholder Company.

No dedicated Platform user table exists or is wanted: it would fork session
management, lockout and password handling, and would contradict the bootstrap
and login paths that already treat Platform accounts as accounts.

---

## 6. Platform permissions and roles

### The namespace is the boundary

`apps/api/src/roles/role.service.ts` already excludes `code like 'platform.%'`
from every permission a Company Administrator can see or assign. That filter
predates this work and is the entire isolation mechanism — which is why every
Platform code carries the prefix, without exception, and a test fails if one
ever does not.

### The Phase 1 catalogue

| Code | Meaning |
| --- | --- |
| `platform.access` | Sign in to the Platform Portal — required on **every** Platform route |
| `platform.companies.read` | View Companies |
| `platform.companies.manage` | Create and manage Companies (Prompt 3) |
| `platform.users.read` | View a Company's users (Prompt 4) |
| `platform.users.manage` | Manage a Company's users (Prompt 4) |
| `platform.audit.read` | View Platform and Company audit history (Prompt 5) |

Six codes, no more. Codes for billing, Company data reset, WhatsApp, Storefront,
Mobile and integrity auto-fix are **absent on purpose**: a permission that
nothing enforces is a control that appears to exist and does not. Each belongs
to the phase that implements its behaviour.

### The role

One system role, `platform_super_admin` ("Platform Super Administrator"), with
`company_id IS NULL`. `roles` has supported Platform scope since the first
migration (`roles_platform_code_unique`), so no new table was needed. The five
speculative roles from the original plan were not created.

### Enforcement

`RequirePlatformPermissions(...codes)` applies **both**
`@RequireIdentityKinds("platform_administrator")` **and**
`@RequirePermissions("platform.access", ...codes)`. Both are enforced by the
existing global, deny-by-default `AuthenticationGuard`.

Two checks rather than one, because each alone is insufficient: the identity
kind says *who* is calling but not what they may do (a Platform account with no
role authenticates fine and holds nothing), and a permission check alone would
admit any account that somehow held a `platform.*` code. Requiring
`platform.access` everywhere also means removing that one code suspends an
administrator from the whole Portal at once.

A test enumerates every route handler on every Platform controller and fails if
any lacks both, and asserts sign-in is the **only** public Platform route.

---

## 7. Target-Company context

A Platform actor has `identity.companyId === null` and always will. The Company
a Platform request *acts against* is a separate, per-request fact.

`PlatformTargetCompanyGuard` (applied at controller level, so no route can
forget it):

1. reads `:companyId` from the route — the only accepted location;
2. rejects anything that is not a UUID;
3. re-resolves the Company row from the database;
4. rejects unknown and malformed identifiers **identically** (404), so the route
   is not a Company-id oracle;
5. writes the resolved row into the request-scoped security context;
6. moves the **tenant** slot to the target Company, leaving `identity`
   untouched.

Step 6 is the reuse mechanism: `TenantContextAccessor.current()` then returns the
target, so an existing Company-scoped service can run under an explicit,
server-resolved target without ever being taught that Platform actors exist —
while `identity` stays Platform, so identity and permission checks keep telling
the truth.

Nothing the client sends about the Company survives. Company name, environment
and status all come from the row. This matters beyond tidiness: a later phase
decides whether destructive maintenance is permitted for a Company, and if that
answer came from the request it would be whatever the browser claimed.

### Request scoping

The target lives in the AsyncLocalStorage store the request middleware already
opens per request (`RequestSecurityContextStore`), **not** in a second store of
its own. A second store opened with `enterWith` from inside a guard would leak
into whatever async work followed, and the leak would stay invisible until two
concurrent Platform requests targeted different Companies. Tests cover
cross-request leakage and interleaved concurrent targets explicitly.

---

## 8. Reserved Platform host

`platform.bluelinegpt.com` serves the Portal. Two things must therefore agree
forever: host resolution must refuse to read `platform` as a tenant, and a
Company must never be storable with that subdomain.

Both read one list: `apps/api/src/tenancy/reserved-subdomains.ts`.

```
admin  api  app  assets  auth  cdn  dashboard  internal  mail
platform  static  status  store  support  www
```

- **Resolution.** `CompanyHostResolver` now classifies a host as `company`,
  `reserved` or `unknown`. A **reserved** host returns `undefined` *without*
  consulting the development-Company fallback. That distinction is the actual
  defect being prevented: a reserved host that merely "failed to resolve" would
  fall through to the configured development Company, and Company sign-in would
  then succeed on the Platform host in development.
- **Storage.** `companies_subdomain_not_reserved`, a database check constraint,
  refuses the value on insert and update, case- and whitespace-insensitively
  (matching `companies_subdomain_unique`, which indexes `lower(subdomain)`).
- **Drift.** A test parses the constraint out of the migration and asserts it
  matches the TypeScript list word for word.

Previously only `www` was excluded, inline in the resolver. Existing Company
subdomains are unaffected; local development on hosts like `platform.localhost`
is handled even where no host suffix is configured.

---

## 9. Platform audit

Platform actions are written to the existing `audit_events` table, not a second
audit system. That table is already append-only (`reject_audit_mutation` refuses
every UPDATE and DELETE), already allows `company_id IS NULL` so a Platform-only
event has a home, already carries actor, correlation id, IP, user agent and
before/after JSON, and is already in the reset tool's PRESERVE set so a Company
reset cannot erase it. A parallel table would have to re-earn all of that and
then be kept in step forever.

Platform rows are distinguishable three ways: the `platform.` action prefix,
`actor_role = 'platform_administrator'`, and `source = 'platform_portal'`.

Recorded today: `platform.authentication.succeeded`,
`platform.authentication.failed`, `platform.authentication.signed_out`,
`platform_administrator.bootstrap`, `platform_administrator.role_granted`.

**Never written:** password, password hash, session token, cookie, reset token,
Authorization header, or any integration secret. A failed sign-in *does* record
the attempted identifier — a failed-login trail without it cannot be
investigated — but the submitted password never reaches the audit path.

Sign-in and sign-out audit writes are best-effort: the operation has already
taken effect and cannot be undone after the fact, so the request must not fail
because the trail could not be written. Everywhere else an audit write shares
the operation's transaction and a failure correctly aborts it.

---

## 10. Bootstrap administrator

`apps/api/src/platform/platform-administrator-bootstrap.ts`, run via
`pnpm --filter @blueline/api security:bootstrap-platform`. Credentials come from
`BLUELINE_BOOTSTRAP_USERNAME` and `BLUELINE_BOOTSTRAP_PASSWORD`; none are
embedded in source.

- Creates the account with `company_id = null` and grants
  `platform_super_admin`.
- **Idempotent for the same username**: a re-run reuses the existing account and
  ensures the role grant. This is how an environment bootstrapped before the
  Platform role existed gets its permissions.
- A re-run **never changes the stored password**. A bootstrap command that
  doubled as a password reset would let anyone able to run it take the account
  over.
- A *different* Platform administrator already existing still refuses outright:
  silently creating a second privileged account because a username was mistyped
  is exactly what a one-time bootstrap must prevent.
- Guarded by `pg_advisory_xact_lock`; audited; no plaintext secret logged.

The migration also grants the role to any Platform account that already existed,
so no environment is left with an administrator who can sign in and reach
nothing.

---

## 11. Company reset engine — unchanged

**Existing Company reset engine remains unchanged and is reserved for the later
Company Maintenance / Reset phase.**

No reset file was modified. No second engine or manifest exists. No reset
service is registered in `PlatformModule`, so no destructive surface is
reachable over HTTP. No destructive reset was executed. The CLI path
(`npm run reset:test-data`) is untouched, and the future Platform integration
will call the same `runReset` through a thin wrapper that owns the transaction
exactly as the CLI does.

---

## 12. Security summary

| Control | State |
| --- | --- |
| Browser token storage | **None.** The Platform API client has no token field and no `setAccessToken`; a source-level test forbids `localStorage`, `sessionStorage`, `indexedDB` and `document.cookie` anywhere in the Portal source |
| Cookies | `HttpOnly`, `Path=/api`, `SameSite=Lax`, `Secure` in production |
| CSRF | `X-Blueline-Session` required on cookie-authenticated mutations |
| Authorization | Deny-by-default, server-side, identity kind **and** `platform.*` permission on every route |
| Frontend permission checks | Presentation only; every route re-enforced by the API |
| Tenant isolation | Target Company re-resolved server-side per request; actor stays `companyId: null` |
| Rate limiting | Existing global `ThrottlerGuard` covers Platform routes |
| Account lockout | Existing shared mechanism (5 attempts, `AUTH_LOCKOUT_MINUTES`) |
| Sign-in errors | One message for every failure mode — no account/password distinction, no Company named |
| Sensitive logging | pino redacts `authorization`, `cookie`, `req.body.password`, `req.body.token`, `set-cookie`; audit writes carry no secret |
| MFA | Deferred / not mandatory |

---

## 13. Deployment

Still to be added when the Portal is deployed:

- `Dockerfile.platform-web`, mirroring `Dockerfile.web`.
- Ingress route for `platform.bluelinegpt.com` to that container.
- The Platform origin added to `CORS_ORIGINS` (or, preferably, the API reverse-
  proxied under the Platform origin so the session cookie stays first-party).
- `VITE_API_BASE_URL` left at the relative default wherever possible.

`apps/store` also has no Dockerfile today; both are outstanding deployment work.

---

## 14. Known baselines and non-goals

- **Pre-existing lint failures.** `pnpm lint` reports 38 errors and 1 warning,
  all in `apps/web`, all predating this work (unused variables,
  `consistent-type-imports`, irregular whitespace, and a
  `react-hooks/exhaustive-deps` rule referenced but not registered). They were
  deliberately **not** fixed here. All new Platform code is lint-clean.
- **Format check.** The repository is checked out with `core.autocrlf=true`
  while Prettier is configured `endOfLine: "lf"`, so `pnpm format:check` reports
  every CRLF file regardless of content. New Platform files are LF and pass.
- **Not implemented in Prompt 2:** Company creation, profile editing, lifecycle
  transitions, billing, subscription, usage metering, module configuration,
  feature flags, the reset UI/API, the integrity engine, WhatsApp, Storefront
  and Mobile management, Platform session-management UI, impersonation.

### Deferred to a Platform session-management screen

Session revocation infrastructure works for Platform sessions today (revoked and
expired Platform sessions are rejected; sign-out revokes). What does not exist
yet is a Platform-facing screen to list and revoke an administrator's own
sessions, or another administrator's. That belongs with the Company user
management work in Prompt 4, which already reuses the Company session services.

---

## 15. Prompt 3 prerequisites

Nothing blocks Prompt 3. It will build directly on:

- `RequirePlatformPermissions` with `platform.companies.manage`;
- `PlatformTargetCompanyGuard` for every `:companyId` route;
- `PlatformAuditService` for lifecycle-change audit;
- the reserved-subdomain list, which Company creation and update must validate
  against server-side (the database constraint is already in place as the
  backstop);
- `seedCompanyDefaults` and the single-transaction shape proven by
  `bootstrapDevelopmentCompany`, so a Company is never left half-created.

Two schema changes are expected in Prompt 3, both flagged by the Prompt 1 audit:
extending `companies_status_check` beyond `active | disabled`, and adding a
typed, server-only `companies.environment` column defaulting to `production`.

---

# Phase 1, Prompt 3 — Company creation, lifecycle and Accounting initialisation

## 16. The Company model

| Field | Notes |
| --- | --- |
| `code` | Unique on `lower(code)`. Normalised to uppercase on input. Immutable after creation. |
| `subdomain` | Unique, DNS-label checked, refused if reserved. Immutable after creation. |
| `name_en` | The single primary Company name. Arabic or English text both allowed; no separate legal/display split was invented because the schema has none. |
| `status` | `draft` · `active` · `suspended` · `disabled` |
| `environment` | `development` · `demo` · `sandbox` · `trial` · `production`. Immutable after creation. |
| `country_code` | ISO-2, default `AE`. |
| Currency / timezone / language | On `company_settings`, where they already lived. Currency is AED for every Company (`company_settings_currency_aed`). |
| Accounting provenance | `accounting_setup_status`, `accounting_template_code`, `accounting_template_version`, `accounting_template_sha256`, applied-at, applied-by. |

A database constraint requires the template provenance to be all-present or
all-absent: half a provenance record is worse than none.

## 17. Environment

`production` is the default and the fail-safe. The column is NOT NULL with no
`unknown` value, because an environment that merely *looked* unclassified is the
one state a future reset guard could get wrong.

**Backfill.** Every existing Company was set to `production` first. Exactly one
row was then reclassified as `development`, by requiring **three independent
signals to agree**: the `DEV-` code prefix, the `dev` subdomain, and the specific
identifier verified by inspection before the migration was written. A `DEV-`
prefix alone is evidence, not proof. In any other database that UPDATE matches
nothing and every Company stays `production`.

**Immutable after creation.** There is no field for it in the profile-edit
contract and no action to change it. `forbidNonWhitelisted` means a request that
tries is rejected outright. A production Company silently becoming
non-production is precisely the failure a destructive-maintenance guard must
never allow, so the safest available option was taken for this phase.

## 18. Lifecycle

```
draft ──▶ active ──▶ suspended ──▶ active
  │          │            │
  └──────────┴────────────┴──────▶ disabled   (terminal)
```

Declared as one table in `platform-company.service.ts`, not as conditionals
spread across three handlers. `disabled` is terminal: reopening a closed Company
is a decision nobody has made, and guessing it would be inventing product.

Lifecycle is driven by explicit commands — `activate`, `suspend`, `reactivate`,
`disable` — never by a status field on a PATCH. A writable status would put every
illegal transition one typo away and leave nowhere to demand a reason.
Suspension and closure require one.

**There is no delete route anywhere.** A Company's orders, journals and audit
trail must outlive the Company being closed.

### Suspension semantics

Session *validation* already required `c.status = 'active'`, so suspending a
Company kills its live sessions immediately. Sign-in did **not**: it tested
`companyStatus === "disabled"`, which was correct when `active` and `disabled`
were the only states and would have let a suspended Company keep signing in.
That check now requires the Company to be `active`, scoped to Company accounts
(`companyStatus` is null for a Platform Administrator).

Suspension preserves everything: users, accounting setup, configuration, history
and audit. Nothing is deleted, and reactivation restores access without
recreating anything.

**Deferred to later phases.** Whether background jobs, webhooks, the Storefront,
the mobile app and WhatsApp should also stop for a suspended Company is not
decided here. Those surfaces are owned by phases that have not been built, and
guessing their semantics would be worse than naming the gap.

## 19. Accounting initialisation

```
Create Company ─┬─ companies (draft)
                ├─ company_settings
                ├─ AccountingTemplateImporter
                │    ├─ chart_of_accounts         (new ids, key → id map)
                │    ├─ account_mappings          (resolved from the map)
                │    ├─ accounting_configurations (named slots resolved)
                │    ├─ company_balance_policies
                │    ├─ company_cash_accounts / company_bank_accounts
                │    ├─ expense_types / general_expense_categories
                │    ├─ allowance_types
                │    ├─ company_reference_counters (prefixes, all start at 1)
                │    ├─ company_business_day_configurations
                │    └─ verifyImport()            ← aborts the whole thing
                ├─ audit_events
                └─ COMMIT
```

One transaction. The importer never owns it, so any failure — a key that will
not resolve, a mapping that points nowhere, a verification that does not add up —
takes the Company row with it. There is no compensating cleanup and no
"mark it failed and carry on" branch: a half-configured tenant looks real,
appears in the list, and produces a posting error nobody can explain.

### Approved template registry

The browser sends a template **code and version**. It cannot send a file path, a
URL or template content. The server resolves the file name from its own
catalogue, then applies four gates: the code/version must be approved, the file
must parse, its canonical hash must match the **pinned** hash, and it must pass
the same validator the exporter runs.

The hash pin matters because the exporter is a command anyone can run: a
regenerated v1 with a different Chart of Accounts would otherwise initialise
Companies differently while every record still said `UAE_DELIVERY_STANDARD v1`.
Changing the template legitimately means changing the pinned constant in the
same commit — which is exactly the review step that ought to exist.

### Stable-key resolution

The template carries keys, never identifiers. During import the Chart of
Accounts is created first, building a runtime map from template key to the newly
generated account id; every mapping slot, every named configuration slot and
every Cash/Bank GL link resolves through that map. Template keys are **not**
persisted in place of foreign keys — the schema uses real identifiers and so does
the importer.

Keys are imported exactly as the approved template states them, including
`ASSET_OTHER_RECEIVABLE_1110`. Improving a key is an accounting-configuration
change followed by a template regeneration, not something an importer decides.
Mapping keys such as `delivery_revenue` are contracts the posting engine looks up
by name and are carried verbatim.

### What is never copied

No opening balance, batch or line. No journal, journal line, accounting event,
order, customer, trader, driver, employee, settlement, collection,
reconciliation, payroll record, expense or cash/bank movement. No source Company
identifier of any kind — the template contains none, so there is nothing to copy
even if the code tried. No source bank identity and no cash custodian: the format
has no field capable of carrying them.

`verifyImport` proves the zero-history state before the caller may commit, by
counting the transactional tables rather than trusting that nothing wrote to them.

### Two schema rules the import had to respect

**Automatic posting is never enabled by an import.**
`accounting_configurations_automatic_shape_check` requires that whenever
automatic posting is on, `automatic_posting_enabled_by_account_id` and
`automatic_posting_enabled_at` are both set — and that account column is a
composite FK to `accounts(id, company_id)`. The schema already insists that
turning automatic posting on is an act by an accountable **Company** user, and at
creation time no such user exists. That rule was kept rather than worked around:
automatic posting starts writing to the ledger the moment it is on, and nobody
should be able to point at a new tenant and find no one accountable for having
enabled it. The template's chosen **areas** are still carried over, so the
Company's Accounting Setup Wizard has the intended configuration waiting; only
the switch is left off.

**Platform-created rows have no Company-scoped creator.** Every
`created_by_account_id` on the setup tables is a composite FK to
`accounts(id, company_id)`. A Platform Administrator has `company_id = null` and
is therefore structurally ineligible. Those columns are left empty and the
Platform audit trail records who acted. Two of them were NOT NULL and are now
nullable; neither is read as a required value anywhere — the `createdBy`
segregation checks operate on `cash_bank_movements` and `general_expenses`, which
are transactions, not setup.

### Reference counters

Prefixes come from the template; counters always start at 1.
`company_reference_counters` is keyed `(company_id, reference_type)` and every
business reference built from it is unique **per Company**, so two Companies
initialised from the same template both start at `ORD-1` without colliding. The
gated test creates two Companies from the same template and asserts exactly
that. No source watermark is carried — the template does not contain one.

### Fiscal calendar

Fiscal **policy** is carried (start month, period model, periods per year); dated
fiscal years and periods are not. The Company's own calendar is then GENERATED
from that policy and the Company's own start date.

The year chosen is the one that *contains* the Company's start date. With a
January start month and an August creation date that is 1 Jan – 31 Dec of the
same year; with an April start month and a February creation date it would be
April of the *previous* year. Copying the source Company's dated year instead
would hand a Company created in 2027 a 2026 calendar, and
`validate_accounting_period_calendar` would refuse every period while
`assert_period_open_for_posting` refused every posting.

Twelve monthly periods are created, `<year>-P01` … `<year>-P12`, each spanning a
real calendar month (February's length is computed, not assumed). They are
created **`future`, not `open`** — which mirrors how the reference Company's
calendar actually exists in the database. Opening a period has a posting
consequence, and onboarding does not make that decision silently; it belongs to
accounting configuration, in the same spirit as §32's rule about opening
balances.

`verifyImport` checks there is exactly one fiscal year, that the period count
matches the policy, and that no period belongs to another Company's fiscal year.

### Business day

Created once, effective from `-infinity`, so no timestamp in the Company's life
falls outside a rule. The Platform Administrator may override the start time at
creation; when the field is left blank the approved template's default applies,
which is the point of a template default. Superseded rules from the source
Company are not in the template and none is fabricated.

## 20. Readiness and activation

Readiness is **server-derived**. It decides whether activation is offered, and a
rule the client could reinterpret is not a rule. Each item carries `required` and
a state of `complete` / `incomplete` / `optional`; only required items block.

| Item | Required |
| --- | --- |
| Company profile, code, environment, subdomain, timezone, currency, language | yes |
| Accounting setup `ready` | yes |
| Company Administrator | yes |
| Bank details | **no** — a placeholder exists; real details are entered before the bank is used |
| Opening balance | **no** — shown as `Not entered` |

**Opening balance is not an activation blocker.** A new Company may legitimately
begin with no history at all. If accounting rules later require balances before
posting for a particular Company, that belongs in accounting configuration, not
hard-coded into Platform onboarding.

**Decision: option B.** A Company stays `draft` until the first Company
Administrator exists. Activation implies the tenant is operational and
login-ready, and activating a tenant nobody can sign in to would make "Active"
mean something it does not. Until Prompt 4 creates that administrator, the
readiness panel shows `Company Administrator: Pending`, activation is refused by
the server with `company_not_ready`, and the button is disabled with the blocking
item named.

## 21. Platform API

| Route | Permission |
| --- | --- |
| `GET /api/v1/platform/companies` | `companies.read` |
| `GET /api/v1/platform/companies/accounting-templates` | `companies.read` |
| `POST /api/v1/platform/companies` | `companies.manage` |
| `GET /api/v1/platform/companies/:companyId` | `companies.read` |
| `GET …/:companyId/accounting-setup` | `companies.read` |
| `GET …/:companyId/readiness` | `companies.read` |
| `GET …/:companyId/context` | `companies.read` |
| `GET …/:companyId/audit` | `audit.read` |
| `PATCH /api/v1/platform/companies/:companyId` | `companies.manage` |
| `POST …/:companyId/activate` `suspend` `reactivate` `disable` | `companies.manage` |

No new permission codes were added. Read-only Platform accounts see everything
and change nothing.

The create contract accepts business fields only. `forbidNonWhitelisted` means a
request carrying `companyId`, `status`, `createdBy`, an account identifier, a
lifecycle timestamp or template content is **rejected**, not stripped — there is
no field for any of them.

## 22. Audit

`platform.company.created`, `platform.company.accounting_setup_applied`,
`platform.company.creation_failed`, `platform.company.profile_updated`,
`platform.company.activated`, `platform.company.suspended`,
`platform.company.reactivated`, `platform.company.disabled`.

`GET …/:companyId/audit` reads the trail back, gated by the pre-existing
`platform.audit.read` code rather than `companies.read`: seeing that a Company
exists and seeing every administrative action taken against it are different
levels of access. No new permission code was invented.

Creation audit shares the creation transaction: if the trail cannot be written,
the Company is not created. The **failure** record is deliberately written
outside it — a record that vanished with the rollback would answer no question,
and "why is there no Company?" is exactly the question someone will ask.

## 23. Platform UI

All in `apps/platform-web`. **No file under `apps/web`, `apps/store` or
`apps/mobile` was modified.**

- **Companies** — server-side search, status and environment filters, **sorting**
  and paging. Sorting is a server round-trip: sorting the current page in the
  browser would silently reorder 25 rows out of however many exist and look
  exactly like it worked. An **Onboarding** column shows an overall state
  (`incomplete` / `ready to activate` / `live` / `suspended` / `closed`) derived
  in the list query itself, so it costs one statement rather than one readiness
  computation per row. Production is badged distinctly because it is the value a
  future destructive-maintenance guard reads.
- **Create Company** — form → review → one action. No opening balance, orders,
  drivers, traders, payroll, billing, WhatsApp, Storefront or mobile fields.
- **Create Company** also carries an optional business-day start and a contact
  name; leaving the business-day blank keeps the template default.
- **Company detail** — overview, editable profile, Configuration, Accounting
  Setup (including the zero-history counts, because "did this tenant really
  start clean?" is what the panel is for), server-derived readiness, Audit
  summary, and lifecycle controls that match the Company's status and the
  caller's permission.
- **Profile editing** offers exactly the fields the API accepts. Code, subdomain
  and environment have no input, because the contract has no field for them — a
  form offering inputs the server rejects would teach the wrong mental model.

## 24. Known gaps after Prompt 3

- Company Administrator onboarding, activation, password recovery, unlock and
  session management — Prompt 4.
- Suspension semantics for background jobs, webhooks, Storefront, mobile and
  WhatsApp — the phases that own those surfaces.
- Company profile editing covers name, contact, address and registration numbers
  only. Currency, timezone and language are not yet editable after creation.
- Billing, subscription, usage metering, module configuration and feature flags.
- Company reset UI/API — the existing engine remains untouched and reserved for
  the Company Maintenance phase.
- Data Integrity / One-Leg engine. Onboarding validates its own atomic
  initialisation; that is not the cross-module integrity engine and the two must
  not be merged.

---

# Phase 1, Prompt 4 — Company Administrator onboarding and account support

## 25. The first administrator, and the provenance problem

A Company created by the Platform Portal has **no users and no roles**. Creating
its first administrator is therefore unlike creating any later one: there is no
Company actor to record as the creator.

Prompt 3 found that the Accounting setup tables use **composite** foreign keys
`(created_by_account_id, company_id) → accounts(id, company_id)`, which a
Platform Administrator (`company_id = null`) structurally cannot satisfy. The
same question was asked again here, against the live schema, and the answer is
different:

```
account_roles.assigned_by_account_id → accounts(id)          -- PLAIN
company_users                        → no creator column
accounts                             → no creator column
```

`account_roles.assigned_by_account_id` is a **plain** foreign key. Recording the
Platform Administrator there is both permitted and **true**, so the role
assignment carries real provenance. **No schema change was needed**, no fake
Company user was created, no arbitrary identifier was invented, and the Platform
actor stays `companyId: null` throughout.

## 26. The Company Administrator role

Created on first use, because a Company created in Prompt 3 has no roles at all.
It is the existing `company_admin` system role code — no second, semantically
equivalent role was introduced.

Its permissions are `users_roles.manage` and `company_profile.manage`: exactly
what this repository itself gives a freshly bootstrapped Company
(`bootstrapDevelopmentCompany` grants the first, and the Company Profile
migration granted the second to every role holding it). Deliberately **not** the
27 permissions the long-lived development Company has accumulated — those were
decisions people made about that Company over time, and copying them would
invent an operational policy for every future tenant. The first administrator
holds `users_roles.manage`, so they can grant whatever their Company actually
needs through the portal that owns that decision.

The role is chosen by the **server**. The request has no field for a role or a
permission list, so a browser cannot aim creation at anything else.

## 27. Credentials: a link, never a password

Platform staff never see, set or retrieve a Company password.

`UserAdministrationService.create` generates a random temporary password as it
always has; this flow **discards** it and returns it to nobody. The account is
therefore reachable only through a one-time link, and the Platform Administrator
holds no working credential for any Company.

### The token table already existed

`password_reset_tokens` was built by earlier work and never wired to anything.
It already had a unique format-checked SHA-256 `token_hash`, `expires_at`,
`used_at`, `revoked_at`, request metadata, and a `created_by_source` constrained
to exactly `self_service | administrator` — the Platform-initiated case, named
before this prompt existed. A new table would have re-invented a design the
schema had already made. A trigger (`password_reset_tokens_scope_guard`) also
forces the token's Company to equal the account's.

| Property | Behaviour |
| --- | --- |
| Token | 32 random bytes, base64url; only its SHA-256 is stored |
| Activation TTL | 48 hours |
| Reset TTL | 2 hours |
| Single use | `used_at` set **after** the password is stored, never before |
| Reissue | Every earlier live token for the account is revoked first |
| Replay | Rejected — used, revoked and expired all fail identically |
| Failure message | One generic message, so a guessed token cannot confirm an account exists |
| Logging | The raw token is hashed before it reaches any statement; it is never logged |
| Audit | Records that a link was **issued**, never the link |

### Why the token is burned last

Marking it used before the password write would let a failed write consume the
only link the person had, locking them out of their own account.

## 28. Where the link points

To the **Company** portal, at `/account-setup?token=…`, on the Company's own
subdomain. The host is built server-side from the Company row and the configured
tenant host suffix; nothing about the destination comes from the browser, so
there is no redirect to point elsewhere.

`apps/web` gained one small page for this — the Company-facing end of the flow.
It follows the pattern already there for the public Storefront and tracking
views: a pre-session path intercepted before session handling, because someone
following an activation link has no session and must not be shown the sign-in
form instead. The token is read from the query, used, and never persisted; on
success the URL is replaced so browser history carries no working link.

**Delivery is manual for now.** There is no outbound email infrastructure in
this repository, and building one for this prompt was out of scope. The link is
shown to the Platform Administrator **once**, immediately after generation, with
its expiry, and is not stored in the browser or retrievable later. This is a
temporary operational workflow, not the end state.

## 29. Account support

All delegated to `UserAdministrationService`, which already implements each
action and scopes every statement by the tenant context. Running it under the
Platform target-Company context inherits that scoping wholesale:
`lockCompanyUser` matches on `a.company_id = <target>`, so another Company's
account does not fail a check — it does not exist to the query.

| Action | Behaviour |
| --- | --- |
| Unlock | Clears the failed-login lock. Does not change the password. **Refuses a deactivated account** outright, so `locked` and `deactivated` stay genuinely distinct |
| Deactivate | Blocks login, revokes sessions, keeps the user and its history. Refused for a Company's **only** manager, so a tenant cannot be stranded |
| Reactivate | Permits authentication again, subject to password and Company state |
| Sessions | Metadata only — created, last seen, expiry, revoked, device, IP. No token, ever |
| Revoke one | The session must belong to that account, which must belong to the target Company |
| Revoke all | Returns how many were live |

Deletion does not exist anywhere in this surface.

## 30. Interaction rules that were tested separately

- **Company suspension outranks everything.** A suspended Company's users cannot
  sign in even after an unlock or a reactivation. Support actions remain
  available so an administrator can prepare, but none restores access.
- **Deactivation outranks a lock.** Unlocking a deactivated account is refused,
  and a deactivated account cannot be issued a fresh setup link either.
- **Password reset ends sessions immediately**, when the link is issued rather
  than when the password changes. Waiting would leave a stolen session alive
  during exactly the window the recovery exists to close. Completion revokes
  again, so no pre-existing session survives either path.

## 31. Readiness and activation

`Company Administrator` is **Complete** only when at least one account is
genuinely able to sign in: active account, active Company-user profile, active
`company_admin` role, and a password the person set themselves
(`force_password_change` cleared and `password_changed_at` set). An inserted row
is not readiness — a Company activated on the strength of one would be "Active"
with nobody able to enter it.

The three states are distinguished for the operator:

| Situation | Company Administrator | Next step |
| --- | --- | --- |
| No account | `incomplete` — "Pending" | Create Company Administrator |
| Invited, no password yet | `incomplete` — "Invitation pending…" | Waiting for the administrator to set a password |
| Password set | `complete` | Activate Company |

Readiness is **derived every time** from accounts, roles and credential state.
No cached `company_admin_ready` flag exists, so it cannot drift from the records
it describes.

Activation stays an intentional Platform action: completing password setup does
not activate the Company. The server re-checks readiness when Activate is
pressed and refuses with `company_not_ready` regardless of what the browser
believed.

### The fiscal-period warning

Prompt 3 creates accounting periods as `future`. Readiness now reports
`Accounting period not yet open — financial posting remains unavailable.` as a
**warning**, never a blocked item, and nothing in this prompt opens a period.

## 32. Platform API

| Route | Permission |
| --- | --- |
| `GET …/:companyId/users` | `users.read` |
| `POST …/:companyId/users/administrators` | `users.manage` |
| `POST …/:companyId/users/:accountId/activation` | `users.manage` |
| `POST …/:companyId/users/:accountId/password-reset` | `users.manage` |
| `POST …/:companyId/users/:accountId/unlock` | `users.manage` |
| `POST …/:companyId/users/:accountId/deactivate` | `users.manage` |
| `POST …/:companyId/users/:accountId/reactivate` | `users.manage` |
| `GET …/:companyId/users/:accountId/sessions` | `users.read` |
| `POST …/:companyId/users/:accountId/sessions/:sessionId/revoke` | `users.manage` |
| `POST …/:companyId/users/:accountId/sessions/revoke-all` | `users.manage` |

Public, Company-facing, no session: `POST /api/v1/auth/account-setup/describe`
and `POST /api/v1/auth/account-setup/complete`. The token is the only authority
they accept — there is no account, Company or email field, because one would let
a caller aim a valid token elsewhere or turn the endpoint into an
account-existence oracle.

No new permission codes were added; `platform.users.read` and
`platform.users.manage` were seeded in Prompt 2.

## 33. Login identifier uniqueness

Audited against the live indexes. Username, email and mobile are **per-Company**
unique for Company accounts:

```
accounts_company_normalized_username_unique  (company_id, normalized_username)
accounts_company_normalized_email_unique     (company_id, normalized_email)
accounts_company_normalized_mobile_unique    (company_id, normalized_mobile_number)
```

Two Companies may each have an `admin`. Platform usernames are globally unique
(`where company_id is null`). Mobile numbers are normalised to the canonical
`9715XXXXXXXX` form by the same decorator the Company portal uses —
`accounts_mobile_format` accepts nothing else, and a Platform-created account
must satisfy exactly the rules a Company-created one does.

## 34. Audit

`platform.company_user.administrator_created`, `.admin_role_created`,
`.activation_link_issued`, `.password_reset_requested`, `.unlocked`,
`.deactivated`, `.reactivated`, `.session_revoked`, `.all_sessions_revoked`.

Both trails are kept. The Company/account history that
`UserAdministrationService` already writes continues unchanged (what happened to
the account); the Platform trail records what Platform staff did. The
account-setup completion writes `company_user.account_setup_completed` with the
account itself as actor, because the person — not Platform staff — performed it.

No token, password, hash or session secret is written to either.

## 35. Password policy

Reused unchanged: `Length(8, 256)`, the same bound `LoginDto` and
`ChangePasswordDto` apply. A stricter Platform-only rule would create a password
that satisfies account setup but fails the ordinary change-password screen.

**Gap for security review (Prompt 5):** there is no complexity, dictionary or
breach-list requirement anywhere in the product, and no re-use history beyond
"must differ from the current password" on the change-password path. This is
recorded rather than redesigned here, as §49 directs.

## 36. MFA

**Deferred / not mandatory.** No MFA implementation, screen, placeholder or
column. Nothing blocks activation for its absence.

## 37. Known gaps after Prompt 4

- **Outbound email.** Activation and reset links are delivered manually. A real
  delivery channel is the obvious next operational requirement.
- **Password policy strength** — see §35.
- Login-failure telemetry is limited to failed-attempt count, lock state and
  last login. Prompt 5 owns security-event review.
- Platform user-management remains an onboarding and support surface. Ordinary
  Company user administration stays in the Company portal.
- Company profile editing, billing, usage, modules, reset UI and the integrity
  engine remain as recorded after Prompt 3.


---

## 38. Platform audit browser (Prompt 5)

`GET /api/v1/platform/audit` and `GET /api/v1/platform/audit/actions` expose the
Platform administrative trail across every Company, gated by
`platform.audit.read`. They live in their own controller rather than under
`/platform/companies/:companyId`, because they answer a different question: not
"what was done to this Company" but "what did Platform administration do".

Filtering (Company, action prefix, actor, date range) and paging happen in SQL.
`audit_events` is append-only and never pruned, so a client-side filter would
either return a wrong page or read the whole table to build a right one. The
total comes from a `count(*) over ()` window on the same scan rather than a
second query that could disagree with the first.

The `action like 'platform.%'` predicate is applied unconditionally and is not a
default the caller can widen. `audit_events` also carries Company operational
history — order edits, settlement changes, configuration writes — and allowing
the filter to be relaxed would silently convert an administrative-trail screen
into a cross-Company reader of every Company's operational records. The
caller-supplied `action` filter is matched as a prefix with `%` and `_` escaped,
so a wildcard cannot be smuggled in.

The Portal screen (`apps/platform-web/src/pages/AuditPage.tsx`) submits filters
deliberately rather than live-as-you-type: each change is a query against a table
that only grows, and firing one per keystroke would load the audit table in
proportion to typing speed for results nobody is reading yet.

## 39. Audit outcome recording (Prompt 5)

`audit_events` now carries `result` (`success` | `failure` | `denied`),
`failure_reason` and `source_application`, added by
`20260810100000_platform_audit_hardening`. They are nullable with no default
because the table is append-only: the 2,102 pre-existing rows cannot be
backfilled by anything, and a `NOT NULL DEFAULT 'success'` would make all of
them claim an outcome nobody recorded.

`source_application` is a new column rather than a constraint on the existing
`source`, whose live values have drifted to include actions (`order_creation`,
`customer_configuration`) as well as applications. Constraining `source` would
fail against data that cannot be corrected.

Redaction (`redactSensitive`) is applied inside the audit writers, not at each
call site. A call site that forgets produces a permanent disclosure, because an
append-only table cannot be redacted afterwards.

Refusals are recorded as well as successes: a denied lifecycle transition writes
`platform.company.transition_denied` with `result = 'denied'`, outside the
transaction the exception is about to roll back. A failed sign-in records
`failure_reason = 'invalid_credentials'` and deliberately does not say which
check failed — naming it would rebuild in the audit table the enumeration oracle
the generic 401 exists to prevent.

## 40. Certification

Phase 1 closure evidence is in
`PLATFORM_ADMINISTRATION_PHASE_1_CERTIFICATION.md`.
