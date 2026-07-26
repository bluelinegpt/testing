# Login Company selection and public Company list

Status: **Deferred — approved for a later phase**
Raised: 19 July 2026, during Stage 6 visual verification
Decision by: Product owner
Do not implement during the Driver Cash Reconciliation phase.

## What was raised

1. Operators do not work across two Companies, so the login screen should not
   require choosing a Company. Login should be username plus password.
2. `GET /auth/companies` is public and returns every Company to any caller.
   That is acceptable in local development but **not acceptable** once the
   system is exposed. It must be changed in a later phase.

## Current behaviour

- Accounts are Company-scoped. Usernames are unique **per Company**, not
  globally: `accounts_company_username_unique` in
  `database/migrations/20260713230000_core_tenancy_security.ts`. Platform
  administrators already have a separate global uniqueness index.
- `POST /auth/login` therefore requires `companySubdomain`, `username` and
  `password`, because a username alone does not identify an account.
- `GET /auth/companies` is annotated `@Public()` in
  `apps/api/src/authentication/authentication.controller.ts` and exists to
  populate the login dropdown.
- The dropdown is a local-development affordance: in a deployment where each
  tenant has its own subdomain, the Company is implied by the hostname.

## Why this is not a one-line change

Removing Company selection requires choosing one of these, each with different
cost and risk:

**Option A — derive the Company from the request hostname.**
No schema change. Login stays Company-scoped and secure. `GET /auth/companies`
can then be removed or restricted to non-production. Requires per-tenant
subdomains in the deployment. Local development still needs a fallback, because
`127.0.0.1` carries no tenant information.

**Option B — make usernames globally unique.**
Login becomes username plus password with no Company input. Requires replacing
`accounts_company_username_unique` with a global unique index, and a migration
that first proves no duplicate usernames exist across Companies. Once global,
two Companies can never reuse a username — a real operational constraint for a
multi-tenant product.

**Option C — identify the account by email.**
Emails are currently unique per Company (`company_users_company_email_unique`),
so this carries the same global-uniqueness question as Option B.

Option A is the smallest change and the most conventional for multi-tenant
systems. Option B matches the stated expectation most directly but permanently
constrains tenant onboarding.

## Security item to resolve in the same phase

`GET /auth/companies` currently allows unauthenticated enumeration of every
tenant: subdomain and name. Beyond disclosing the customer list, it gives an
attacker a ready target list for credential stuffing. Whichever option is
chosen, this endpoint must not remain publicly listable outside development.

## Required before implementation

- Confirm the production routing model: does each tenant get its own subdomain?
- Audit existing usernames for cross-Company duplicates if Option B is chosen.
- Decide whether platform administrator login is affected.
- Preserve Company-scoped authorisation regardless of how the account is
  identified: identifying an account must not weaken tenant isolation.
