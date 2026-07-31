# Employee, Driver, and Trader User Access

## Status

Source-level account-kind-aware access integration and classified legacy-synchronization
development. No runtime or production-readiness claim is made.

## Existing authentication reused

- `accounts` is the authentication identity and stores the password hash, normalized username,
  normalized email, normalized UAE mobile number, status, lockout state, forced-password-change
  state, and password timestamps.
- `company_users` is the Company membership/profile for internal users.
- `account_roles`, `roles`, and `role_permissions` provide backend-authoritative permissions.
- `account_sessions` stores hashed bearer-session tokens and supports revocation.
- Company login resolves the tenant from the request host; the login form does not accept a
  caller-controlled Company ID.
- Username, email, and mobile-number login already share one password and one lockout counter.
- Password hashing, temporary-password generation, administrator reset, forced password change,
  self-service password change, session revocation, lock/unlock, disable/enable, and audit history
  are existing reusable services.

## UAE mobile login

Accepted forms include `0506468441`, `506468441`, `971506468441`,
`+971506468441`, and equivalent values containing spaces, parentheses, dots, or hyphens.
The canonical value is `9715XXXXXXXX`. Normalization occurs before validation, storage, uniqueness
checking, and login lookup.

Login identifiers are Company-unique, not globally unique. This is safe in the current architecture
because the Company is resolved from the trusted request host before account lookup. The same
identifier may exist in another Company without creating an ambiguous login on the current host.

## Business-profile links

The additive `user_business_links` foundation links immutable IDs:

- Account to Employee
- Account to Driver
- Account to Trader

Every link carries Company ID, access status, primary status, lifecycle actors and timestamps,
reasons, and version. Database guards reject cross-Company or missing business records. Active
Employee and Driver records are single-user; a Trader can have multiple active Users.
Account-kind rules are authoritative: Employee links require `company_user`, Driver links require
`driver`, and Trader links require `trader`. Profile switching and cross-kind privilege merging are
not supported.

Existing direct `employees.company_user_id`, `drivers.account_id`, and Trader portal identity
relationships remain untouched for compatibility. Controlled synchronization into the flexible
link model is required before those legacy columns can be retired.

Access status is independent from business status and global account status:

- Business status controls whether the Employee, Driver, or Trader is operationally active.
- Account status controls whether the User can authenticate at all.
- Link status controls access through one specific business profile.

Suspension is reversible. Revocation is historical and terminal. Neither deletes the User or
business record.

## Portal and Order scope reused

The existing portal identity kinds are `driver` and `trader`.

- Trader Order queries are Company-scoped and constrained to the authenticated Trader ID.
- Driver Order queries are Company-scoped and constrained to the authenticated Driver ID and
  `orders.assigned_driver_id`.
- Portal routes expose Orders only. Driver status actions use the existing status-transition model.
- Company administration, configuration, accounting, payroll, reports, settlement, and collection
  workspaces are not rendered for portal identities.

Backend query scope, rather than menu hiding, prevents direct URL or API access to another profile's
Order.

## Password management

The normal Edit User form no longer changes the Linked Employee relationship. Existing links are
read-only there and should be managed from the source business record.

Password fields in Login and Change Password are permanently masked. Existing administrator reset
generates a strong temporary password, shows it once, stores only its hash, forces password change,
sets an expiry, revokes sessions, and audits the operation. Self-service password change verifies
the current password, prevents same-password reuse, clears the forced-change state, revokes other
sessions, and audits completion.

The additive `password_reset_tokens` table stores only token hashes and supports expiry, single use,
revocation, request metadata, and history. A Forgot Password API/UI is not exposed yet because this
repository has no email sender or reset-link origin configuration. Returning a token to the browser
or writing it to logs would violate the approved security requirements.

## Permissions

Existing `users_roles.manage` remains authoritative for User lifecycle, roles, administrator reset,
unlock, and session revocation. No new permission keys or automatic role grants were added.

## Known limitations and deferred work

- Email delivery, Forgot Password request delivery, and reset-page token completion are unresolved.
- New Users can be created and linked atomically from the Employee, Driver, or Trader source record.
  The backend derives and enforces the account kind. Existing-User selectors are backend-filtered
  to active, same-Company, correctly typed, unconflicted accounts.
