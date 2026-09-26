# Platform Administration Portal — Phase 1 Certification

Status: **PHASE 1 CERTIFIED**
Date: 2026-08-07
Scope: Prompts 1–5 of Phase 1 (foundation, authentication, Company creation, Company
Administrator onboarding, hardening and certification).

This document records what was verified, how, and what remains open. It is deliberately
written so that a reader who did not do the work can re-run the evidence rather than take
the conclusions on trust.

---

## 1. What Phase 1 claims

A Platform Administrator can take a Company from not existing to operating, entirely
through `platform.bluelinegpt.com`, with no manual database step:

1. Create the Company, with a complete standard Accounting setup, in one transaction.
2. Create its first Company Administrator and issue an activation link.
3. Watch server-derived readiness become satisfied.
4. Activate the Company.
5. The Company Administrator sets their own password and signs in to their own Company.

And that nothing else becomes possible along the way: no cross-Company access, no
Platform permission reachable by a Company user, no destructive capability, no credential
readable by script, and no administrative action that leaves no trace.

---

## 2. How the claim is evidenced

| Evidence | File | Gate |
|---|---|---|
| Route inventory and public-route certification | `apps/api/src/platform/platform-route-inventory.test.ts` | always runs |
| Security certification (cookies, CSRF, storage, secrets, enumeration, redirects, isolation, destructive capability) | `apps/api/src/platform/platform-security-certification.test.ts` | always runs |
| End-to-end onboarding, isolation attack matrix, lifecycle, audit | `apps/api/src/platform/platform-phase1-certification.database.test.ts` | `RUN_PLATFORM_CERTIFICATION_DATABASE=true` |
| Company Administrator onboarding detail | `apps/api/src/platform/platform-company-user.database.test.ts` | `RUN_PLATFORM_COMPANY_USER_DATABASE=true` |
| Company creation and lifecycle detail | `apps/api/src/platform/platform-company.database.test.ts` | `RUN_PLATFORM_COMPANY_DATABASE=true` |
| Portal UI, including the audit browser | `apps/platform-web/src/app/*.test.tsx` | always runs |

The route inventory is **discovered**, not listed: controllers are read from
`platform.module.ts` and routes from Nest's own metadata. A new controller that is not
registered in the test fails it; a new route that is not protected fails it. A
hand-maintained list would have certified the list rather than the application.

Run the always-on evidence:

```bash
pnpm --filter @blueline/api exec vitest run src/platform && pnpm --filter @blueline/platform-web test
```

Run the end-to-end certification:

```bash
RUN_PLATFORM_CERTIFICATION_DATABASE=true pnpm --filter @blueline/api exec vitest run src/platform/platform-phase1-certification.database.test.ts
```

The certification suite runs inside one transaction that is always rolled back, with a
savepoint-based transaction-manager override so that a service-level rollback is a **real**
rollback rather than a silently ignored one. Without that override the atomicity
assertions would have certified a guarantee production does not have. It never reads from
or writes to the development Company.

---

## 3. Certified properties

### 3.1 Authentication and session transport

- The Platform sign-in response contains **no token**. The credential exists only in an
  HttpOnly cookie (`Path=/api`, `SameSite=Lax`, `Secure` derived from the environment).
- `apps/platform-web` contains no `localStorage`, `sessionStorage`, `document.cookie` or
  `indexedDB` reference in any non-test file, and the API client has no token field, no
  `setAccessToken` and no `Authorization` header.
- Cookie-authenticated mutations require `X-Blueline-Session`. Certified live: a
  `POST .../suspend` carrying a valid session cookie but no header returns 403 **and the
  Company's status is unchanged**.
- Sign-out clears the cookie.

### 3.2 Authorisation

- 25 Platform routes are enumerated. Exactly one is public: `POST /platform/auth/login`.
- Every private route requires both `account_kind = 'platform_administrator'` **and**
  `platform.access`, plus its granular code. Identity alone is not authority; a Platform
  account with no roles authenticates and can reach nothing.
- Read and manage are separated on every route. Certified live: an account holding
  `platform.access`, `platform.companies.read` and `platform.users.read` can list
  Companies and read users, and is refused (403) on create, activate and audit.
- `platform.audit.read` is separate from `platform.companies.read`: seeing that a Company
  exists and seeing every administrative action against it are different disclosures.
- Every Platform permission is inside the `platform.` namespace, which the Company role
  service excludes (`role.service.ts`: `where code not like 'platform.%'`). The namespace
  **is** the boundary; there is no second permission system to keep in step.
- No reset, billing, impersonation or maintenance permission exists. Seeding a permission
  nothing enforces would advertise a control that does not exist.