- Role assignment, administrator password reset, and unlock reuse Open Linked User rather than
  duplicating security-sensitive forms inside every business profile.
- The controlled legacy preview and synchronization require the additive migration to be applied
  first and must be invoked explicitly by an authorized Administrator.
- SMS, OTP, WhatsApp, MFA, social login, mobile applications, and external identity providers are
  deferred.

## Source-record access completion

Employee and Driver details now load a System Access panel. Trader detail includes a Portal Users
tab and supports multiple linked Users. These screens list historical links and allow an authorized
Administrator to link an existing same-Company User, suspend, explicitly restore, revoke, revoke
profile-bound sessions, and open the linked User. User detail presents Linked Profiles read-only;
the normal Edit User form still contains no Linked Employee selector.

The API exposes Company-scoped Employee, Driver, and Trader link queries and lifecycle actions.
Employee and Driver uniqueness and multiple Trader Users are enforced by the existing additive
link constraints. Revocation is historical and cannot be restored.

Existing direct `employees.company_user_id`, `drivers.account_id`, and `traders.account_id` links
can be previewed through `GET /users/business-links/legacy-preview` and synchronized explicitly
through `POST /users/business-links/legacy-sync`. Synchronization uses IDs and Company scope only.
It is idempotent and was not executed by this development task.

Sessions now have additive profile-link, profile-type, and profile-ID metadata. Driver and Trader
login requires exactly one active link matching the existing identity kind. Authentication resolves
the profile server-side and stores it on the session. Suspending or revoking one link revokes only
sessions bound to that link; globally disabling or locking the User retains the existing all-session
behavior.

Disabling an Employee, Driver, or Trader automatically suspends that profile's active links and
revokes only its bound sessions. Re-enabling a business record does not silently restore access;
an authorized Administrator must restore the link explicitly.

Driver and Trader portal Order resolvers now require the profile ID bound to the authenticated
session plus an active `user_business_links` row. Driver list and status mutation queries remain
Company-scoped and `assigned_driver_id`-scoped. Trader list remains Company-scoped and
`trader_id`-scoped. The portal has only list and permitted Driver status endpoints; it exposes no
generic Order detail, attachment, history, assignment, settlement, Accounting, or administration
endpoint. Trader access is read-only.

Source-record password operations reuse the linked User detail actions for temporary password,
forced change, unlock, and global session revocation. Forgot Password delivery remains deferred
because no secure email sender or reset-link origin is configured.

## Validation restrictions observed

No tests, typecheck, lint, build, migration validation, database verification, browser testing, or
migration execution was performed. No commit was created. The ALDana spreadsheet was not touched.

## Routes and authorization

The source UI uses these Company-scoped routes:

- `GET /configuration/employees/:id/system-access`
- `GET /configuration/employees/:id/system-access/eligible-users`
- `POST /configuration/employees/:id/system-access/create-user`
- `POST /configuration/employees/:id/system-access/link-user`
- `GET /configuration/drivers/:id/system-access`
- `GET /configuration/drivers/:id/system-access/eligible-users`
- `POST /configuration/drivers/:id/system-access/create-user`
- `POST /configuration/drivers/:id/system-access/link-user`
- `GET /configuration/traders/:id/portal-users`
- `GET /configuration/traders/:id/portal-users/eligible-users`
- `POST /configuration/traders/:id/portal-users/create-user`
- `POST /configuration/traders/:id/portal-users/link`
- `POST /configuration/business-access/:linkId/suspend`
- `POST /configuration/business-access/:linkId/restore`
- `POST /configuration/business-access/:linkId/revoke`
- `POST /configuration/business-access/:linkId/revoke-sessions`
- `GET /users/business-links/legacy-preview`
- `POST /users/business-links/legacy-sync`

All require a Company User with the existing `users_roles.manage` permission. The repository has
no separate Employee-, Driver-, or Trader-management permission, and the existing source
configuration routes use the same administration permission. No new permission or role grant was
added.

The frontend routes remain `/configuration/employees/:code`,
`/configuration/drivers/:code`, `/configuration/traders/:code`, and
`/configuration/users/:accountId`. Create New User opens the existing User creation workflow.
Role assignment, administrator reset (including one-time temporary password and forced change),
unlock, and global User-session controls open the existing linked-User workflow.

## Constraints, concurrency, and stable outcomes

Database uniqueness is the final concurrency guard: one active/suspended/invited link per Employee,
one per Driver, multiple different Users per Trader, and at most one active Trader profile per User.
The same User may have an Employee and Driver link simultaneously. Link creation checks and locks
same-Company state before insertion. Repeated exact linking and repeated lifecycle transitions
return the current result without another audit event. The explicit legacy synchronizer is bounded
to immutable legacy IDs and is safe to rerun.

Stable business errors used by this implementation include
`employee_system_access_not_found`, `driver_system_access_not_found`,
`trader_portal_user_not_found`, `employee_user_link_exists`, `driver_user_link_exists`,
`user_profile_company_mismatch`, `user_profile_link_not_found`,
`user_profile_access_revoked`, `profile_scope_required`, `profile_access_inactive`, and
`driver_order_access_denied`. English and Arabic safe UI messages are provided for the applicable
errors. Database constraint details are not intentionally exposed by these workflows.

Create-and-link, existing-account link, and selected legacy synchronization reserve an operation
and request hash in the shared `idempotency_records` table. Exact retries replay the recorded
result; reuse with a different payload returns a stable conflict.

## Portal endpoint audit

The actual portal controller exposes exactly:

- `GET /portal/driver/orders`
- `PATCH /portal/driver/orders/:orderId/status`
- `GET /portal/trader/orders`

There are no portal Order detail, item, attachment, history, proof, return, assignment, settlement,
Accounting, configuration, report, or bulk-operation endpoints. Consequently those data sets are
not indirectly exposed through a broad endpoint. Driver list SQL requires Company and assigned
Driver. Driver status mutation resolves the bound active Driver and rejects a non-owned Order with
the same safe not-found response while recording a blocked-access audit. Trader list SQL requires
Company and Trader and remains read-only.

The frontend selects `PortalWorkspace` before Company workspace routing for Driver and Trader
identities. Driver sees My Orders/status actions plus profile/password/sign-out controls; Trader sees
read-only Orders plus profile/password/sign-out controls. Company administration navigation is not
constructed for either identity, so direct Company URLs cannot mount Company screens. Employee
Company Users continue to use the existing permission-derived Company navigation and route guard.

## Production-readiness statement

This is source-level development only. Production readiness is not claimed. Secure Forgot Password
delivery and reset-link origin remain unresolved. SMS, OTP, MFA, social login, mobile applications,
and external identity providers remain deferred. Future mobile applications can reuse the
immutable link, profile-bound session, lifecycle, and portal-scope model.

## Account-kind-aware blocker resolution — 2026-07-31

Employee source creation now creates a `company_user`, its `company_users` membership, selected
same-Company roles, and the Employee link in one transaction. Driver source creation creates a
`driver` account and Driver link; Trader source creation creates a `trader` account and Trader link.
Driver and Trader accounts cannot receive Company roles through this workflow. Identifier checks
cover Company-scoped normalized username, email, and UAE mobile values, with database uniqueness as
the final concurrency guard and stable conflict translation.

The User Administration list now includes all non-platform account kinds and provides an
account-kind filter and read-only account-kind display in list and detail views. Password reset,
forced change, lock/unlock, disable/reactivate, session revocation, and audit detail remain
centralized. Role assignment is explicitly limited to `company_user`.

Legacy preview is read-only and classifies immutable direct references as `eligible`,
`already_synchronized`, `duplicate`, `cross_company_conflict`, `account_kind_conflict`,
`employee_link_conflict`, `driver_link_conflict`, `trader_link_conflict`, `missing_user`,
`missing_business_record`, `inactive_business_record`, `disabled_user`,
`invalid_legacy_reference`, or `manual_review_required`. Its SHA-256 identity covers Company-scoped
candidate IDs, account and business versions, state, classifications, and active-link state.