### 3.3 Tenant isolation

Certified live against two real Companies created through the Portal:

| Attack | Result |
|---|---|
| Unauthenticated request to any Platform route | 401 |
| Company Administrator session against `/platform/companies` | refused |
| Company Administrator session against another Company's Platform route | refused |
| `?companyId=<other>` on a targeted route | ignored or rejected; never honoured |
| `X-Company-Id: <other>` header | ignored |
| `Host: <other-company>` header | ignored |
| Unknown Company UUID | 404 |
| Malformed Company identifier | 404, identical response |
| Company user granted a `platform.*` permission | impossible — namespace excluded |

The target Company is resolved **server-side** from the route parameter by
`PlatformTargetCompanyGuard`: the parameter is format-checked, the row is read from the
database, and every fact used downstream comes from that row. The Platform actor's own
`companyId` remains `null` for the whole request; only the tenant slot moves.

Unknown and malformed identifiers deliberately return the same 404. A distinct "no such
Company" would turn the route into a Company-id oracle for anyone holding a Platform
session.

### 3.4 Company creation

- Creation is atomic. Certified by counting Companies before and after a deliberately
  conflicting creation: the count is unchanged, so a failed creation leaves no orphaned
  Chart of Accounts behind.
- A Company is created in `draft`, never `active`. An accidental creation is not usable.
- The Accounting setup lands with ≥ 20 accounts scoped to the new Company, from the
  hash-pinned `UAE_DELIVERY_STANDARD` v1 template
  (`2d66f8ee57cc17ce732a2ee3158f8e40131b8e815dfa9355ff13551070e06581`).
- Reserved subdomains are refused (400, `subdomain_reserved`), enforced by one shared list
  read by both the host resolver and a database CHECK constraint. `platform` is reserved,
  so no Company can shadow the Portal.

### 3.5 Lifecycle

Legal transitions, enforced in one table and certified live:

| From | To |
|---|---|
| `draft` | `active`, `disabled` |
| `active` | `suspended`, `disabled` |
| `suspended` | `active`, `disabled` |
| `disabled` | — terminal |

- Activation is refused (409) while readiness is unsatisfied — specifically, while no
  Company Administrator can actually sign in.
- Suspension requires a reason (400 without one) and takes effect **immediately**: the
  Company Administrator's next sign-in attempt returns 401.
- Reactivation restores sign-in.
- `disabled` is terminal: activate, reactivate and suspend all return 409 afterwards.
- Suspending a `draft` Company is refused (409).
- Closing a Company destroys nothing: its Chart of Accounts and its accounts survive.
  There is **no DELETE route anywhere** on the Platform surface.

### 3.6 Company Administrator onboarding

- The created account belongs to the target Company (`company_id` = target,
  `account_kind = 'company_user'`) and holds **zero** `platform.*` permissions.
- No password is ever returned to the Platform administrator.
- Only the SHA-256 hash of the activation token is stored; the raw token exists for the
  lifetime of one HTTP response and is never logged or audited.
- The token is burned **after** the password is written, so a failed write cannot consume
  the only link the user had.
- Single use, certified: replaying the same link returns 400.
- Every unusable link — never existed, expired, revoked, already used — yields one
  identical message.
- Completing setup revokes every pre-existing session.
- The setup destination is built server-side from configuration. No request field
  influences it, and no Platform DTO accepts a redirect, return or callback parameter.

### 3.7 Audit

- Every Platform decision is recorded. Certified live: `platform.company.created`,
  `platform.company.activated`, `platform.company.suspended` and
  `platform.company.disabled` are all present for the certification Company.
- The trail is **append-only**. Certified live: a direct
  `update audit_events set reason = 'tampered'` is rejected by `reject_audit_mutation`.
- No credential material reaches it. Asserted both statically (no `password`, `token`,
  `setupUrl` or `secret` key in any Platform audit payload) and live (the whole audit
  response is scanned).
- New in this prompt: a Platform-wide audit browser
  (`GET /platform/audit`, `GET /platform/audit/actions`) with server-side filtering by
  Company, action prefix, actor and date range, and server-side paging. Filtering happens
  in SQL because `audit_events` is append-only and unbounded; a client-side filter would
  describe one page as if it were the whole history.
- The `action like 'platform.%'` filter is applied **unconditionally** and cannot be
  widened by a query parameter. `audit_events` also holds Company operational history, and
  letting the filter be relaxed would turn an administrative-trail screen into a
  cross-Company reader of every Company's operational records. Certified live.
- The `action` filter is matched as a prefix with `%` and `_` escaped, so a caller cannot
  smuggle a wildcard in.

---