Synchronization accepts only explicitly selected candidate IDs from the exact preview identity,
rejects stale previews, caps a batch at 50, locks selected state in deterministic order, and creates
all selected eligible links and the audit record in one transaction. Any failure rolls back the
whole batch. Legacy source columns are not changed or deleted. Preview and synchronization are
never automatic and were not executed by this task.

Stable errors include `user_profile_account_kind_mismatch`,
`user_profile_account_inactive`, `user_username_conflict`, `user_email_conflict`,
`user_mobile_conflict`, `user_access_idempotency_key_required`,
`user_access_idempotency_payload_mismatch`, `legacy_sync_preview_stale`,
`legacy_sync_candidate_ineligible`, and the profile-specific active-link conflict codes.

One additive migration, `20260801170000_user_business_account_kind_guard.ts`, was required to make
the account-kind rule a final database boundary for every writer. It adds only a validation trigger
and does not rewrite legacy data. Neither this migration nor the earlier access migration was
executed. No permission key or default role grant was added; `users_roles.manage` remains
authoritative.

## Validation review — 2026-07-31

### Review boundary

This was a source review only. Migration `20260801150000_user_business_access.ts` was not executed,
legacy synchronization was not executed, and no runtime login was performed. No tests, typecheck,
lint, build, migration validation, database verification, or browser testing was run. Runtime or
production readiness is not claimed.

### Architecture and migration review

The migration is ordered after the existing tenancy, authentication-session, login-identifier,
Employee, Driver, and Trader foundations. The initial source incorrectly attempted to create
`password_reset_tokens`, which already exists in `20260713230040_authentication_sessions.ts`, and
its rollback would have dropped that pre-existing table. The migration now alters the existing
table additively and rolls back only its new columns, constraints, and indexes.

`user_business_links` uses immutable Account and business-record IDs. Employee and Driver
active/invited/suspended uniqueness is enforced per Company and entity. Trader links allow multiple
Accounts per Trader while preventing the same Account from holding multiple active Trader profiles.
Driver Accounts are likewise limited to one active Driver profile so session resolution cannot
become ambiguous.
Lifecycle history remains after suspension or revocation. Actor references and session-to-link
references are now Company-scoped composite foreign keys.

Existing Company sessions remain compatible because profile metadata is nullable. Existing Driver
and Trader sessions have no profile binding and intentionally fail closed after this migration;
they require controlled legacy-link synchronization followed by a new login. This is a rollout
limitation, not runtime success.

The manually maintained database typing now declares the session profile fields, reset-token
extensions, and business-link fields with their actual nullability and status values. The
schema-verification inventory was updated for the new Company-scoped constraints and reset-token
columns, but schema verification was not run.

### Session and authentication review

Company is resolved from the hostname before Company-account lookup. User ID and profile metadata
come from the authenticated session; portal requests do not accept a browser-supplied profile ID.
Session loading now joins the bound link and requires that exact Company, Account, profile type,
profile ID, and active link. A suspended or revoked bound link therefore invalidates the session
even if the session row was not updated.

Account kind determines the active workspace. A `driver` Account with both Employee and Driver
links resolves only its Driver link and mounts the Driver portal. A `company_user` mounts the
permission-controlled Company workspace. There is no profile switching. This prevents privilege
merging, but also exposes the administration gap described below.

UAE mobile normalization accepts `0506468441`, `506468441`, `971506468441`,
`+971506468441`, spaces, parentheses, dots, and hyphens and produces `9715XXXXXXXX`.
Username, email, and normalized mobile lookup share the same generic invalid-credentials response,
password verification, failed-attempt counter, lock state, and Company-host scope. No full mobile
number is written by the reviewed authentication source.

### Portal endpoint inventory and scope

The Driver portal exposes:

- `GET /portal/driver/orders`
- `PATCH /portal/driver/orders/:orderId/status`

The Trader portal exposes:

- `GET /portal/trader/orders`

Driver list SQL requires the authenticated Company, active bound Driver, and
`orders.assigned_driver_id`. Driver mutation pre-check and the transactionally locked Order query
now use the same assigned-Driver predicate, closing the previous assignment race. Driver transitions
remain limited to assigned → out for delivery and out for delivery → delivered/returned to branch.
Trader list SQL requires the authenticated Company, active bound Trader, and `orders.trader_id`, and
is read-only. No shared portal detail, bulk, reassignment, settlement, Accounting, report,
configuration, or administration route was found.

`App.tsx` mounts `PortalWorkspace` only for Driver and Trader account kinds; those identities cannot
mount `CompanyWorkspace` through a direct URL. Portal navigation contains Orders, My Profile,
Change Password, and Sign Out only. Statuses are localized, and Order/mobile values are isolated
with bidirectional text markup for RTL readability.

### Permissions and password management

All business-access administration routes require `company_user` plus `users_roles.manage`.
Frontend configuration routes use the same permission, so actions are not shown to a Company User
without it. No permission key or role grant was added. This broad permission is acceptable as a
temporary compatibility choice, but a future least-privilege split is recommended.

Administrator reset, one-time temporary-password display, forced change, unlock, User-wide session
revocation, and self-service password change reuse the existing User Administration and
Authentication services. Login and password-change inputs remain masked. Passwords and session
tokens are not included in access-link audit metadata. Forgot Password delivery remains deferred,
and the UI does not advertise it.

### Legacy synchronization readiness

The preview uses only same-Company direct immutable relationships:
`employees.company_user_id`, `drivers.account_id`, and `traders.account_id`. It does not infer by
name, email, username, or mobile, and it is not run at startup.

The synchronization source is now account-kind-aware, bounded, selected, atomic, and idempotent.
It rejects stale previews and returns per-candidate results. Existing legacy fields are preserved.
It remains **not runtime validated and must not be executed** until the required repeat source and
controlled environment review is complete.

### Audit review

Create-and-link, existing-account linking, lifecycle transitions, profile-session revocation,
legacy preview, each candidate classification, synchronization start/completion/block/rollback,
and idempotent replay have bounded audit writes. Blocked source-link operations use a separate safe
audit transaction so the denial record can survive rollback without replacing the original
business error. Passwords, reset tokens, and session tokens are excluded.

Trigger-driven suspension remains observable through link state and version but has no authenticated
actor or correlation context with which to write a complete application audit event. Blocked
Driver list and Trader list profile-resolution attempts also remain limited by their current helper
signatures; the existing Driver mutation denial is audited. These limitations are documented rather
than represented as complete.

### Defects and corrections

Corrected in this review:

- **Critical:** duplicate creation and destructive rollback of the existing reset-token table.
- **High:** active session loading did not revalidate the bound link status.
- **High:** Driver status mutation had a pre-check/transaction race around Driver assignment.
- **High:** link and restore operations could accept inactive business records or disabled Users.
- **Medium:** session and lifecycle actor foreign keys were not Company-scoped.
- **Medium:** database typing and schema declarations omitted new fields and constraints.
- **Low:** portal status text and RTL handling exposed raw values or ambiguous directionality.

Blockers resolved by the account-kind-aware follow-up:

- **Resolved:** account-kind-aware creation, filtering, viewing, and source-owned linking.
- **Resolved:** atomic, bounded, idempotent selected legacy synchronization with stale-preview
  detection and classified output.
- **Resolved:** stable translation of identifier and link uniqueness conflicts.
- **Medium:** audit coverage is incomplete for denied access and trigger-driven suspension.
- **Resolved:** source selectors use backend-filtered eligible identities.

### Recommended controlled runtime sequence

1. Repeat source review of the account-kind-aware and synchronization changes.
2. Back up the target database and rehearse rollback on a disposable copy.
3. Run migration validation, schema verification, and constraint inventory in a non-production
   environment.
4. Inspect legacy preview counts and every conflict without synchronizing.
5. Execute the corrected, idempotent synchronization in a transaction and reconcile its audit.
6. Revoke/reissue pre-migration Driver and Trader sessions.
7. Test username, email, and every supported mobile format with generic failure behavior.
8. Test suspended/revoked links, User lock/disable, and selective versus global revocation.
9. Test cross-Company, cross-Driver, cross-Trader, unassigned Order, direct URL, and indirect API
   denial.
10. Test English, Arabic, RTL, temporary-password, forced-change, and sign-out behavior.

Final development status: **SOURCE IMPLEMENTED; RUNTIME VALIDATION NOT PERFORMED**.