## 4. Audit hardening (applied)

`database/migrations/20260810100000_platform_audit_hardening.ts` is applied. Verified
against the live schema: `result`, `failure_reason` and `source_application` exist on
`audit_events`, and the partial index `audit_events_platform_time_index` is present.

Two design decisions are recorded here because they will look wrong to a reader who does
not know the constraint:

- **The columns are nullable with no default.** `audit_events` is append-only —
  `reject_audit_mutation` refuses every UPDATE and DELETE — so the 2,102 historical rows
  cannot be backfilled by anything. A `NOT NULL DEFAULT 'success'` would make every one of
  them claim an outcome nobody recorded. `result IS NULL` meaning "written before result
  tracking existed" is a true statement; a default would be a false one.
- **`source_application` is a new column, not a constraint on `source`.** `source` is
  uncontrolled free text whose live values include `order_creation` and
  `customer_configuration` — actions, not applications. Constraining it would fail against
  existing data that cannot be corrected, so `source` is left untouched for its existing
  writers and a separate controlled column answers the question Phase 1 needs.

A shape constraint enforces that a `failure` or `denied` entry carries a reason, and that
a reason cannot exist without one. The service checks the same rule first, so a call-site
mistake produces a message naming the call site rather than the table.

### 4.1 Redaction is central, not per call site

`redactSensitive` replaces the value of any key whose name contains `password`, `secret`,
`token`, `credential`, `authorization`, `cookie`, `apikey`, `privatekey` or `setupurl`, at
any depth, in both `before` and `after`. It is applied inside the audit writers rather than
at each call site because a call site that forgets produces a **permanent** disclosure:
the table is append-only, so a secret written into it cannot afterwards be edited, deleted
or redacted by anyone.

### 4.2 Failure and denial paths

- A failed Platform sign-in is recorded as `result = 'failure'` with
  `failure_reason = 'invalid_credentials'` — deliberately generic. The service refuses
  unknown account, wrong password, disabled account and suspended Company identically, and
  naming the cause in a table audit readers can query would rebuild the enumeration oracle
  the generic 401 exists to prevent. Certified live.
- A refused lifecycle change is recorded as `platform.company.transition_denied` with
  `result = 'denied'` and a reason distinguishing an illegal transition from an unready
  Company. It is written **outside** the operation's transaction, which the exception is
  about to roll back — the one place where the audit write must not share the operation's
  fate.
- Every audit row written by the Platform now carries `source_application = 'platform-web'`
  and a non-null `result`. Certified live across the whole end-to-end journey.

### 4.3 Migration ordering conflict — resolved

`db:migrate` was briefly blocked repository-wide by a parallel-development migration
(`20260808500000_employee_collection_earnings`) that sorted before already-applied Platform
migrations. It has since been renumbered to `20260810200000` by its owner. Both it and the
audit hardening migration are applied; the migration table now ends
`… company_contact_name | platform_audit_hardening | employee_collection_earnings`.

## 5. Findings recorded, not fixed

### 5.1 `activate` and `reactivate` are aliases

Both routes request the same `→ active` transition, so `POST .../activate` against a
suspended Company succeeds and is in effect a reactivation. This is the transition table
behaving correctly — `suspended → active` is legal, and readiness is re-checked either way
— but the two route names read as distinct operations when they are not. Certified safe;
recorded as a naming imprecision rather than changed, because renaming a route already
consumed by the Portal is a breaking change that belongs in its own decision.

### 5.2 Password policy is length-only

`@Length(8, 256)` is the whole policy, shared with `ChangePasswordDto` and `LoginDto`.
Accepted and deferred rather than changed: introducing a stricter rule only on the
Platform-issued activation path would let an administrator set a password through the
ordinary change-password screen that the activation screen would have refused, which is
worse than a uniform weak policy. A policy change belongs across all three call sites at
once, with MFA, in the phase that owns it.

### 5.3 Parallel `apps/web` typecheck break

`src/features/configuration/TraderConfigurationWorkspace.tsx(687,43): error TS2339` is
present and is not Platform work — it is absent from `git show HEAD:` of that file. Left
untouched, per the instruction not to fix unrelated `apps/web` debt.

---

## 6. What Phase 1 deliberately does not include

- MFA (deferred by instruction).
- Any Company data reset, destructive maintenance or impersonation capability.
- Billing, WhatsApp, Storefront or Mobile Platform controls.
- Any modification to Marketplace, reconciliation, Orders, settlements, Journal Entries or
  `file_objects`.
- Any change to the Company reset engine, which remains a CLI capability, unregistered in
  `PlatformModule` and unreachable over HTTP. Certified by test.
